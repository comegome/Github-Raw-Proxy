// GitHub-Raw-Proxy —— 用 Cloudflare Workers 访问 GitHub 私有仓库的 raw 文件
//
//
// 设计要点（细节见 README）：
//   * 令牌只存在于环境变量 GH_TOKEN 里：不写进 URL、不回给调用方、不打日志。
//   * GH_NAME + GH_REPO 必填，缺失直接 500。请求路径一律拼在「用户名/仓库[/分支]」之后，
//     所以它不会退化成面向 raw.githubusercontent.com 的公开代理。
//   * 端点没有客户端鉴权：靠最小权限令牌 + 不公开地址收敛风险；要真正的访问控制，
//     请用 Cloudflare Access 挡在 Worker 前面。
//   * 只做取文件：GET / HEAD，并转发 Range / 条件请求（断点续传、缓存校验）。
//   * 全程无跨请求可变状态（旧实现把令牌放在模块作用域，会串请求）。
//   * 全流程 try/catch，意外错误只回「服务器内部错误」，错误类型名放在 x-raw-error 响应头。

const GITHUB_RAW = 'https://raw.githubusercontent.com';

// 只转发这几个与"取文件"相关、无副作用的请求头
const FORWARD_REQUEST_HEADERS = ['range', 'if-none-match', 'if-modified-since'];

// Response 不允许携带正文的状态码（传了 body 会抛 TypeError）
const NULL_BODY_STATUS = new Set([204, 205, 304]);

// 只做取文件这一件事
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

const NGINX_PAGE = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>

	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>

	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`;

export default {
	async fetch(request, env) {
		try {
			return await handleRequest(request, env);
		} catch (err) {
			// 细节只写日志；响应头里只放错误类型名，方便用 curl -I 快速定位
			console.error('cf-workers-raw:', (err && err.stack) || err);
			const errName = (err && err.name) || 'Error';
			return new Response('服务器内部错误', { status: 500, headers: { 'x-raw-error': errName } });
		}
	}
};

async function handleRequest(request, env) {
	// 这个 Worker 只做一件事：取文件。其它方法不给用。
	if (!ALLOWED_METHODS.has(request.method)) {
		return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
	}

	const url = new URL(request.url);

	// 首页：伪装页 / 跳转
	if (url.pathname === '/') return await serveHome(request, env);

	if (!env.GH_TOKEN) return new Response('服务器GitHub TOKEN配置错误', { status: 500 });

	// fail-closed：必须限定在「用户名/仓库」，缺了直接拒绝服务（只填空白/斜杠等同于没填）。
	if (!cleanSegment(env.GH_NAME) || !cleanSegment(env.GH_REPO)) {
		return new Response('服务器未配置 GH_NAME 或 GH_REPO', { status: 500 });
	}

	if (hasNestedTraversal(url.pathname)) return new Response('非法路径', { status: 400 });

	const headers = new Headers();
	for (const name of FORWARD_REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	// 唯一的凭据来源：Worker 的环境变量
	headers.set('Authorization', `token ${String(env.GH_TOKEN).trim()}`);

	// HEAD 原样传上去，让上游只回头部，不白下载整个文件
	const response = await fetch(buildUpstreamUrl(url, env), { method: request.method, headers });

	// 204 / 205 / 304 不允许带正文，必须传 null，否则 Response 构造抛 TypeError（会被 catch 成 500）。
	if (NULL_BODY_STATUS.has(response.status)) {
		return new Response(null, { status: response.status, headers: response.headers });
	}

	// 3xx 原样透传，关键是保住 Location。注意 fetch 默认 redirect:'follow'，301/302/303/307/308
	// 会被内部跟随掉，能走到这里的只剩 300/305/306 以及 Location 缺失或非法的 3xx。
	if (response.status >= 300 && response.status < 400) {
		return new Response(null, { status: response.status, headers: response.headers });
	}

	if (!response.ok) {
		return new Response(env.ERROR || '无法获取文件，检查路径或TOKEN是否正确。', { status: response.status });
	}
	return new Response(response.body, { status: response.status, headers: response.headers });
}

/**
 * 组装上游 URL：主机恒为 raw.githubusercontent.com，路径拼在「用户名/仓库[/分支]」之后。
 * GH_NAME / GH_REPO 已在 handleRequest 里确认非空。
 */
function buildUpstreamUrl(url, env) {
	let target = GITHUB_RAW + '/' + cleanSegment(env.GH_NAME) + '/' + cleanSegment(env.GH_REPO);
	const ghBranch = cleanSegment(env.GH_BRANCH);
	if (ghBranch) target += '/' + ghBranch;
	return target + url.pathname;
}

/**
 * 路径穿越防护：判断路径里是否藏了「解码之后才会露出来」的 `.` / `/` / `\`。
 *
 * 逐个解开单字节 %XX，而不是用 decodeURIComponent：后者遇到畸形 UTF-8（如 %E0%A4%A）会整串
 * 抛 URIError —— 放行会被同段的二重编码（%252e）掩护过去，拦截又会误杀 100%25.txt。
 * 只解单字节转义则互不干扰：畸形字节藏不住旁边的 %252e，而 %.t 会自然停止解码。
 * 解满 maxRounds 轮仍在变化 → 套娃过深，按 fail-closed 拦截。
 */
function hasNestedTraversal(pathname, maxRounds = 4) {
	let current = pathname;
	for (let round = 0; round < maxRounds; round++) {
		if (/%2e|%2f|%5c/i.test(current)) return true;
		// 只解单字节转义，解不动的（畸形/残缺）原样留着
		const next = current.replace(/%[0-9a-f]{2}/gi, (match) =>
			String.fromCharCode(parseInt(match.slice(1), 16))
		);
		if (next === current) return false;
		current = next;
	}
	// 解满 maxRounds 轮仍在变化：套娃层数异常深，fail-closed
	return true;
}

/** 环境变量是手填的，容忍首尾空白和多余的斜杠。 */
function cleanSegment(segment) {
	if (segment === undefined || segment === null) return '';
	return String(segment).trim().replace(/^\/+|\/+$/g, '');
}

async function serveHome(request, env) {
	const envKey = env.URL302 ? 'URL302' : (env.URL ? 'URL' : null);
	if (envKey) {
		// 刻意不转发调用方的请求头：伪装页不需要，也免得把 Cookie / Authorization 送给第三方。
		// method 照传，HEAD 探测就不用把整页下载一遍。
		const candidates = splitList(env[envKey]);
		if (!candidates.length) return new Response('服务器内部错误', { status: 500 });
		const picked = candidates[Math.floor(Math.random() * candidates.length)];
		return envKey === 'URL302'
			? Response.redirect(picked, 302)
			: await fetch(picked, { method: request.method });
	}
	// 首页伪装页
	return new Response(NGINX_PAGE, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
}

/** 把配置拆成地址列表：空白、竖线、引号都算分隔符，所以 URL 里不要出现 `|`。 */
function splitList(raw) {
	if (typeof raw !== 'string') return [];
	const normalized = raw
		.replace(/[\s|"']+/g, ',') // 空白、竖线、引号 → 逗号
		.replace(/,+/g, ',')       // 折叠连续逗号
		.replace(/^,|,$/g, '');    // 去掉首尾逗号
	return normalized ? normalized.split(',').filter((item) => item !== '') : [];
}
