const defaultOrigin = 'https://topperapi.com'

export type LoginResult = 'ok' | 'invalid' | 'duplicate' | 'limited' | 'error' | 'unavailable'
type AuthResponse = { status: 'ok', accountId: string } | { status: Exclude<LoginResult, 'ok'> }

export class AuthClient {
    private origin: URL

    constructor (origin = defaultOrigin) {
        this.origin = new URL(origin)
        if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password) {
            throw new Error('The Tabby login endpoint must be an HTTPS URL')
        }
    }

    async authenticate (mode: unknown, email: unknown, password: unknown): Promise<AuthResponse> {
        email = typeof email === 'string' ? email.trim() : email
        if ((mode !== 'login' && mode !== 'register') || typeof email !== 'string' || !email || email.length > 254 ||
            typeof password !== 'string' || !password || password.length > 256) {
            return { status: 'invalid' }
        }

        const response = await fetch(new URL(`/api/tabby/${mode}`, this.origin), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
            credentials: 'omit',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
        })
        await response.body?.cancel()
        const id = response.headers.get('X-Tabby-Account')
        if (response.status === (mode === 'login' ? 204 : 201) && id && /^[a-f0-9]{64}$/.test(id)) {
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
}
