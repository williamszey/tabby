import type { SSHCommandHistory } from './sshCommandHistory'

export interface SSHCloudConnection {
    id: string
    name: string
    host: string
    port: number
    user: string
    auth: 'password' | 'keyboardInteractive' | null
    password: string | null
}

export interface SSHCloudFingerprint {
    profile: string
    name: string
    connection: string
}

// eslint-disable-next-line @typescript-eslint/no-type-alias
export type SSHCloudFingerprints = [id: string, fingerprint: SSHCloudFingerprint | string][]

export type SSHCloudResult = {
    status: 'active'
    expiresAt: number
    plan?: 'trial' | 'paid'
    profiles: SSHCloudConnection[]
    fingerprints: SSHCloudFingerprints
    history?: SSHCommandHistory
} | {
    status: 'reauth'
    expiresAt?: number
    plan?: 'trial' | 'paid'
} | {
    status: 'expired' | 'local' | 'unavailable' | 'limit'
}
