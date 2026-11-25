import type { SSHCommandHistory } from '../../tabby-core/src/api/sshCommandHistory'
import { safeStorage } from 'electron'
import { mkdir, readFile, rm } from 'fs/promises'
import * as path from 'path'
import { writeFile } from 'atomically'
import type { SSHCloudConnection, SSHCloudFingerprints, SSHCloudResult } from '../../tabby-core/src/api/sshCloudSync'
import { deriveSSHCloudKey, syncSSHConnections } from './sshCloudSync'

const defaultOrigin = 'https://topperapi.com'
const accountPattern = /^[a-f0-9]{64}$/
const tokenPattern = /^(?:[a-f0-9]{64}\.){2}\d{13}\.[a-f0-9]{64}$/

export type LoginResult = 'ok' | 'invalid' | 'duplicate' | 'limited' | 'error' | 'unavailable' | 'storage'
type AuthResponse = { status: 'ok', accountId: string } | { status: Exclude<LoginResult, 'ok'> }

export class AuthClient {
    accountEmail?: string
    private origin: URL
    private token?: string
    private cloudKey?: Buffer

    constructor (private directory: string, origin = defaultOrigin) {
        this.origin = new URL(origin)
        if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password) {
            throw new Error('The TopperTerminal login endpoint must be an HTTPS URL')
        }
    }

    async restoreSession (): Promise<string | null> {
        if (!this.canSaveSession()) {
            return null
        }
        try {
            const encrypted = await readFile(this.sessionFile)
            const token = safeStorage.decryptString(encrypted)
            if (!tokenPattern.test(token)) {
                return null
            }
            const [, id] = token.split('.')
            const response = await this.post('session', { Authorization: `Bearer ${token}` }).catch(() => null)
            if (response?.status === 401) {
                await this.clearSession()
                return null
            }
            if (response && response.status < 500 && response.status !== 429 &&
                (response.status !== 204 || response.headers.get('X-Tabby-Account') !== id)) {
                return null
            }
            this.token = token
            const [cloudKey, accountEmail] = await Promise.all([this.loadCloudKey(id), this.loadAccountEmail(id)])
            this.cloudKey = cloudKey
            this.accountEmail = accountEmail
            return id
        } catch {
            return null
        }
    }

    async authenticate (mode: unknown, email: unknown, password: unknown): Promise<AuthResponse> {
        email = typeof email === 'string' ? email.trim().toLowerCase() : email
        if ((mode !== 'login' && mode !== 'register') || typeof email !== 'string' || !email || email.length > 254 ||
            typeof password !== 'string' || !password || password.length > 256) {
            return { status: 'invalid' }
        }

        const response = await this.post(mode, { 'Content-Type': 'application/json', 'X-Topper-Client': 'desktop' }, JSON.stringify({ email, password }))
        const id = response.headers.get('X-Tabby-Account')
        if (response.status === (mode === 'login' ? 204 : 201) && id && accountPattern.test(id)) {
            const token = response.headers.get('X-Topper-Session')
            if (!token || !tokenPattern.test(token) || token.split('.')[1] !== id) {
                return { status: 'error' }
            }
            const cloudKey = await deriveSSHCloudKey(id, password).catch(() => undefined)
            if (!await this.saveSession(id, token, email, cloudKey)) {
                cloudKey?.fill(0)
                return { status: 'storage' }
            }
            this.accountEmail = email
            this.token = token
            this.cloudKey = cloudKey
            return { status: 'ok', accountId: id }
        }
        switch (response.status) {
            case 400:
            case 401: return { status: 'invalid' }
            case 409: return { status: 'duplicate' }
            case 429: return { status: 'limited' }
            default: return { status: 'error' }
        }
    }

    async clearSession (): Promise<void> {
        this.token = undefined
        this.accountEmail = undefined
        this.cloudKey?.fill(0)
        this.cloudKey = undefined
        await Promise.all([this.sessionFile, this.cloudKeyFile, this.accountEmailFile].map(file => rm(file, { force: true })))
    }

    async syncSSHConnections (profiles?: SSHCloudConnection[], fingerprints: SSHCloudFingerprints = [], history: SSHCommandHistory = []): Promise<SSHCloudResult> {
        const token = this.token
        if (!token) {
            return { status: 'reauth' }
        }
        try {
            return await syncSSHConnections(body => fetch(new URL('/api/tabby/ssh-sync', this.origin), {
                method: body === undefined ? 'GET' : 'PUT',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-Topper-SSH-History': profiles === undefined ? 'status' : '1',
                },
                body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
            }), this.cloudKey, profiles, fingerprints, history)
        } catch {
            return { status: 'unavailable' }
        }
    }

    private async saveSession (id: string, token: string, email: string, cloudKey?: Buffer): Promise<boolean> {
        if (!this.canSaveSession()) {
            return false
        }
        try {
            await mkdir(this.directory, { recursive: true, mode: 0o700 })
            if (cloudKey) {
                const value = `${id}:${cloudKey.toString('hex')}`
                await writeFile(this.cloudKeyFile, safeStorage.encryptString(value), { mode: 0o600 })
            } else {
                await rm(this.cloudKeyFile, { force: true })
            }
            await writeFile(this.accountEmailFile, safeStorage.encryptString(JSON.stringify({ id, email })), { mode: 0o600 })
            await writeFile(this.sessionFile, safeStorage.encryptString(token), { mode: 0o600 })
            return true
        } catch (error) {
            console.warn('Could not save the account session:', error)
            return false
        }
    }

    private async loadCloudKey (accountId: string): Promise<Buffer | undefined> {
        try {
            const encrypted = await readFile(this.cloudKeyFile)
            const [id, key] = safeStorage.decryptString(encrypted).split(':')
            if (id === accountId && /^[a-f0-9]{64}$/.test(key)) {
                return Buffer.from(key, 'hex')
            }
        } catch {
            // A session saved by an older client may have no cloud encryption key.
        }
        return undefined
    }

    private async loadAccountEmail (accountId: string): Promise<string | undefined> {
        try {
            const encrypted = await readFile(this.accountEmailFile)
            const { id, email } = JSON.parse(safeStorage.decryptString(encrypted))
            if (id === accountId && typeof email === 'string' && email.includes('@') && email.length <= 254) {
                return email
            }
        } catch {
            // Earlier clients stored only the session token.
        }
        return undefined
    }

    private get sessionFile (): string {
        return path.join(this.directory, 'account-session.bin')
    }

    private get cloudKeyFile (): string {
        return path.join(this.directory, 'ssh-cloud-key.bin')
    }

    private get accountEmailFile (): string {
        return path.join(this.directory, 'account-email.bin')
    }

    private canSaveSession (): boolean {
        return safeStorage.isEncryptionAvailable() &&
            (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
    }

    private async post (endpoint: string, headers: Record<string, string>, body?: string): Promise<Response> {
        const response = await fetch(new URL(`/api/tabby/${endpoint}`, this.origin), {
            method: 'POST', headers, body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
        })
        await response.body?.cancel()
        return response
    }
}
