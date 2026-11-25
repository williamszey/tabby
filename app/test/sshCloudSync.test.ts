import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import type { SSHCloudConnection, SSHCloudFingerprints } from '../../tabby-core/src/api/sshCloudSync'
import type { SSHCommandHistory } from '../../tabby-core/src/api/sshCommandHistory'
import { syncSSHConnections } from '../lib/sshCloudSync'

const connection: SSHCloudConnection = {
    id: 'ssh-test', name: 'Original', host: '192.0.2.17', port: 22,
    user: 'topper-demo', auth: 'password', password: 'fixture-old-password',
}

function fixture () {
    const key = randomBytes(32)
    let revision = 0
    const records = new Map<string, string>()
    const historyRecords = new Map<string, string>()
    const request = async (body?: string) => {
        if (body) {
            const update = JSON.parse(body)
            assert.equal(update.revision, String(revision))
            for (const { id, encrypted } of update.records ?? []) records.set(id, encrypted)
            for (const { id, encrypted } of update.historyRecords ?? []) historyRecords.set(id, encrypted)
            revision++
        }
        const entries = [...records].map(([id, encrypted]) => ({ id, encrypted }))
        return new Response(JSON.stringify({
            revision: String(revision), records: entries, expiresAt: 1_999_999_999_000, plan: 'paid',
            historyRecords: [...historyRecords].map(([id, encrypted]) => ({ id, encrypted })),
        }))
    }
    const sync = async (profiles: SSHCloudConnection[], fingerprints: SSHCloudFingerprints = [], history: SSHCommandHistory = []) => {
        const result = await syncSSHConnections(request, key, profiles, fingerprints, history)
        assert.equal(result.status, 'active')
        if (result.status !== 'active') throw new Error('Expected active sync')
        return result
    }
    return { sync, getCloud: () => JSON.stringify([...records, ...historyRecords]) }
}

test('a local rename merges with a remote IP change without carrying the old password', async () => {
    const { sync, getCloud } = fixture()
    const original = await sync([connection])
    const remote = { ...connection, host: '198.51.100.19', password: null }
    await sync([remote], original.fingerprints)
    const local = { ...connection, name: 'Local rename' }
    const merged = await sync([local], original.fingerprints)
    assert.deepEqual(merged.profiles, [{ ...remote, name: local.name }])
    assert.equal(getCloud().includes(connection.password!), false)
    assert.deepEqual((await sync([], [])).profiles, merged.profiles)
})

test('a local endpoint and password change preserve a remote rename for the same profile', async () => {
    const { sync } = fixture()
    const original = await sync([connection])
    await sync([{ ...connection, name: 'Remote name' }], original.fingerprints)
    const local = { ...connection, host: '203.0.113.21', port: 2222, password: 'fixture-new-password' }
    const merged = await sync([local], original.fingerprints)
    assert.deepEqual(merged.profiles, [{ ...local, name: 'Remote name' }])
})

test('old single fingerprints still let an unchanged device pull cloud edits', async () => {
    const { sync } = fixture()
    const original = await sync([connection])
    const [id, record] = original.fingerprints[0]
    assert.equal(typeof record, 'object')
    if (typeof record === 'string') throw new Error('Expected structured fingerprint')
    const remote = { ...connection, name: 'Updated elsewhere' }
    await sync([remote], original.fingerprints)
    const onUpgrade = await sync([connection], [[id, record.profile]])
    assert.deepEqual(onUpgrade.profiles, [remote])
})

test('explicit local edits win when both versions changed the same profile fields', async () => {
    const { sync } = fixture()
    const original = await sync([connection])
    const remote = { ...connection, name: 'Remote name', host: '198.51.100.20', password: 'fixture-remote-password' }
    await sync([remote], original.fingerprints)
    const local = { ...connection, name: 'Local name', host: '203.0.113.21', password: 'fixture-local-password' }
    const merged = await sync([local], original.fingerprints)
    assert.deepEqual(merged.profiles, [local])
})

test('different profile IDs keep independent connection details', async () => {
    const { sync } = fixture()
    await sync([connection])
    const local = { ...connection, id: 'another-ssh', name: 'Other name', host: '203.0.113.22', password: 'fixture-other-password' }
    const merged = await sync([local])
    assert.deepEqual(merged.profiles, [connection, local])
})


test('command history and favorite edits sync by profile ID across renamed connections and devices', async () => {
    const { sync, getCloud } = fixture()
    const other = { ...connection, id: 'other-profile' }
    const makeEntry = (enteredAt: number) => ({
        id: enteredAt.toString(16).padStart(32, '0'), enteredAt, command: `printf unique-fixture-${enteredAt}`,
    })
    const entry = makeEntry(1)
    const first = await sync([connection, other], [], [[connection.id, {
        recent: [entry], favorites: [], edits: [{ id: entry.id, command: entry.command, favorite: true }],
    }]])
    const renamed = { ...connection, name: 'New label' }
    const second = await sync([renamed, other], first.fingerprints, [[connection.id, {
        recent: Array.from({ length: 10 }, (_, i) => makeEntry(i + 2)), favorites: [], edits: [],
    }]])
    assert.equal(second.history?.length, 1)
    assert.equal(second.history?.[0][0], connection.id)
    assert.equal(second.history?.[0][1].recent.length, 10)
    assert.equal(second.history?.[0][1].recent.some(item => item.id === entry.id), false)
    assert.deepEqual(second.history?.[0][1].favorites, [entry.command])
    assert.equal(getCloud().includes('unique-fixture'), false)
    const removed = await sync([renamed, other], second.fingerprints, [[connection.id, {
        recent: [], favorites: [entry.command], edits: [{ id: 'f'.repeat(32), command: entry.command, favorite: false }],
    }]])
    assert.deepEqual(removed.history?.[0][1].favorites, [])
    const pulled = await sync([renamed, other], removed.fingerprints)
    assert.deepEqual(pulled.history?.[0][1].favorites, [])
    assert.deepEqual(pulled.history?.[0][1].recent, second.history?.[0][1].recent)
})
