// xAI API 配置
const XAI_API_HOST = 'api.x.ai';
const IMAGE_GENERATION_PATH = '/v1/images/generations';
// 支持的图像生成参数 (根据 xAI 文档)
const SUPPORTED_IMAGE_PARAMS: string[] = [
    'model',
    'prompt',
    'n',
    'response_format'
];
// 注意: 'quality', 'size', 'style' 目前 xAI API 明确不支持
// --- CORS 响应头 ---
// 预检请求 (OPTIONS) 的响应头
const PREFLIGHT_CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*', // 或更严格的源
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400', // 24 hours
};
// 实际请求成功后的 CORS 响应头
const SUCCESS_CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*', // 保持与预检一致
    // 注意: 通常不需要在实际响应中重复 Allow-Methods/Headers/Max-Age
};
/**
* 处理 CORS 预检请求 (OPTIONS)
* @returns {Response} 标准的 Response 对象
*/
function handleCorsPreflight(): Response {
    return new Response(null, {
        status: 204, // No Content
        headers: PREFLIGHT_CORS_HEADERS,
    });
}
/**
* 向响应添加 CORS 头
* @param {Headers} headers - 要修改的 Headers 对象
*/
function addCorsHeaders(headers: Headers): void {
    for (const [key, value] of Object.entries(SUCCESS_CORS_HEADERS)) {
        headers.set(key, value);
    }
}
/**
* 处理图像生成请求，过滤参数并转发
* @param {Request} request - 原始入站请求
* @param {URL} targetUrl - 目标 xAI API URL
* @returns {Promise<Response>} 标准的 Response 对象
*/
async function handleImageGenerationRequest(request: Request, targetUrl: URL): Promise<Response> {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        addCorsHeaders(headers); // 也为错误响应添加 CORS
        return new Response(
            JSON.stringify({ error: 'Unsupported Content-Type. Please use application/json' }),
            { status: 400, headers }
        );
    }
    let originalBody: any;
    try {
        // 克隆请求以安全地读取 body
        const clonedRequest = request.clone();
        originalBody = await clonedRequest.json();
    } catch (e) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        addCorsHeaders(headers); // 也为错误响应添加 CORS
        return new Response(
            JSON.stringify({ error: 'Invalid JSON body' }),
            { status: 400, headers }
        );
    }
    // 过滤不支持的参数
    const filteredBody: Record<string, any> = {};
    for (const param of SUPPORTED_IMAGE_PARAMS) {
        if (originalBody[param] !== undefined) {
            filteredBody[param] = originalBody[param];
        }
    }
    // 创建新的请求到 xAI API
    const xaiRequestHeaders = new Headers({
        'Content-Type': 'application/json',
        // !! 重要: 确保从原始请求中传递认证信息 !!
        'Authorization': request.headers.get('Authorization') || '',
        // 可以考虑传递其他相关头部，例如 User-Agent，但要谨慎
    });
    const xaiRequest = new Request(targetUrl.toString(), {
        method: 'POST',
        headers: xaiRequestHeaders,
        body: JSON.stringify(filteredBody),
    });
    try {
        // 转发请求到 xAI API
        const xaiResponse = await fetch(xaiRequest);
        // 构建返回给客户端的响应，并添加 CORS 头
        // 克隆 xAI 的响应头，然后添加/覆盖 CORS 头
        const responseHeaders = new Headers(xaiResponse.headers);
        addCorsHeaders(responseHeaders);
        // 确保 Content-Type 正确 (xAI 应该是 application/json)
        responseHeaders.set('Content-Type', 'application/json');
        // 直接将 xAI 的响应体流式传输回去，效率更高
        return new Response(xaiResponse.body, {
            status: xaiResponse.status,
            statusText: xaiResponse.statusText,
            headers: responseHeaders,
        });
    } catch (error: any) {
        console.error("Error fetching from xAI API:", error);
        const headers = new Headers({ 'Content-Type': 'application/json' });
        addCorsHeaders(headers);
        return new Response(
            JSON.stringify({ error: `Error fetching from xAI API: ${error.message}` }),
            { status: 502, headers } // 502 Bad Gateway is appropriate here
        );
    }
}
/**
* 主处理函数，接收标准 Request 并返回标准 Response
* @param {Request} request - 入站请求对象
* @returns {Promise<Response>} 标准的响应对象
*/
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
        return handleCorsPreflight();
    }
    try {
        // 只代理 /v1/ 开头的路径
        if (!url.pathname.startsWith('/v1/')) {
            const headers = new Headers({ 'Content-Type': 'text/plain' });
            addCorsHeaders(headers);
            return new Response('Not Found', { status: 404, headers });
        }
        // 构建目标 xAI API URL
        const targetUrl = new URL(`https://${XAI_API_HOST}${url.pathname}`);
        // 复制查询参数
        url.searchParams.forEach((value, key) => {
            targetUrl.searchParams.append(key, value);
        });
        // 特殊处理图像生成请求
        if (url.pathname === IMAGE_GENERATION_PATH && request.method === 'POST') {
            return await handleImageGenerationRequest(request, targetUrl);
        }
        // --- 处理其他通用 API 请求 (代理) ---
        // 复制请求头，特别是 Authorization
        const xaiRequestHeaders = new Headers(request.headers);
        // !! 确保 Host 头部被设置为目标 API 的 Host !!
        xaiRequestHeaders.set('Host', XAI_API_HOST);
        // 清除一些不应转发的头部 (可选，但推荐)
        xaiRequestHeaders.delete('cf-connecting-ip'); // Cloudflare specific
        xaiRequestHeaders.delete('cf-ipcountry');
        xaiRequestHeaders.delete('cf-ray');
        xaiRequestHeaders.delete('cf-visitor');
        // etc.
        // 创建转发请求 (需要克隆 body 如果有的话)
        // 注意: GET/HEAD 请求没有 body
        const body = (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined;
        const xaiRequest = new Request(targetUrl.toString(), {
            method: request.method,
            headers: xaiRequestHeaders,
            body: body,
        });
        // 转发请求到 xAI API
        const xaiResponse = await fetch(xaiRequest);
        // 构建返回给客户端的响应，并添加 CORS 头
        const responseHeaders = new Headers(xaiResponse.headers);
        addCorsHeaders(responseHeaders);
        // 返回响应 (流式传输)
        return new Response(xaiResponse.body, {
            status: xaiResponse.status,
            statusText: xaiResponse.statusText,
            headers: responseHeaders,
        });
    } catch (error: any) {
        console.error("Proxy error:", error);
        const headers = new Headers({ 'Content-Type': 'application/json' });
        addCorsHeaders(headers); // 也为错误响应添加 CORS
        return new Response(
            JSON.stringify({ error: `Internal Server Error: ${error.message}` }),
            { status: 500, headers }
        );
    }
}

// Deno.serve 用于启动服务器 - Deno 特有的API
Deno.serve(handleRequest);
