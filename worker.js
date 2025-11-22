// =================================================================================
//  项目: midgenai-2api (Cloudflare Worker 单文件版)
//  版本: 1.0.0 (代号: Chimera Synthesis - Midgen)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-23
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker。它将 midgenai.com
//  的图像生成服务，无损地转换为一个高性能、兼容 OpenAI 标准的 API。
//  内置"开发者驾驶舱"Web UI，支持参数调整和实时生成预览。
//
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "midgenai-2api",
  PROJECT_VERSION: "1.0.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_URL: "https://www.midgenai.com/api/image-generate",
  ORIGIN_URL: "https://www.midgenai.com",
  REFERER_URL: "https://www.midgenai.com/text-to-image",
  
  // 模型列表
  MODELS: [
    "midgen-v1",
    "midgen-flux",
    "midgen-turbo"
  ],
  DEFAULT_MODEL: "midgen-v1",

  // 默认生成参数
  DEFAULT_STEPS: 100, // 默认最高质量
  DEFAULT_ASPECT_RATIO: "1:1"
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    // 优先读取环境变量中的密钥
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);

    // 1. 预检请求
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') {
      return handleUI(request, apiKey);
    } 
    // 3. API 路由
    else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request, apiKey);
    } 
    // 4. 404
    else {
      return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
    }
  }
};

// --- [第三部分: API 代理逻辑] ---

/**
 * API 路由分发
 */
async function handleApi(request, apiKey) {
  // 鉴权
  const authHeader = request.headers.get('Authorization');
  if (apiKey && apiKey !== "1") {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== apiKey) {
      return createErrorResponse('无效的 API Key。', 403, 'invalid_api_key');
    }
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else if (url.pathname === '/v1/images/generations') {
    return handleImageGenerations(request, requestId);
  } else {
    return createErrorResponse(`不支持的 API 路径: ${url.pathname}`, 404, 'not_found');
  }
}

/**
 * 处理 /v1/models
 */
function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'midgenai-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

/**
 * 核心：执行上游图像生成请求
 */
