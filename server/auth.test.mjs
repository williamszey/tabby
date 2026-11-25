import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAuthServer } from './auth.mjs'

test('registers distinct accounts, verifies their credentials, and reloads them after a restart', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'tabby-auth-'))
    const sessionKey = randomBytes(32)
    t.after(() => rm(directory, { recursive: true, force: true }))
    const start = async () => {
        const server = createAuthServer(directory, undefined, sessionKey).listen(0, '127.0.0.1')
        await once(server, 'listening')
        t.after(() => server.close())
        return { server, base: `http://127.0.0.1:${server.address().port}/api/tabby` }
    }
    const post = (base, action, email, password, headers = {}) => fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ email, password }),
    })

    const first = await start()
    const password = 'Tabby fixture password'
    const register = await post(first.base, 'register', 'Person@example.test', password, { 'X-Topper-Client': 'desktop' })
    const account = register.headers.get('X-Tabby-Account')
    const session = register.headers.get('X-Topper-Session')
    assert.equal(register.status, 201)
    assert.match(account, /^[a-f0-9]{64}$/)
    assert.ok(session)
    assert.equal((await post(first.base, 'register', 'person@example.test', password)).status, 409)
    const other = await post(first.base, 'register', 'other@example.test', password)
    assert.equal(other.status, 201)
    assert.equal(other.headers.get('X-Topper-Session'), null)
    assert.notEqual(other.headers.get('X-Tabby-Account'), account)
    const accounts = await readdir(directory)
    assert.equal(accounts.length, 2)
    for (const file of accounts) {
        assert.equal((await readFile(join(directory, file), 'utf8')).includes(password), false)
    }

    first.server.close()
    const { base } = await start()
    const restore = token => fetch(`${base}/session`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
    })
    const restored = await restore(session)
    assert.equal(restored.status, 204)
    assert.equal(restored.headers.get('X-Tabby-Account'), account)
    assert.equal((await restore(`${session}0`)).status, 401)
    const login = await post(base, 'login', 'PERSON@example.test', password)
    assert.equal(login.status, 204)
    assert.equal(login.headers.get('X-Tabby-Account'), account)
    assert.equal((await post(base, 'login', 'person@example.test', 'incorrect')).status, 401)
    assert.equal((await post(base, 'login', 'missing@example.test', password)).status, 401)
    assert.equal((await post(base, 'register', 'not-an-email', password)).status, 400)
    assert.equal((await fetch(`${base}/login`)).status, 405)
})

test('only newly registered accounts can read and write their own cloud records for seven days', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'tabby-sync-'))
    const server = createAuthServer(directory).listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(async () => {
        server.close()
        await rm(directory, { recursive: true, force: true })
    })
    const origin = `http://127.0.0.1:${server.address().port}/api/tabby`
    const email = 'sync@example.test'
    const register = email => fetch(`${origin}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Topper-Client': 'desktop' },
        body: JSON.stringify({ email, password: 'temporary test password' }),
    })
    const first = await register(email)
    assert.equal(first.status, 201)
    const token = first.headers.get('X-Topper-Session')
    const path = join(directory, createHash('sha256').update(email).digest('hex') + '.json')
    const account = JSON.parse(await readFile(path, 'utf8'))
    const trial = 7 * 24 * 60 * 60 * 1000
    assert.equal(Number(first.headers.get('X-Topper-Sync-Expires')), account.createdAt + trial)
    const sync = (token, body, historyMode = '1') => fetch(`${origin}/ssh-sync`, {
        method: body ? 'PUT' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Topper-SSH-History': historyMode },
        body: body ? JSON.stringify(body) : undefined,
    })
    assert.equal((await sync('invalid')).status, 401)
    const empty = await (await sync(token)).json()
    assert.deepEqual(empty.records, [])
    const records = [{ id: 'ssh-demo', encrypted: randomBytes(64).toString('base64url') }]
    const write = await sync(token, { revision: empty.revision, records })
    assert.equal(write.status, 200)
    assert.equal((await sync(token, { revision: empty.revision, records })).status, 409)
    assert.deepEqual((await (await sync(token)).json()).records, records)
    const current = await (await sync(token)).json()
    const historyRecords = [{ id: records[0].id, encrypted: randomBytes(64).toString('base64url') }]
    assert.equal((await sync(token, {
        revision: current.revision, historyRecords: [{ ...historyRecords[0], id: 'unowned-profile' }],
    })).status, 400)
    const historyWrite = await sync(token, { revision: current.revision, historyRecords })
    assert.equal(historyWrite.status, 200)
    const historyState = await historyWrite.json()
    assert.deepEqual(historyState.historyRecords, historyRecords)
    const legacyWrite = await sync(token, { revision: historyState.revision, records }, '')
    assert.equal((await legacyWrite.json()).historyRecords, undefined)
    assert.deepEqual((await (await sync(token)).json()).historyRecords, historyRecords)
    assert.deepEqual((await (await sync(token, undefined, 'status')).json()).records, [])
    const other = await register('other@example.test')
    assert.deepEqual((await (await sync(other.headers.get('X-Topper-Session'))).json()).records, [])
    await writeFile(path, JSON.stringify({ ...account, createdAt: Date.now() - trial }))
    assert.equal((await sync(token)).status, 403)
    assert.equal((await sync(token, { revision: null, records })).status, 403)
    assert.equal((await sync(token, { revision: null, historyRecords })).status, 403)
    const session = await fetch(`${origin}/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    assert.equal(session.status, 204)
    delete account.createdAt
    await writeFile(path, JSON.stringify(account))
    assert.deepEqual(await (await sync(token)).json(), { expiresAt: null })
})

