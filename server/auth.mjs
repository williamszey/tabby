import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const derivePassword = promisify(scrypt)
const loginPath = '/api/tabby/login'
const registerPath = '/api/tabby/register'
const sessionPath = '/api/tabby/session'
const sessionDuration = 30 * 24 * 60 * 60 * 1000
const limitWindow = 60_000
const bodyLimit = 4096

function normalizeEmail (value) {
    if (typeof value !== 'string') {
        return null
    }
    const email = value.trim().toLowerCase()
    return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email) ? email : null
}

function validPassword (value, minimumLength) {
    return typeof value === 'string' && value.length >= minimumLength && value.length <= 256
}

function hashPassword (password, salt) {
    return derivePassword(password, Buffer.from(salt, 'hex'), 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
}

function accountPath (directory, email) {
    return join(directory, createHash('sha256').update(email).digest('hex') + '.json')
}

async function initializeAccount (directory, email, password) {
    const file = accountPath(directory, email)
    const id = randomBytes(32).toString('hex')
    const salt = randomBytes(16).toString('hex')
    const hash = (await hashPassword(password, salt)).toString('hex')
    const record = { version: 1, id, salt, hash }
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    try {
        await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
        await link(temporary, file)
    } finally {
        await rm(temporary, { force: true })
    }
    return id
}

async function loadAccount (directory, emailHash) {
    let contents
    try {
        contents = await readFile(join(directory, `${emailHash}.json`), 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null
        }
        throw error
    }
    const account = JSON.parse(contents)
    if (!account || account.version !== 1 || typeof account.id !== 'string' || !/^[a-f0-9]{64}$/.test(account.id) ||
        typeof account.salt !== 'string' || !/^[a-f0-9]{32}$/.test(account.salt) ||
        typeof account.hash !== 'string' || !/^[a-f0-9]{64}$/.test(account.hash)) {
        throw new Error('Invalid Tabby account file')
    }
    return account
}

async function readCredentials (request, registering) {
    const chunks = []
    let bytes = 0
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length
        if (bytes > bodyLimit) {
            break
        }
        chunks.push(chunk)
    }
    if (bytes > bodyLimit) {
        return { status: 413 }
    }
    try {
        const { email, password } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const normalized = normalizeEmail(email)
        if (normalized && validPassword(password, registering ? 12 : 1)) {
            return { email: normalized, password }
        }
    } catch { }
    return { status: 400 }
}

function signSession (key, data) {
    return createHmac('sha256', key).update(data).digest()
}

async function verifySession (key, directory, authorization) {
    const match = /^Bearer ([a-f0-9]{64})\.([a-f0-9]{64})\.(\d{13})\.([a-f0-9]{64})$/.exec(authorization ?? '')
    if (!match) return null
    const [, emailHash, id, expires, signature] = match
    if (Number(expires) <= Date.now() ||
        !timingSafeEqual(signSession(key, `${emailHash}.${id}.${expires}`), Buffer.from(signature, 'hex'))) return null
    const account = await loadAccount(directory, emailHash)
    return account?.id === id ? account : null
}

async function loadSessionKey (directory) {
    const file = join(directory, 'session.key')
    const key = await readFile(file).catch(async error => {
        if (error.code !== 'ENOENT') throw error
        const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
        try {
            await writeFile(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 })
            await link(temporary, file)
        } catch (writeError) {
            if (writeError.code !== 'EEXIST') throw writeError
        } finally {
            await rm(temporary, { force: true })
        }
        return readFile(file)
    })
    if (key.length !== 32) throw new Error('Invalid session key')
    return key
}