async function performGeneration(prompt, aspectRatio, steps, seed) {
  const payload = {
    prompt: prompt,
    negative_prompt: "", // 暂不支持负向提示词自定义，保持简单
    aspect_ratio: aspectRatio || CONFIG.DEFAULT_ASPECT_RATIO,
    steps: steps || CONFIG.DEFAULT_STEPS,
    seed: seed || 0
  };

  const headers = {
    "Content-Type": "application/json",
    "Origin": CONFIG.ORIGIN_URL,
    "Referer": CONFIG.REFERER_URL,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // 模拟必要的头部，虽然是匿名，但带上更像浏览器
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Priority": "u=1, i"
  };

  const response = await fetch(CONFIG.UPSTREAM_URL, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`上游服务错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  
  // 检查是否被拦截或生成失败
  if (data.blocked) {
    throw new Error(`内容被拦截: ${data.error}`);
  }
  if (!data.image) {
    throw new Error("上游未返回图像数据");
  }

  return data.image; // 返回 Base64 字符串 (不带前缀)
}

/**
 * 辅助：解析 OpenAI size 到 Midgen aspect_ratio
 */
function mapSizeToAspectRatio(size) {
  if (!size) return "1:1";
  if (size === "1024x1024") return "1:1";
  if (size === "1024x1792") return "9:16"; // 竖屏
  if (size === "1792x1024") return "16:9"; // 横屏
  // 简单启发式
  const [w, h] = size.split('x').map(Number);
  if (w > h) return "16:9";
  if (h > w) return "9:16";
  return "1:1";
}

/**
 * 处理 /v1/chat/completions (适配聊天客户端)
 */
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    if (!lastMsg) throw new Error("未找到用户消息");

    const prompt = lastMsg.content;
    // 尝试从 prompt 中解析 JSON 配置 (高级用法)
    let aspectRatio = "1:1";
    let steps = CONFIG.DEFAULT_STEPS;
    let cleanPrompt = prompt;

    // 简单的参数提取逻辑，如果用户输入 "画一只猫 --ar 16:9"
    if (prompt.includes("--ar 16:9")) { aspectRatio = "16:9"; cleanPrompt = prompt.replace("--ar 16:9", ""); }
    else if (prompt.includes("--ar 9:16")) { aspectRatio = "9:16"; cleanPrompt = prompt.replace("--ar 9:16", ""); }
    
    const imageBase64 = await performGeneration(cleanPrompt, aspectRatio, steps, 0);
    
    // 构造 Markdown 图片响应
    const markdownImage = `![Generated Image](data:image/jpeg;base64,${imageBase64})`;
    
    // 模拟流式响应 (为了兼容性，虽然是一次性生成)
    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        const chunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model || CONFIG.DEFAULT_MODEL,
          choices: [{ index: 0, delta: { content: markdownImage }, finish_reason: null }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        
        const endChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model || CONFIG.DEFAULT_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      })();

      return new Response(readable, {
        headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
      });
    } else {
      // 非流式
      return new Response(JSON.stringify({
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || CONFIG.DEFAULT_MODEL,
        choices: [{
          index: 0,
          message: { role: "assistant", content: markdownImage },
          finish_reason: "stop"
        }]
      }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'generation_failed');
  }
}

/**
 * 处理 /v1/images/generations (标准绘图接口)
 */
async function handleImageGenerations(request, requestId) {
  try {
    const body = await request.json();
    const prompt = body.prompt;
    const size = body.size || "1024x1024";
    const aspectRatio = mapSizeToAspectRatio(size);
    
    const imageBase64 = await performGeneration(prompt, aspectRatio, CONFIG.DEFAULT_STEPS, 0);
    
    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: imageBase64 }] // 返回 Base64 JSON
    }), {
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'generation_failed');
  }
}

// --- 辅助函数 ---
function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
      
      .box { background: #252525; padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #888; margin-bottom: 5px; display: block; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 8px; border-radius: 4px; cursor: pointer; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 80%; padding: 10px 15px; border-radius: 8px; line-height: 1.5; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; }
      .msg.ai img { max-width: 100%; border-radius: 4px; margin-top: 10px; display: block; }
      
      .status-bar { margin-top: 10px; font-size: 12px; color: #888; display: flex; justify-content: space-between; }
      .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #888; border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; margin-right: 5px; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0">🎨 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label">比例 (Aspect Ratio)</span>
            <select id="ratio">
                <option value="1:1">1:1 (方形)</option>
                <option value="16:9">16:9 (横屏)</option>
                <option value="9:16">9:16 (竖屏)</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
            </select>

            <span class="label">步数 (Steps - 质量)</span>
            <input type="range" id="steps" min="10" max="100" value="100" oninput="document.getElementById('steps-val').innerText=this.value">
            <div style="text-align:right; font-size:12px; color:#888" id="steps-val">100</div>

            <span class="label" style="margin-top:10px">提示词</span>
            <textarea id="prompt" rows="4" placeholder="描述你想生成的图片..."></textarea>
            
            <button id="btn-gen" onclick="generate()">生成图片</button>
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:50px;">
                MidgenAI 代理服务就绪。<br>
                支持 API 调用或直接在此测试。
            </div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/images/generations";
        
        function copy(text) {
            navigator.clipboard.writeText(text);
            alert('已复制');
        }

        function appendMsg(role, html) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerHTML = html;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function generate() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return alert('请输入提示词');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 生成中...';

            // 清空欢迎语
            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const loadingMsg = appendMsg('ai', '<span class="spinner"></span> 正在请求 MidgenAI 生成图片 (约5-10秒)...');

            try {
                // 映射比例到 OpenAI size
                const ratio = document.getElementById('ratio').value;
                let size = "1024x1024";
                if (ratio === "16:9") size = "1792x1024";
                if (ratio === "9:16") size = "1024x1792";

                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        prompt: prompt,
                        size: size,
                        n: 1
                    })
                });

                const data = await res.json();
                
                if (!res.ok) throw new Error(data.error?.message || '生成失败');

                const b64 = data.data[0].b64_json;
                loadingMsg.innerHTML = \`
                    <div><strong>生成成功</strong> <span style="font-size:12px;color:#888">(\${ratio})</span></div>
                    <img src="data:image/jpeg;base64,\${b64}" alt="Generated Image">
                    <div class="status-bar">
                        <a href="data:image/jpeg;base64,\${b64}" download="midgen-\${Date.now()}.jpg" style="color:var(--primary)">下载图片</a>
                    </div>
                \`;

            } catch (e) {
                loadingMsg.innerHTML = \`<span style="color:#CF6679">❌ 错误: \${e.message}</span>\`;
            } finally {
                btn.disabled = false;
                btn.innerText = "生成图片";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Encoding': 'br' // 声明支持 Brotli，虽然 Worker 实际上是自动处理压缩的
    },
  });
}
