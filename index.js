'use strict'

/**
 * static files (404.html, sw.js, conf.js)
 */
const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/'
// 前缀，如果自定义路由为example.com/gh/*，将PREFIX改为 '/gh/'，注意，少一个杠都会错！
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

// 原有正则表达式
const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i
// 新增：GitHub API 正则匹配（支持 api.github.com 和 github.io 的 API 路径）
const exp7 = /^(?:https?:\/\/)?api\.github\.com\/.*$/i
const exp8 = /^(?:https?:\/\/)?(.+?)\.github\.io\/api\/.*$/i // 支持 GitHub Pages 上的 API

/**
 * @param {any} body
 * @param {number} status
 * @param {Object<string, string>} headers
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, { status, headers })
}

/**
 * @param {string} urlStr
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch (err) {
        return null
    }
}

addEventListener('fetch', e => {
    const ret = fetchHandler(e)
        .catch(err => makeRes('cfworker error:\n' + err.stack, 502))
    e.respondWith(ret)
})

// 完善 URL 检查函数，加入 API 路径支持
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
    
    if (path) {
        return Response.redirect('https://' + urlObj.host + PREFIX + path, 301)
    }
    
    // cfworker 会把路径中的 `//` 合并成 `/`
    path = urlObj.href.slice(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://')
    
    // 处理 API 路径
    if (path.search(exp7) === 0 || path.search(exp8) === 0) {
        return httpHandler(req, path, true) // 第三个参数标记为 API 请求
    } 
    // 原有路径处理逻辑
    else if (path.search(exp1) === 0 || path.search(exp5) === 0 || path.search(exp6) === 0 || path.search(exp3) === 0) {
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
        }
        else {
            return httpHandler(req, path)
        }
    } else {
        return fetch(ASSET_URL + path)
    }
}

/**
 * @param {Request} req
 * @param {string} pathname
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
    
    // 白名单检查
    for (let i of whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }
    if (!flag) {
        return new Response("blocked", { status: 403 })
    }

    // 补全协议头
    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }
    
    const urlObj = newUrl(urlStr)
    if (!urlObj) {
        return makeRes('Invalid URL', 400)
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

        // 处理重定向
        if (resHdrNew.has('location')) {
            let _location = resHdrNew.get('location')
            if (checkUrl(_location)) {
                resHdrNew.set('location', PREFIX + _location)
            } else {
                // 如果是 API 重定向，继续跟随
                if (isApi && _location.startsWith('https://api.github.com/')) {
                    reqInit.redirect = 'follow'
                    return proxy(newUrl(_location), reqInit, isApi)
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
            return makeRes(`GitHub API Proxy Error: ${err.message}`, 503)
        }
        throw err
    }
}
