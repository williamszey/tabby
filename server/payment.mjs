import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const plans = new Map([
    ['monthly', { cents: 500, months: 1, name: 'Topper Terminal 月付' }],
    ['annual', { cents: 5000, months: 12, name: 'Topper Terminal 年付' }],
    ['thanksgiving', { cents: 1200, months: 12, name: 'Topper Terminal 感恩节年付' }],
    ['test-30d', { cents: 100, days: 30, name: 'Topper Terminal 测试套餐 30 天' }],
])

const submitURL = 'https://pototapay.com/api/pay/submit'

export class CheckoutGatewayError extends Error {
    constructor (reason, status) {
        super(reason)
        this.status = status
    }
}

function signingText (fields) {
    return Object.keys(fields).sort()
        .filter(key => key !== 'sign' && key !== 'sign_type' && fields[key] !== '' && fields[key] != null)
        .map(key => `${key}=${fields[key]}`).join('&')
}

function legacySignature (fields, secret) {
    return createHash('md5').update(signingText(fields)).update(secret).digest()
}

function verifyNotification (fields, config) {
    if (config.version === 1) {
        return fields.sign_type === 'MD5' && /^[a-f0-9]{32}$/.test(fields.sign ?? '') &&
            timingSafeEqual(legacySignature(fields, config.merchantMd5Key), Buffer.from(fields.sign, 'hex'))
    }
    return fields.sign_type === 'RSA' && /^\d{10}$/.test(fields.timestamp ?? '') && !!fields.sign &&
        verify('sha256', Buffer.from(signingText(fields)), config.publicKey, Buffer.from(fields.sign, 'base64'))
}

async function lookupLegacyOrder (id, config) {
    const url = new URL('https://pototapay.com/api.php')
    url.search = new URLSearchParams({ act: 'order', pid: config.pid, key: config.merchantMd5Key, out_trade_no: id })
    try {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('Provider unavailable')
        return await response.json()
    } catch {
        throw new Error('Could not verify PototaPay order')
    }
}

async function submitLegacyOrder (fields) {
    const response = await fetch('https://pototapay.com/mapi.php', {
        method: 'POST', body: new URLSearchParams(fields), redirect: 'error', signal: AbortSignal.timeout(8000),
    }).catch(() => { throw new CheckoutGatewayError('transport') })
    if (!response.ok) throw new CheckoutGatewayError('http', response.status)
    return response.json().catch(() => { throw new CheckoutGatewayError('invalid-response') })
}

function isCashierURL (url) {
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ((url.hostname === 'pototapay.com' && url.pathname.startsWith('/pay/')) ||
            url.hostname === 'alipay.com' || url.hostname.endsWith('.alipay.com'))
}

function keyWithHeader (raw, label) {
    const value = raw.trim()
    return value.startsWith('-----BEGIN ') ? value : `-----BEGIN ${label}-----\n${value}\n-----END ${label}-----`
}

export async function readPaymentConfig (file) {
    if (!file) return null
    const { version = 2, pid, merchantMd5Key, merchantPrivateKey, platformPublicKey } = JSON.parse(await readFile(file, 'utf8'))
    if (!/^\d{1,15}$/.test(String(pid))) throw new Error('Invalid PototaPay merchant ID')
    if (version === 1) {
        if (typeof merchantMd5Key !== 'string' || !/^[!-~]{16,128}$/.test(merchantMd5Key)) {
            throw new Error('Invalid PototaPay V1 merchant key')
        }
        return { version, pid: String(pid), merchantMd5Key }
    }
    if (version !== 2) throw new Error('Unsupported PototaPay API version')
    const privateKey = createPrivateKey(keyWithHeader(merchantPrivateKey, 'PRIVATE KEY'))
    const publicKey = createPublicKey(keyWithHeader(platformPublicKey, 'PUBLIC KEY'))
    if (privateKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyType !== 'rsa') {
        throw new Error('PototaPay requires RSA keys')
    }
    return { version, pid: String(pid), privateKey, publicKey }
}

async function readRecord (file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
    }
}

function addMonths (from, months) {
    const date = new Date(from)
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + months)
    const last = new Date(date)
    last.setUTCMonth(last.getUTCMonth() + 1, 0)
    date.setUTCDate(Math.min(day, last.getUTCDate()))
    return date.getTime()
}

