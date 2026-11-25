import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { CheckoutGatewayError, createPayments, readPaymentConfig } from './payment.mjs'

const derivePassword = promisify(scrypt)
const loginPath = '/api/tabby/login'
const registerPath = '/api/tabby/register'
const sessionPath = '/api/tabby/session'
const syncPath = '/api/tabby/ssh-sync'
const accountPathname = '/api/tabby/account'
const checkoutPath = '/api/tabby/payment/checkout'
const notifyPath = '/api/tabby/payment/notify'
const checkoutStatusPath = '/api/tabby/payment/status'
const orderStatusPath = '/api/tabby/payment/order'
const webOrigin = 'https://www.topperapi.com'
const webCookie = '__Host-topper-account'
const trialDuration = 7 * 24 * 60 * 60 * 1000
const syncLimit = 1024 * 1024
const syncRecordLimit = 200
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
    const record = { version: 1, id, salt, hash, createdAt: Date.now() }
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    try {
        await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
        await link(temporary, file)
    } finally {
        await rm(temporary, { force: true })
    }
    return record
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

async function readJSON (request, limit) {
    const chunks = []
    let bytes = 0
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length
        if (bytes > limit) {
            break
        }
        chunks.push(chunk)
    }
    if (bytes > limit) {
        return { status: 413 }
    }
    try {
        return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
        return { status: 400 }
    }
}

