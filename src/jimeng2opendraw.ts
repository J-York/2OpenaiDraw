// 目标 API 配置
const TARGET_API_HOST = 'sejktjafstpl.us-east-1.clawcloudrun.com';
const IMAGE_GENERATION_PATH = '/v1/images/generations';

// 支持的图像生成参数 (根据 demo.jyork.top API 文档)
const SUPPORTED_IMAGE_PARAMS: string[] = [
    'model',       // jimeng-3.0（默认） / jimeng-2.1 / jimeng-2.0-pro / jimeng-2.0 / jimeng-1.4 / jimeng-xl-pro
    'prompt',      // 提示词，必填
    'negativePrompt', // 反向提示词，默认空字符串
    'width',       // 图像宽度，默认1024
    'height',      // 图像高度，默认1024
    'sample_strength' // 精细度，取值范围0-1，默认0.5
];

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
* @param {URL} targetUrl - 目标 API URL
* @returns {Promise<Response>} 标准的 Response 对象
*/
async function handleImageGenerationRequest(request: Request, targetUrl: URL): Promise<Response> {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        addCorsHeaders(headers);
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
        addCorsHeaders(headers);
        return new Response(
            JSON.stringify({ error: 'Invalid JSON body' }),
            { status: 400, headers }
        );
    }

    // 检查必填参数
    if (!originalBody.prompt) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        addCorsHeaders(headers);
        return new Response(
            JSON.stringify({ error: 'Missing required parameter: prompt' }),
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

    // 添加默认值（如果未提供）
    if (!filteredBody.model) filteredBody.model = 'jimeng-3.0';
    if (!filteredBody.negativePrompt) filteredBody.negativePrompt = '';
    if (!filteredBody.width) filteredBody.width = 1024;
    if (!filteredBody.height) filteredBody.height = 1024;
    if (filteredBody.sample_strength === undefined) filteredBody.sample_strength = 0.5;

    // 创建新的请求到目标 API
    const apiRequestHeaders = new Headers({
        'Content-Type': 'application/json',
        // 传递认证信息（如果有）
        'Authorization': request.headers.get('Authorization') || '',
    });

    const apiRequest = new Request(targetUrl.toString(), {
        method: 'POST',
        headers: apiRequestHeaders,
        body: JSON.stringify(filteredBody),
    });

    try {
        // 转发请求到目标 API
        const apiResponse = await fetch(apiRequest);
        
        // 构建返回给客户端的响应，并添加 CORS 头
        const responseHeaders = new Headers(apiResponse.headers);
        addCorsHeaders(responseHeaders);
        // 确保 Content-Type 正确
        responseHeaders.set('Content-Type', 'application/json');
        
        // 返回响应
        return new Response(apiResponse.body, {
            status: apiResponse.status,
            statusText: apiResponse.statusText,
            headers: responseHeaders,
        });
    } catch (error: any) {
        console.error("Error fetching from API:", error);
        const headers = new Headers({ 'Content-Type': 'application/json' });
        addCorsHeaders(headers);
        return new Response(
            JSON.stringify({ error: `Error fetching from API: ${error.message}` }),
            { status: 502, headers }
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
        // 检查路径是否匹配图像生成 API 路径格式
        if (url.pathname === IMAGE_GENERATION_PATH && request.method === 'POST') {
            // 构建目标 API URL
            const targetUrl = new URL(`https://${TARGET_API_HOST}${url.pathname}`);
            
            // 复制查询参数
            url.searchParams.forEach((value, key) => {
                targetUrl.searchParams.append(key, value);
            });
            
            // 处理图像生成请求
            return await handleImageGenerationRequest(request, targetUrl);
        } else {
            // 不支持的路径或方法
            const headers = new Headers({ 'Content-Type': 'text/plain' });
            addCorsHeaders(headers);
            return new Response('Not Found', { status: 404, headers });
        }
    } catch (error: any) {
        console.error("Proxy error:", error);
        const headers = new Headers({ 'Content-Type': 'application/json' });
        addCorsHeaders(headers);
        return new Response(
            JSON.stringify({ error: `Internal Server Error: ${error.message}` }),
            { status: 500, headers }
        );
    }
}

// 使用 Deno.serve 启动服务
Deno.serve(handleRequest);
