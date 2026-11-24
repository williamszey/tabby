import { safeStorage } from 'electron'
import { mkdir, readFile, rm } from 'fs/promises'
import * as path from 'path'
import { writeFile } from 'atomically'

const defaultOrigin = 'https://topperapi.com'
const accountPattern = /^[a-f0-9]{64}$/
const tokenPattern = /^(?:[a-f0-9]{64}\.){2}\d{13}\.[a-f0-9]{64}$/

export type LoginResult = 'ok' | 'invalid' | 'duplicate' | 'limited' | 'error' | 'unavailable'
type AuthResponse = { status: 'ok', accountId: string } | { status: Exclude<LoginResult, 'ok'> }

export class AuthClient {
    private origin: URL

    constructor (private directory: string, origin = defaultOrigin) {
        this.origin = new URL(origin)
        if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password) {
            throw new Error('The Tabby login endpoint must be an HTTPS URL')
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
            const response = await this.post('session', { Authorization: `Bearer ${token}` })
            const id = response.headers.get('X-Tabby-Account')
            if (response.status === 401) {
                await rm(this.sessionFile, { force: true })
            }
            return response.status === 204 && id && accountPattern.test(id) ? id : null
        } catch {
            return null
        }
    }

    async authenticate (mode: unknown, email: unknown, password: unknown): Promise<AuthResponse> {
        email = typeof email === 'string' ? email.trim() : email
        if ((mode !== 'login' && mode !== 'register') || typeof email !== 'string' || !email || email.length > 254 ||
            typeof password !== 'string' || !password || password.length > 256) {
            return { status: 'invalid' }
        }

        const response = await this.post(mode, { 'Content-Type': 'application/json', 'X-Topper-Client': 'desktop' }, JSON.stringify({ email, password }))
        const id = response.headers.get('X-Tabby-Account')
        if (response.status === (mode === 'login' ? 204 : 201) && id && accountPattern.test(id)) {
            const token = response.headers.get('X-Topper-Session')
            if (token && tokenPattern.test(token) && this.canSaveSession()) {
                try {
                    await mkdir(this.directory, { recursive: true, mode: 0o700 })
                    await writeFile(this.sessionFile, safeStorage.encryptString(token), { mode: 0o600 })
                } catch (error) {
                    console.warn('Could not save the account session:', error)
                }
            }
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
        await rm(this.sessionFile, { force: true })
    }

    private get sessionFile (): string {
        return path.join(this.directory, 'account-session.bin')
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
