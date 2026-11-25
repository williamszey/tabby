import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt } from 'node:crypto'
import type { SSHCloudConnection, SSHCloudFingerprints, SSHCloudResult } from '../../tabby-core/src/api/sshCloudSync'

import { applySSHCommandFavorites, isSSHRecentCommandText, mergeSSHRecentCommands } from '../../tabby-core/src/api/sshCommandHistory'
import type { SSHCommandCollections, SSHCommandHistory } from '../../tabby-core/src/api/sshCommandHistory'

interface EncryptedConnection {
    id: string
    encrypted: string
}
interface CloudState {
    revision: string | null
    expiresAt: number
    plan?: 'trial' | 'paid'
    records: EncryptedConnection[]
    historyRecords?: EncryptedConnection[]
}

const maxProfiles = 200

export function deriveSSHCloudKey (accountId: string, password: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, 'topper-ssh-cloud-v1:' + accountId, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }, (error, key) => {
            if (error) {
                reject(error)
            } else {
                resolve(key)
            }
        })
    })
}

function normalize (item: Record<keyof SSHCloudConnection, unknown>): SSHCloudConnection {
    const { id, name, host, port, user, auth, password } = item
    if (typeof id !== 'string' || !/^[^\u0000-\u001f]{1,256}$/.test(id) ||
        typeof name !== 'string' || typeof host !== 'string' || !host || typeof user !== 'string' || !user ||
        typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 ||
        (auth !== null && auth !== 'password' && auth !== 'keyboardInteractive') ||
        (password !== null && typeof password !== 'string')) {
        throw new Error('Invalid SSH cloud connection')
    }
    return {
        id, name, host, port, user,
        auth: auth === 'password' || auth === 'keyboardInteractive' ? auth : null,
        password: typeof password === 'string' ? password : null,
    }
}

function fingerprint (key: Buffer, value: unknown): string {
    return createHmac('sha256', key).update('topper-ssh-fingerprint-v1:').update(JSON.stringify(value)).digest('hex')
}

function connectionDetails (profile: SSHCloudConnection): Omit<SSHCloudConnection, 'name'> {
    const { id, host, port, user, auth, password } = profile
    return { id, host, port, user, auth, password }
}

function encrypt (key: Buffer, id: string, value: unknown, namespace = 'topper-ssh-v1:'): EncryptedConnection {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(namespace + id))
    const encrypted = Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url')
    return { id, encrypted }
}

function decrypt (key: Buffer, record: EncryptedConnection, namespace = 'topper-ssh-v1:'): any {
    const data = Buffer.from(record.encrypted, 'base64url')
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
    cipher.setAAD(Buffer.from(namespace + record.id))
    cipher.setAuthTag(data.subarray(-16))
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString())
}

function decryptConnection (key: Buffer, record: EncryptedConnection): SSHCloudConnection {
    const profile = normalize(decrypt(key, record))
    if (profile.id !== record.id) {
        throw new Error('Invalid SSH cloud record ID')
    }
    return profile
}

function failureStatus (status: number, expiresAt: number | null = null): SSHCloudResult {
    switch (status) {
        case 401: return { status: 'reauth' }
        case 403: return { status: expiresAt === null ? 'local' : 'expired' }
        case 413: return { status: 'limit' }
        default: return { status: 'unavailable' }
    }
}