export function createAuthServer (directory, proxyIP, sessionKey = randomBytes(32)) {
    let verifying = false
    const unavailableSalt = randomBytes(16).toString('hex')
    const limits = new Map([
        [loginPath, { windowEnds: 0, total: 0, globalLimit: 90, ipLimit: 12, byIP: new Map() }],
        [registerPath, { windowEnds: 0, total: 0, globalLimit: 12, ipLimit: 3, byIP: new Map() }],
        [sessionPath, { windowEnds: 0, total: 0, globalLimit: 360, ipLimit: 60, byIP: new Map() }],
    ])
    const server = createServer({ headersTimeout: 5000, requestTimeout: 8000, connectionsCheckingInterval: 1000 }, async (request, response) => {
        const reply = status => response.writeHead(status, { 'Cache-Control': 'no-store' }).end()
        const authenticated = (status, id, emailHash) => {
            response.setHeader('X-Tabby-Account', id)
            if (emailHash && request.headers['x-topper-client'] === 'desktop') {
                const data = `${emailHash}.${id}.${Date.now() + sessionDuration}`
                response.setHeader('X-Topper-Session', `${data}.${signSession(sessionKey, data).toString('hex')}`)
            }
            return reply(status)
        }
        if (proxyIP && request.socket.remoteAddress !== proxyIP) {
            return reply(403)
        }
        const limit = limits.get(request.url)
        if (!limit) {
            return reply(404)
        }
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST')
            return reply(405)
        }
        if (request.url !== sessionPath && request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
            return reply(415)
        }
        if (Number(request.headers['content-length']) > bodyLimit) {
            response.setHeader('Connection', 'close')
            return reply(413)
        }

        const now = Date.now()
        const forwardedIP = request.headers['x-real-ip']
        // The listener is loopback-only. The reverse proxy overwrites this header.
        const ip = proxyIP && typeof forwardedIP === 'string' && isIP(forwardedIP) ? forwardedIP : request.socket.remoteAddress
        if (now >= limit.windowEnds) {
            limit.windowEnds = now + limitWindow
            limit.total = 0
            limit.byIP.clear()
        }
        const ipAttempts = limit.byIP.get(ip) ?? 0
        if (limit.total >= limit.globalLimit || ipAttempts >= limit.ipLimit) {
            response.setHeader('Retry-After', String(Math.max(1, Math.ceil((limit.windowEnds - Date.now()) / 1000))))
            return reply(429)
        }
        limit.total++
        limit.byIP.set(ip, ipAttempts + 1)

        try {
            if (request.url === sessionPath) {
                const account = await verifySession(sessionKey, directory, request.headers.authorization)
                return account ? authenticated(204, account.id) : reply(401)
            }
            const registering = request.url === registerPath
            const credentials = await readCredentials(request, registering)
            if (credentials.status) {
                if (credentials.status === 413) {
                    response.setHeader('Connection', 'close')
                }
                return reply(credentials.status)
            }
            if (verifying) {
                response.setHeader('Retry-After', '1')
                return reply(429)
            }
            verifying = true
            try {
                const { email, password } = credentials
                const emailHash = createHash('sha256').update(email).digest('hex')
                if (registering) {
                    try {
                        return authenticated(201, await initializeAccount(directory, email, password), emailHash)
                    } catch (error) {
                        if (error.code === 'EEXIST') {
                            return reply(409)
                        }
                        throw error
                    }
                }
                const account = await loadAccount(directory, emailHash)
                const hash = await hashPassword(password, account?.salt ?? unavailableSalt)
                if (account && timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) {
                    return authenticated(204, account.id, emailHash)
                }
                return reply(401)
            } finally {
                verifying = false
            }
        } catch {
            if (!response.destroyed) {
                return reply(500)
            }
        }
    })
    server.maxConnections = 128
    return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const directory = process.env.TABBY_AUTH_DATA_DIR ?? '/var/lib/tabby-auth'
    const host = process.env.TABBY_AUTH_HOST ?? '127.0.0.1'
    const port = Number(process.env.TABBY_AUTH_PORT ?? 18742)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    createAuthServer(directory, process.env.TABBY_AUTH_PROXY_IP, await loadSessionKey(directory)).listen(port, host, () => console.log(`Tabby auth listening on ${host}:${port}`))
}