export function createPayments (directory, config, origin) {
    const writing = new Set()
    const billingFile = id => join(directory, `billing-${id}.json`)
    const orderFile = id => join(directory, `order-${id}.json`)
    return {
        async readEntitlement (accountId) {
            return await readRecord(billingFile(accountId))
        },

        async readOrderStatus (accountId, id) {
            if (!/^[a-f0-9]{32}$/.test(id ?? '')) return null
            const order = await readRecord(orderFile(id))
            if (order?.accountId !== accountId) return null
            const billing = await readRecord(billingFile(accountId))
            return { status: billing?.payments.some(payment => payment.id === id) ? 'paid' : 'pending' }
        },

        async checkout (account, planId, ip = '127.0.0.1') {
            const plan = plans.get(planId)
            if (!config || !plan) return null
            const id = randomBytes(16).toString('hex')
            const money = (plan.cents / 100).toFixed(2)
            const version = config.version ?? 2
            const fields = {
                pid: config.pid, type: 'alipay', out_trade_no: id,
                notify_url: `${origin}/api/tabby/payment/notify`,
                return_url: `${origin}/TopperTerminal/account?order=${id}`,
                name: plan.name, money,
            }
            if (version === 1) {
                fields.clientip = ip
                fields.device = 'jump'
                fields.sign_type = 'MD5'
                fields.sign = legacySignature(fields, config.merchantMd5Key).toString('hex')
            } else {
                fields.timestamp = String(Math.floor(Date.now() / 1000))
                fields.sign_type = 'RSA'
                fields.sign = sign('sha256', Buffer.from(signingText(fields)), config.privateKey).toString('base64')
            }
            await writeFile(orderFile(id), JSON.stringify({ version, accountId: account.id, planId, money, trialExpiresAt: account.trialExpiresAt }), {
                flag: 'wx', mode: 0o600,
            })
            if (version === 1) {
                const result = await (config.submitOrder ?? submitLegacyOrder)(fields)
                const cashier = Number(result?.code) === 1 && result.trade_no && typeof result.payurl === 'string' && URL.canParse(result.payurl)
                    ? new URL(result.payurl) : null
                if (!cashier || !isCashierURL(cashier)) throw new CheckoutGatewayError('cashier-unavailable')
                return { id, money, redirect: cashier.href }
            }
            return { url: submitURL, fields }
        },

        async notify (query) {
            const fields = Object.fromEntries(query)
            if (!config || Object.keys(fields).length !== query.size || fields.pid !== config.pid ||
                fields.type !== 'alipay' || fields.trade_status !== 'TRADE_SUCCESS' ||
                !/^[a-f0-9]{32}$/.test(fields.out_trade_no ?? '') || !fields.trade_no ||
                !verifyNotification(fields, config)) {
                return false
            }
            const order = await readRecord(orderFile(fields.out_trade_no))
            if (!order || (order.version ?? 2) !== (config.version ?? 2) ||
                !/^\d+(?:\.\d{1,2})?$/.test(fields.money ?? '') || Number(fields.money) !== Number(order.money)) {
                return false
            }
            const { accountId, planId, trialExpiresAt } = order
            if (writing.has(accountId)) throw new Error('Account payment is being applied')
            writing.add(accountId)
            try {
                const file = billingFile(accountId)
                const state = await readRecord(file) ?? { expiresAt: 0, payments: [] }
                const previous = state.payments.find(payment => payment.id === fields.out_trade_no || payment.tradeNo === fields.trade_no)
                if (previous) return previous.id === fields.out_trade_no && previous.tradeNo === fields.trade_no
                if (config.version === 1) {
                    const confirmed = await (config.lookupOrder ?? lookupLegacyOrder)(fields.out_trade_no, config)
                    if (Number(confirmed?.code) !== 1 || Number(confirmed.status) !== 1 ||
                        String(confirmed.pid) !== config.pid || confirmed.out_trade_no !== fields.out_trade_no ||
                        confirmed.trade_no !== fields.trade_no || confirmed.type !== 'alipay' ||
                        Number(confirmed.money) !== Number(order.money)) {
                        throw new Error('PototaPay has not confirmed the order')
                    }
                }
                const plan = plans.get(planId)
                const from = Math.max(Date.now(), state.expiresAt, trialExpiresAt ?? 0)
                state.expiresAt = plan.days ? from + plan.days * 24 * 60 * 60 * 1000 : addMonths(from, plan.months)
                state.planId = planId
                state.payments.push({ id: fields.out_trade_no, tradeNo: fields.trade_no })
                const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
                try {
                    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
                    await rename(temporary, file)
                } finally {
                    await rm(temporary, { force: true })
                }
                return true
            } finally {
                writing.delete(accountId)
            }
        },
    }
}