export async function syncSSHConnections (
    request: (body?: string) => Promise<Response>,
    key: Buffer | undefined,
    profiles: SSHCloudConnection[] | undefined,
    fingerprints: SSHCloudFingerprints,
    history: SSHCommandHistory = [],
): Promise<SSHCloudResult> {
    if ((profiles !== undefined && (!Array.isArray(profiles) || profiles.length > maxProfiles)) ||
        !Array.isArray(fingerprints) || fingerprints.length > maxProfiles) {
        return { status: 'limit' }
    }

    const response = await request()
    if (!response.ok) {
        const body = response.status === 403 ? await response.json().catch(() => ({})) : null
        await response.body?.cancel().catch(() => null)
        return failureStatus(response.status, Number.isSafeInteger(body?.expiresAt) ? body.expiresAt : null)
    }
    let state: CloudState = await response.json()
    if (!key) {
        return { status: 'reauth', expiresAt: state.expiresAt, plan: state.plan }
    }
    if (profiles === undefined) {
        return { status: 'active', expiresAt: state.expiresAt, plan: state.plan, profiles: [], fingerprints: [] }
    }

    const baseline = new Map(fingerprints)
    const remote = new Map(state.records.map(record => [record.id, decryptConnection(key, record)]))
    const updates: EncryptedConnection[] = []
    for (const item of profiles) {
        let profile = normalize(item)
        const known = baseline.get(profile.id)
        if (fingerprint(key, profile) === (typeof known === 'string' ? known : known?.profile)) {
            continue
        }
        const previous = remote.get(profile.id)
        if (previous && known && typeof known !== 'string') {
            const name = fingerprint(key, profile.name) === known.name ? previous.name : profile.name
            if (fingerprint(key, connectionDetails(profile)) === known.connection) {
                profile = normalize({ ...previous, name })
            } else {
                profile.name = name
            }
        }
        if (previous && previous.host === profile.host && previous.port === profile.port && previous.user === profile.user) {
            profile.password ??= previous.password
        }
        if (previous && fingerprint(key, profile) === fingerprint(key, previous)) {
            continue
        }
        const encrypted = encrypt(key, profile.id, profile)
        if (encrypted.encrypted.length > 4096) {
            return { status: 'limit' }
        }
        updates.push(encrypted)
    }
    if (updates.length) {
        const updated = await request(JSON.stringify({ revision: state.revision, records: updates }))
        if (!updated.ok) {
            const body = updated.status === 403 ? await updated.json().catch(() => ({})) : null
            await updated.body?.cancel().catch(() => null)
            return failureStatus(updated.status, Number.isSafeInteger(body?.expiresAt) ? body.expiresAt : null)
        }
        state = await updated.json()
    }
    const historyUpdates: SSHCommandHistory = []
    if (state.historyRecords) {
        const scope = 'topper-ssh-commands-v1:'
        const local = new Map(history)
        const remoteHistory = new Map(state.historyRecords.map(record => {
            const stored = decrypt(key, record, scope)
            const collection: SSHCommandCollections = {
                recent: mergeSSHRecentCommands(stored.recent),
                favorites: applySSHCommandFavorites(stored.favorites, []),
            }
            return [record.id, collection]
        }))
        const pending: EncryptedConnection[] = []
        for (const { id } of state.records) {
            const previous = remoteHistory.get(id) ?? { recent: [], favorites: [] }
            const own = local.get(id)
            if (!own && !remoteHistory.has(id)) {
                continue
            }
            const edits = own?.edits.filter(edit => isSSHRecentCommandText(edit.command)) ?? []
            const next: SSHCommandCollections = {
                recent: mergeSSHRecentCommands(previous.recent, own?.recent ?? []),
                favorites: applySSHCommandFavorites(previous.favorites, edits),
            }
            if (JSON.stringify(previous) !== JSON.stringify(next)) {
                pending.push(encrypt(key, id, next, scope))
            }
            historyUpdates.push([id, { ...next, edits }])
        }
        for (let index = 0; index < pending.length; index += 25) {
            const updated = await request(JSON.stringify({ revision: state.revision, historyRecords: pending.slice(index, index + 25) }))
            if (!updated.ok) {
                const body = updated.status === 403 ? await updated.json().catch(() => ({})) : null
                await updated.body?.cancel().catch(() => null)
                return failureStatus(updated.status, Number.isSafeInteger(body?.expiresAt) ? body.expiresAt : null)
            }
            state = await updated.json()
        }
    }
    const synchronized = state.records.map(record => decryptConnection(key, record))
    return {
        status: 'active',
        expiresAt: state.expiresAt,
        plan: state.plan,
        profiles: synchronized,
        ...(historyUpdates.length ? { history: historyUpdates } : {}),
        fingerprints: synchronized.map(profile => [profile.id, {
            profile: fingerprint(key, profile),
            name: fingerprint(key, profile.name),
            connection: fingerprint(key, connectionDetails(profile)),
        }]),
    }
}
