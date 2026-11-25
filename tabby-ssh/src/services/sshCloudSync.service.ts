import { Injectable } from '@angular/core'
import { ConfigService, HostAppService, PartialProfile, ProfilesService, SSHCloudConnection, SSHCloudFingerprints, SSHCloudResult } from 'tabby-core'
import { SSHProfile } from '../api'
import { PasswordStorageService } from './passwordStorage.service'

const syncInterval = 30_000
const purchaseInterval = 5_000
const purchaseWatchDuration = 3 * 60_000

@Injectable({ providedIn: 'root' })
export class SSHCloudSyncService {
    status: SSHCloudResult['status'] | 'checking' = 'checking'
    expiresAt?: number
    plan?: 'trial' | 'paid'

    private running = false
    private queued = false
    private syncRequested = false
    private nextSyncAt = 0
    private purchaseWatch?: { expiresAt: number, until: number }
    private profileWrites = Promise.resolve()
    private retry?: ReturnType<typeof setTimeout>

    constructor (
        private config: ConfigService,
        private host: HostAppService,
        private profiles: ProfilesService,
        private passwords: PasswordStorageService,
    ) { }

    start (): void {
        this.passwords.passwordChanged$.subscribe(() => this.schedule())
        this.config.changed$.subscribe(() => this.schedule())
        this.schedule()
    }

    watchPurchase (): void {
        this.purchaseWatch = { expiresAt: this.expiresAt ?? 0, until: Date.now() + purchaseWatchDuration }
        this.schedule(false)
    }

    async editProfiles<T> (action: () => Promise<T>): Promise<T> {
        const next = this.profileWrites.then(action)
        this.profileWrites = next.then(() => undefined, () => undefined)
        return next
    }

    private schedule (sync = true): void {
        this.syncRequested ||= sync
        if (this.running) {
            this.queued = true
            return
        }
        clearTimeout(this.retry)
        this.retry = setTimeout(() => { void this.run() }, 500)
    }

    private async run (): Promise<void> {
        this.running = true
        const now = Date.now()
        let shouldSync = this.syncRequested || this.nextSyncAt <= now
        this.syncRequested = false
        if (shouldSync) {
            this.nextSyncAt = now + syncInterval
        }
        if (this.purchaseWatch && this.purchaseWatch.until <= now) {
            this.purchaseWatch = undefined
        }
        try {
            if (this.purchaseWatch !== undefined || this.status !== 'active' || (this.expiresAt ?? 0) <= now) {
                const wasActive = this.status === 'active'
                const eligibility = await this.host.syncSSHConnections()
                const purchaseConfirmed = this.updateStatus(eligibility)
                if (eligibility.status !== 'active') {
                    return
                }
                shouldSync ||= !wasActive || purchaseConfirmed
            }
            if (!shouldSync) {
                return
            }
            this.nextSyncAt = Date.now() + syncInterval
            const fingerprints: SSHCloudFingerprints = this.config.store.ssh.cloudFingerprints
            const profiles = await this.editProfiles(() => this.snapshot())
            const response = await this.host.syncSSHConnections([...profiles.values()], fingerprints)
            this.updateStatus(response)
            if (response.status === 'active') {
                await this.editProfiles(() => this.apply(profiles, fingerprints, response))
            }
        } catch {
            this.status = 'unavailable'
        } finally {
            this.running = false
            clearTimeout(this.retry)
            const nextSync = Math.max(500, this.nextSyncAt - Date.now())
            const delay = this.purchaseWatch ? Math.min(nextSync, purchaseInterval) : nextSync
            this.retry = setTimeout(() => { void this.run() }, this.queued ? 500 : delay)
            this.queued = false
        }
    }

    private updateStatus (response: SSHCloudResult): boolean {
        this.status = response.status
        if (response.status === 'active' || response.status === 'reauth') {
            this.expiresAt = response.expiresAt
            this.plan = response.plan
            if (this.purchaseWatch && response.plan === 'paid' && (response.expiresAt ?? 0) > this.purchaseWatch.expiresAt) {
                this.purchaseWatch = undefined
                return true
            }
        } else if (response.status === 'expired' || response.status === 'local') {
            this.expiresAt = undefined
            this.plan = undefined
        }
        return false
    }

    private async snapshot (): Promise<Map<string, SSHCloudConnection>> {
        const profiles = await this.profiles.getProfiles({ includeBuiltin: false, clone: true })
        const connections = new Map<string, SSHCloudConnection>()
        for (const profile of profiles) {
            if (profile.type !== 'ssh' || profile.isBuiltin) {
                continue
            }
            const resolved = this.profiles.getConfigProxyForProfile<SSHProfile>(profile as PartialProfile<SSHProfile>)
            const { host, port, user, auth, proxyCommand, jumpHost, password } = resolved.options
            if (!profile.id || !host || !user || Boolean(proxyCommand) || Boolean(jumpHost) ||
                (auth && auth !== 'password' && auth !== 'keyboardInteractive')) {
                continue
            }
            connections.set(profile.id, {
                id: profile.id, name: profile.name, host, port, user, auth,
                password: await this.passwords.loadPassword(resolved) ?? (typeof password === 'string' ? password : null),
            })
        }
        return connections
    }

    private async apply (
        uploaded: Map<string, SSHCloudConnection>,
        previous: SSHCloudFingerprints,
        response: Extract<SSHCloudResult, { status: 'active' }>,
    ): Promise<void> {
        const current = await this.snapshot()
        const fingerprints = new Map(previous)
        const synchronized = new Map(response.fingerprints)
        let changed = false
        for (const connection of response.profiles) {
            const id = connection.id
            const existing = this.config.store.profiles.find(profile => profile.id === id)
            const local = current.get(id)
            if ((existing && !local) || (!existing && fingerprints.has(id)) ||
                JSON.stringify(uploaded.get(id)) !== JSON.stringify(local)) {
                continue
            }
            if (JSON.stringify(local) !== JSON.stringify(connection)) {
                await this.saveRemote(connection, existing, local)
                changed = true
            }
            fingerprints.set(id, synchronized.get(id)!)
        }
        const next = [...fingerprints]
        if (changed || JSON.stringify(next) !== JSON.stringify(previous)) {
            this.config.store.ssh.cloudFingerprints = next
            await this.config.save()
        }
    }

    private async saveRemote (connection: SSHCloudConnection, existing?: PartialProfile<SSHProfile>, local?: SSHCloudConnection): Promise<void> {
        const { id, name, host, port, user, auth, password } = connection
        const options = { ...existing?.options, host, port, user, auth }
        delete options.password
        const profile: PartialProfile<SSHProfile> = { ...existing, id, type: 'ssh', name, options }
        if (password !== null && (!local || password !== local.password || host !== local.host || port !== local.port || user !== local.user)) {
            await this.passwords.savePassword(this.profiles.getConfigProxyForProfile<SSHProfile>(profile), password)
        }
        if (existing) {
            await this.profiles.writeProfile(profile)
        } else {
            await this.profiles.newProfile(profile, { genId: false })
        }
    }
}
