'use strict'

/**
 * 前缀，如果自定义路由为example.com/gh/*，将PREFIX改为 '/gh/'，注意，少一个杠都会错！
 */
const PREFIX = '/'
// 分支文件使用jsDelivr镜像的开关，0为关闭，默认关闭
const Config = {
    jsdelivr: 0
}

const whiteList = [] // 白名单，路径里面有包含字符的才会通过，e.g. ['/username/']

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
}

// 正则表达式（仅匹配完整 URL 格式，包含 https://）
const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i
const exp7 = /^(?:https?:\/\/)?api\.github\.com\/.*$/i // GitHub API
const exp8 = /^(?:https?:\/\/)?(.+?)\.github\.io\/api\/.*$/i // GitHub Pages API

addEventListener('fetch', e => {
    const ret = fetchHandler(e)
        .catch(err => new Response(JSON.stringify({ error: 'cfworker error', details: err.stack }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
        }))
    e.respondWith(ret)
})

function checkUrl(u) {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6, exp7, exp8]) {
        if (u.search(i) === 0) {
            return true
        }
    }
    return false
}

/**
 * @param {FetchEvent} e
 */
async function fetchHandler(e) {
    const req = e.request
    const urlStr = req.url
    const urlObj = new URL(urlStr)
    let path = urlObj.searchParams.get('q')
    
    // 处理查询参数模式（?q=xxx）：仅支持完整 URL
    if (path) {
        // 检查查询参数是否是完整 URL，否则返回 400
        if (!path.startsWith('http://') && !path.startsWith('https://')) {
            return new Response(JSON.stringify({ error: 'Invalid URL', message: '查询参数必须是完整的 GitHub 资源 URL（包含 http:// 或 https://）' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
            })
        }
        // 重定向到完整 URL 代理格式
        return Response.redirect(urlObj.origin + PREFIX + path, 301)
    }
    
    // 关键修改：仅解析完整 URL 格式（必须包含 http:// 或 https://）
    path = urlObj.pathname.slice(PREFIX.length)
    path = path.replace(/^\/+/, '') // 移除开头可能的斜杠
    
    // 路径为空（访问根目录）：返回简单JSON
    if (!path) {
        return new Response(JSON.stringify({ message: 'GitHub Proxy Worker - 请提供有效的 GitHub URL' }), {
            headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
        })
    }
    
    // 核心校验：仅允许完整 URL 格式
    if (!path.startsWith('http://') && !path.startsWith('https://')) {
        return new Response(JSON.stringify({ error: 'Invalid format', message: '仅支持完整 URL 拼接格式，例如：https://你的域名/https://github.com/...' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
        })
    }
    
    // 校验是否是 GitHub 相关 URL
    if (!checkUrl(path)) {
        return new Response(JSON.stringify({ error: 'Not supported', message: '仅支持 GitHub 相关资源（仓库文件、API、Raw 文件、Gist 等）' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
        })
    }
    
    // 匹配对应规则并代理
    if (path.search(exp7) === 0 || path.search(exp8) === 0) {
        return httpHandler(req, path, true)
    } else if (path.search(exp1) === 0 || path.search(exp5) === 0 || path.search(exp6) === 0 || path.search(exp3) === 0) {
        return httpHandler(req, path)
    } else if (path.search(exp2) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            path = path.replace('/blob/', '/raw/')
            return httpHandler(req, path)
        }
    } else if (path.search(exp4) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            return httpHandler(req, path)
        }
    } else {
        return new Response(JSON.stringify({ error: 'Not supported', message: '不支持的资源' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
        })
    }
}

/**
 * @param {Request} req
 * @param {string} pathname 完整的目标 URL（如 https://github.com/...）
 * @param {boolean} isApi 是否为 API 请求
 */
function httpHandler(req, pathname, isApi = false) {
    const reqHdrRaw = req.headers

    // preflight
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    const reqHdrNew = new Headers(reqHdrRaw)

    let urlStr = pathname
    let flag = !Boolean(whiteList.length)
    
    // 白名单检查（基于完整 URL）
    for (let i of whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }
    if (!flag) {
        return new Response(JSON.stringify({ error: 'Access denied', message: '你访问的路径不在白名单中' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
        })
    }

    // 验证 URL 有效性
    const urlObj = new URL(urlStr)
    if (!urlObj) {
        return new Response(JSON.stringify({ error: 'Invalid URL', message: '你输入的 GitHub 地址格式不正确' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
        })
    }

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'manual',
        body: req.body
    }

    // API 请求特殊处理：添加必要的头部，避免 GitHub API 403 错误
    if (isApi) {
        // 避免发送 cf-worker 的默认 User-Agent，GitHub API 可能拒绝
        if (!reqHdrNew.has('User-Agent')) {
            reqHdrNew.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36')
        }
        // 移除可能导致问题的头部
        reqHdrNew.delete('Host')
    }

    return proxy(urlObj, reqInit, isApi)
}

/**
 * @param {URL} urlObj
 * @param {RequestInit} reqInit
 * @param {boolean} isApi 是否为 API 请求
 */
async function proxy(urlObj, reqInit, isApi = false) {
    try {
        const res = await fetch(urlObj.href, reqInit)
        const resHdrOld = res.headers
        const resHdrNew = new Headers(resHdrOld)

        const status = res.status

        // 处理重定向：确保重定向后的 URL 也通过代理（完整格式）
        if (resHdrNew.has('location')) {
            let _location = resHdrNew.get('location')
            if (checkUrl(_location)) {
                resHdrNew.set('location', urlObj.origin + PREFIX + _location)
            } else {
                // 如果是 API 重定向，继续跟随
                if (isApi && _location.startsWith('https://api.github.com/')) {
                    reqInit.redirect = 'follow'
                    return proxy(new URL(_location), reqInit, isApi)
                }
                resHdrNew.set('location', _location)
            }
        }

        // 允许跨域访问
        resHdrNew.set('access-control-expose-headers', '*')
        resHdrNew.set('access-control-allow-origin', '*')

        // 移除可能限制资源使用的头部
        resHdrNew.delete('content-security-policy')
        resHdrNew.delete('content-security-policy-report-only')
        resHdrNew.delete('clear-site-data')
        resHdrNew.delete('x-frame-options') // 允许嵌入 iframe（可选）

        // API 响应特殊处理：保留必要的头部
        if (isApi) {
            // 保留 GitHub API 的速率限制头部
            const rateLimitHeaders = [
                'x-ratelimit-limit',
                'x-ratelimit-remaining',
                'x-ratelimit-reset',
                'x-ratelimit-used',
                'x-github-media-type'
            ]
            rateLimitHeaders.forEach(header => {
                if (resHdrOld.has(header)) {
                    resHdrNew.set(header, resHdrOld.get(header))
                }
            })
        }

        return new Response(res.body, {
            status,
            headers: resHdrNew,
        })
    } catch (err) {
        // API 请求错误处理
        if (isApi) {
            return new Response(JSON.stringify({ error: 'API proxy error', message: `GitHub API 访问失败：${err.message}` }), {
                status: 503,
                headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
            })
        }
        return new Response(JSON.stringify({ error: 'Proxy error', message: `请求失败：${err.message}` }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' }
        })
    }
}