async function readCredentials (request, registering) {
    const body = await readJSON(request, bodyLimit)
    if (body.status) return body
    if (body.value && typeof body.value === 'object') {
        const { email, password } = body.value
        const normalized = normalizeEmail(email)
        if (normalized && validPassword(password, registering ? 12 : 1)) {
            return { email: normalized, password }
        }
    }
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

function trialExpiration (account) {
    return Number.isSafeInteger(account.createdAt) ? account.createdAt + trialDuration : null
}

function validSyncRecords (records, size) {
    return Array.isArray(records) && records.length <= syncRecordLimit &&
        records.every(record => record && typeof record.id === 'string' && /^[^\u0000-\u001f]{1,256}$/.test(record.id) &&
            typeof record.encrypted === 'string' && record.encrypted.length >= 40 && record.encrypted.length <= size &&
            /^[A-Za-z0-9_-]+$/.test(record.encrypted)) &&
        new Set(records.map(record => record.id)).size === records.length
}

function validSyncUpdate (body) {
    return body && (body.revision === null || (typeof body.revision === 'string' && /^[a-f0-9]{32}$/.test(body.revision))) &&
        validSyncRecords(body.records === undefined ? [] : body.records, 4096) &&
        validSyncRecords(body.historyRecords === undefined ? [] : body.historyRecords, 32768) &&
        Boolean(body.records?.length || body.historyRecords?.length)
}

async function syncConnections (directory, account, request, response, syncWrites, entitlement) {
    const { expiresAt, plan } = entitlement
    const send = (status, body) => response.writeHead(status, {
        'Cache-Control': 'no-store', 'Content-Type': 'application/json',
    }).end(JSON.stringify(body))
    const available = () => expiresAt !== null && Date.now() < expiresAt
    const unavailable = () => send(403, { expiresAt })
    if (!available()) return unavailable()

    const historyMode = request.headers['x-topper-ssh-history']
    const includeHistory = historyMode === '1'
    const sendState = ({ revision, records, historyRecords = [] }) => send(200, {
        revision, records, expiresAt, plan, ...(includeHistory ? { historyRecords } : {}),
    })
    if (request.method === 'GET' && historyMode === 'status') {
        return sendState({ revision: null, records: [] })
    }

    const file = join(directory, `ssh-${account.id}.json`)
    const read = async () => {
        try {
            return JSON.parse(await readFile(file, 'utf8'))
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
            return { revision: null, records: [], historyRecords: [] }
        }
    }
    if (request.method === 'GET') {
        const state = await read()
        return available() ? sendState(state) : unavailable()
    }

    const body = await readJSON(request, syncLimit)
    if (body.status) {
        if (body.status === 413) response.setHeader('Connection', 'close')
        return send(body.status, {})
    }
    if (!validSyncUpdate(body.value)) return send(400, {})
    if (syncWrites.has(account.id)) return send(409, {})
    syncWrites.add(account.id)
    try {
        const current = await read()
        if (!available()) return unavailable()
        if (current.revision !== body.value.revision) return send(409, {})
        const records = new Map(current.records.map(record => [record.id, record]))
        for (const { id, encrypted } of body.value.records ?? []) records.set(id, { id, encrypted })
        if (records.size > syncRecordLimit) return send(413, {})
        const history = new Map((current.historyRecords ?? []).map(record => [record.id, record]))
        for (const { id, encrypted } of body.value.historyRecords ?? []) {
            if (!records.has(id)) return send(400, {})
            history.set(id, { id, encrypted })
        }
        const next = { revision: randomBytes(16).toString('hex'), records: [...records.values()], historyRecords: [...history.values()] }
        const temporary = `${file}.${next.revision}.tmp`
        try {
            await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
            if (!available()) return unavailable()
            await rename(temporary, file)
        } finally {
            await rm(temporary, { force: true })
        }
        return sendState(next)
    } finally {
        syncWrites.delete(account.id)
    }
}

export function createAuthServer (directory, proxyIP, sessionKey = randomBytes(32), paymentConfig = null) {
    let verifying = false
    const syncWrites = new Set()
    const payments = createPayments(directory, paymentConfig, webOrigin)
    const getEntitlement = async account => {
        const paid = await payments.readEntitlement(account.id)
        if (paid?.expiresAt > Date.now()) return { plan: 'paid', expiresAt: paid.expiresAt, planId: paid.planId }
        const trialEnd = trialExpiration(account)
        const expiresAt = paid?.expiresAt ?? trialEnd
        if (trialEnd && trialEnd > Date.now()) return { plan: 'trial', expiresAt: trialEnd }
        return { plan: expiresAt ? 'expired' : 'local', expiresAt, planId: paid?.planId }
    }
    const unavailableSalt = randomBytes(16).toString('hex')
    const limits = new Map([
        [loginPath, { windowEnds: 0, total: 0, globalLimit: 90, ipLimit: 12, byIP: new Map() }],
        [registerPath, { windowEnds: 0, total: 0, globalLimit: 12, ipLimit: 3, byIP: new Map() }],
        [sessionPath, { windowEnds: 0, total: 0, globalLimit: 360, ipLimit: 60, byIP: new Map() }],
        [syncPath, { windowEnds: 0, total: 0, globalLimit: 1800, ipLimit: 120, byIP: new Map() }],
        [accountPathname, { windowEnds: 0, total: 0, globalLimit: 360, ipLimit: 60, byIP: new Map() }],
        [checkoutPath, { windowEnds: 0, total: 0, globalLimit: 120, ipLimit: 10, byIP: new Map() }],
        [notifyPath, { windowEnds: 0, total: 0, globalLimit: 360, ipLimit: 120, byIP: new Map() }],
        [checkoutStatusPath, { windowEnds: 0, total: 0, globalLimit: 600, ipLimit: 60, byIP: new Map() }],
        [orderStatusPath, { windowEnds: 0, total: 0, globalLimit: 600, ipLimit: 60, byIP: new Map() }],
    ])
    const server = createServer({ headersTimeout: 5000, requestTimeout: 8000, connectionsCheckingInterval: 1000 }, async (request, response) => {
        const reply = status => response.writeHead(status, { 'Cache-Control': 'no-store' }).end()
        const json = (status, body) => response.writeHead(status, {
            'Cache-Control': 'no-store', 'Content-Type': 'application/json',
        }).end(JSON.stringify(body))
        const setWebSession = (value, age) => response.setHeader('Set-Cookie',
            `${webCookie}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`)
        const authenticated = (status, account, emailHash) => {
            response.setHeader('X-Tabby-Account', account.id)
            const expiresAt = trialExpiration(account)
            if (expiresAt !== null) response.setHeader('X-Topper-Sync-Expires', expiresAt)
            const desktop = request.headers['x-topper-client'] === 'desktop'
            if (emailHash && (desktop || request.headers.origin === webOrigin)) {
                const data = `${emailHash}.${account.id}.${Date.now() + sessionDuration}`
                const token = `${data}.${signSession(sessionKey, data).toString('hex')}`
                if (desktop) response.setHeader('X-Topper-Session', token)
                else setWebSession(token, sessionDuration / 1000)
            }
            return reply(status)
        }
        if (proxyIP && request.socket.remoteAddress !== proxyIP) {
            return reply(403)
        }
        const isNotification = request.url === notifyPath || request.url?.startsWith(notifyPath + '?')
        const orderStatus = request.url === orderStatusPath || request.url?.startsWith(orderStatusPath + '?')
        const endpoint = isNotification ? notifyPath : orderStatus ? orderStatusPath : request.url
        const limit = limits.get(endpoint)
        if (!limit) {
            return reply(404)
        }
        const sync = request.url === syncPath
        const webAccount = request.url === accountPathname
        const checkout = request.url === checkoutPath
        const checkoutStatus = endpoint === checkoutStatusPath
        const methods = sync ? ['GET', 'PUT'] : webAccount ? ['GET', 'DELETE'] :
            (isNotification || orderStatus || checkoutStatus) ? ['GET'] : ['POST']
        if (!methods.includes(request.method)) {
            response.setHeader('Allow', methods.join(', '))
            return reply(405)
        }
        if ((request.method === 'PUT' || (request.method === 'POST' && request.url !== sessionPath)) &&
            request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
            return reply(415)
        }
        if (Number(request.headers['content-length']) > (sync ? syncLimit : bodyLimit)) {
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
            if (checkoutStatus) return json(200, { available: !!paymentConfig })
            if (isNotification) {
                if (!paymentConfig) return reply(404)
                const query = new URL(request.url, webOrigin).searchParams
                if (!await payments.notify(query)) return reply(400)
                return response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' }).end('success')
            }
            if (webAccount || checkout || orderStatus) {
                if (request.method === 'DELETE') {
                    if (request.headers.origin !== webOrigin) return reply(403)
                    setWebSession('', 0)
                    return reply(204)
                }
                const cookie = new RegExp(`(?:^|;\\s*)${webCookie}=([^;]+)`).exec(request.headers.cookie ?? '')?.[1]
                const account = cookie && await verifySession(sessionKey, directory, `Bearer ${cookie}`)
                if (!account) return reply(401)
                if (orderStatus) {
                    const query = new URL(request.url, webOrigin).searchParams
                    const order = await payments.readOrderStatus(account.id, query.get('order'))
                    return order ? json(200, order) : reply(404)
                }
                if (checkout) {
                    if (request.headers.origin !== webOrigin) return reply(403)
                    if (!paymentConfig) return reply(503)
                    const body = await readJSON(request, bodyLimit)
                    if (body.status) return reply(body.status)
                    const order = await payments.checkout({ id: account.id, trialExpiresAt: trialExpiration(account) }, body.value?.plan, ip)
                    if (!order) return reply(400)
                    return json(201, order)
                }
                const entitlement = await getEntitlement(account)
                return json(200, { ...entitlement, checkoutAvailable: !!paymentConfig })
            }
            if (sync) {
                const account = await verifySession(sessionKey, directory, request.headers.authorization)
                if (!account) return reply(401)
                return await syncConnections(directory, account, request, response, syncWrites, await getEntitlement(account))
            }
            if (request.url === sessionPath) {
                const account = await verifySession(sessionKey, directory, request.headers.authorization)
                return account ? authenticated(204, account) : reply(401)
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
                    return authenticated(204, account, emailHash)
                }
                return reply(401)
            } finally {
                verifying = false
            }
        } catch (error) {
            if (!response.destroyed) {
                if (error instanceof CheckoutGatewayError) {
                    console.warn('PototaPay checkout failed', error.message, error.status ?? '')
                    return json(502, { error: 'payment_gateway_unavailable' })
                }
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
    const payment = await readPaymentConfig(process.env.TOPPER_POTOTA_CONFIG)
    createAuthServer(directory, process.env.TABBY_AUTH_PROXY_IP, await loadSessionKey(directory), payment).listen(port, host, () => console.log(`Tabby auth listening on ${host}:${port}`))
}