for (const version of [1, 2]) {
    test(`PototaPay V${version} opens a plan once after a verified payment`, async t => {
        const directory = await mkdtemp(join(tmpdir(), 'tabby-payment-'))
        const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const platform = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const pid = '1001'
        const merchantMd5Key = randomBytes(20).toString('hex')
        let confirmed
        let legacyFields
        const payment = version === 1
            ? {
                version, pid, merchantMd5Key, lookupOrder: async () => confirmed,
                submitOrder: async fields => {
                    legacyFields = fields
                    return { code: 1, trade_no: 'fixture-trade', payurl: 'https://pototapay.com/pay/alipay/test/' }
                },
            }
            : { version, pid, privateKey: merchant.privateKey, publicKey: platform.publicKey }
        const server = createAuthServer(directory, undefined, undefined, payment).listen(0, '127.0.0.1')
        await once(server, 'listening')
        t.after(async () => {
            server.close()
            await rm(directory, { recursive: true, force: true })
        })
        const base = `http://127.0.0.1:${server.address().port}/api/tabby`
        const origin = 'https://www.topperapi.com'
        const headers = { Origin: origin, 'Content-Type': 'application/json' }
        const credentials = { email: 'payer@example.test', password: 'test account password' }
        const registered = await fetch(`${base}/register`, { method: 'POST', headers, body: JSON.stringify(credentials) })
        assert.equal(registered.status, 201)
        const setCookie = registered.headers.get('Set-Cookie')
        assert.match(setCookie, /^__Host-topper-account=.*; Path=\/; Secure; HttpOnly; SameSite=Lax;/)
        assert.equal((await fetch(`${base}/account`)).status, 401)
        const cookie = setCookie.split(';')[0]
        const getPlan = async () => (await fetch(`${base}/account`, { headers: { Cookie: cookie } })).json()
        const trial = await getPlan()
        assert.equal(trial.plan, 'trial')
        assert.equal(trial.checkoutAvailable, true)
        assert.deepEqual(await (await fetch(`${base}/payment/status`)).json(), { available: true })
        const planId = version === 1 ? 'test-30d' : 'thanksgiving'
        const money = version === 1 ? '1.00' : '12.00'
        const checkout = await fetch(`${base}/payment/checkout`, {
            method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ plan: planId, money: '0.01' }),
        })
        assert.equal(checkout.status, 201)
        const response = await checkout.json()
        const fields = version === 1 ? legacyFields : response.fields
        if (version === 1) {
            assert.deepEqual(response, { id: fields.out_trade_no, money, redirect: 'https://pototapay.com/pay/alipay/test/' })
            assert.equal(fields.device, 'jump')
        } else {
            assert.equal(response.url, 'https://pototapay.com/api/pay/submit')
        }
        assert.equal(fields.sign_type, version === 1 ? 'MD5' : 'RSA')
        assert.equal(fields.money, money)
        const statusURL = `${base}/payment/order?order=${fields.out_trade_no}`
        assert.equal((await fetch(statusURL)).status, 401)
        const getOrder = () => fetch(statusURL, { headers: { Cookie: cookie } })
        assert.deepEqual(await (await getOrder()).json(), { status: 'pending' })
        assert.equal(new URL(fields.return_url).searchParams.get('order'), fields.out_trade_no)
        const signatureText = values => Object.keys(values).filter(k => !['sign', 'sign_type'].includes(k)).sort().map(k => `${k}=${values[k]}`).join('&')
        if (version === 1) {
            assert.equal(fields.sign, createHash('md5').update(signatureText(fields) + merchantMd5Key).digest('hex'))
            assert.equal(fields.timestamp, undefined)
            assert.ok(!JSON.stringify(fields).includes(merchantMd5Key))
        } else {
            assert.ok(verify('sha256', Buffer.from(signatureText(fields)), merchant.publicKey, Buffer.from(fields.sign, 'base64')))
        }
        const result = {
            pid, trade_no: 'fixture-trade', out_trade_no: fields.out_trade_no, money,
            type: 'alipay', trade_status: 'TRADE_SUCCESS', sign_type: fields.sign_type,
            ...(version === 2 ? { timestamp: fields.timestamp } : {}),
        }
        const notify = (values, valid = true) => {
            const signature = version === 1
                ? createHash('md5').update(signatureText(values) + (valid ? merchantMd5Key : 'wrong-key')).digest('hex')
                : sign('sha256', Buffer.from(signatureText(values)), valid ? platform.privateKey : merchant.privateKey).toString('base64')
            return fetch(`${base}/payment/notify?${new URLSearchParams({ ...values, sign: signature })}`)
        }
        assert.equal((await notify(result, false)).status, 400)
        assert.equal((await notify({ ...result, money: '0.01' })).status, 400)
        if (version === 1) {
            confirmed = { ...result, code: 1, status: 0 }
            assert.equal((await notify(result)).status, 500)
            assert.deepEqual(await (await getOrder()).json(), { status: 'pending' })
            confirmed.status = 1
        }
        assert.equal(await (await notify(result)).text(), 'success')
        assert.deepEqual(await (await getOrder()).json(), { status: 'paid' })
        const paid = await getPlan()
        assert.equal(paid.plan, 'paid')
        assert.equal(paid.planId, planId)
        if (version === 1) assert.equal(paid.expiresAt - trial.expiresAt, 30 * 24 * 60 * 60 * 1000)
        assert.ok(paid.expiresAt > trial.expiresAt)
        assert.equal(await (await notify(result)).text(), 'success')
        assert.deepEqual(await getPlan(), paid)
        assert.equal((await fetch(`${base}/account`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 403)
        const logout = await fetch(`${base}/account`, { method: 'DELETE', headers: { Origin: origin, Cookie: cookie } })
        assert.equal(logout.status, 204)
        assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0$/)
    })
}
