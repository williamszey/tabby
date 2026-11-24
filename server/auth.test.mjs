import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAuthServer } from './auth.mjs'

test('registers distinct accounts, verifies their credentials, and reloads them after a restart', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'tabby-auth-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const start = async () => {
        const server = createAuthServer(directory).listen(0, '127.0.0.1')
        await once(server, 'listening')
        t.after(() => server.close())
        return { server, base: `http://127.0.0.1:${server.address().port}/api/tabby` }
    }
    const post = (base, action, email, password) => fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    })

    const first = await start()
    const password = 'Tabby fixture password'
    const register = await post(first.base, 'register', 'Person@example.test', password)
    const account = register.headers.get('X-Tabby-Account')
    assert.equal(register.status, 201)
    assert.match(account, /^[a-f0-9]{64}$/)
    assert.equal((await post(first.base, 'register', 'person@example.test', password)).status, 409)
    const other = await post(first.base, 'register', 'other@example.test', password)
    assert.equal(other.status, 201)
    assert.notEqual(other.headers.get('X-Tabby-Account'), account)
    const accounts = await readdir(directory)
    assert.equal(accounts.length, 2)
    for (const file of accounts) {
        assert.equal((await readFile(join(directory, file), 'utf8')).includes(password), false)
    }

    first.server.close()
    const { base } = await start()
    const login = await post(base, 'login', 'PERSON@example.test', password)
    assert.equal(login.status, 204)
    assert.equal(login.headers.get('X-Tabby-Account'), account)
    assert.equal((await post(base, 'login', 'person@example.test', 'incorrect')).status, 401)
    assert.equal((await post(base, 'login', 'missing@example.test', password)).status, 401)
    assert.equal((await post(base, 'register', 'not-an-email', password)).status, 400)
    assert.equal((await fetch(`${base}/login`)).status, 405)
})
