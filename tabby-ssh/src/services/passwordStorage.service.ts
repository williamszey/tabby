import * as keytar from 'keytar'
import { Inject, Injectable, Optional } from '@angular/core'
import { BOOTSTRAP_DATA, BootstrapData, HostAppService, localWorkspaceSSHKeyPrefix, Platform, VaultService } from 'tabby-core'
import { Subject } from 'rxjs'
import { SSHProfile } from '../api'

export const VAULT_SECRET_TYPE_PASSWORD = 'ssh:password'
export const VAULT_SECRET_TYPE_PASSPHRASE = 'ssh:key-passphrase'
const legacyMigrationMarker = 'legacy-ssh-passwords-migrated-v1'

@Injectable({ providedIn: 'root' })
export class PasswordStorageService {
    private keychainPrefix: string
    private migrateOnStartup: boolean
    private migration?: Promise<boolean>
    migrationStatus = ''
    private passwordChanged = new Subject<void>()
    readonly passwordChanged$ = this.passwordChanged.asObservable()

    constructor (
        private vault: VaultService,
        private host: HostAppService,
        @Optional() @Inject(BOOTSTRAP_DATA) bootstrapData?: BootstrapData,
    ) {
        this.keychainPrefix = bootstrapData?.localWorkspace ? localWorkspaceSSHKeyPrefix :
            bootstrapData?.accountId ? `tabby:${bootstrapData.accountId}:` : ''
        this.migrateOnStartup = !!bootstrapData?.accountId && host.platform === Platform.macOS
    }

    migrateLegacyPasswords (getProfiles: () => Promise<SSHProfile[]>): Promise<boolean> {
        if (!this.migrateOnStartup || this.vault.isEnabled()) {
            return Promise.resolve(false)
        }
        this.migration ??= this.runLegacyMigration(getProfiles).catch(() => {
            this.migrationStatus = '旧 SSH 密码迁移未完成，下次启动会重试。'
            return true
        })
        return this.migration
    }

    private async runLegacyMigration (getProfiles: () => Promise<SSHProfile[]>): Promise<boolean> {
        if (await this.host.getSSHPassword(legacyMigrationMarker) === null) {
            return true
        }

        const seen = new Set<string>()
        const searchedServices = new Set<string>()
        let inaccessible = 0
        for (const profile of await getProfiles()) {
            const { user, host } = profile.options
            if (!host) {
                continue
            }
            const service = this.getKeytarKeyForConnection(profile)
            const entry = JSON.stringify([service, user])
            if (searchedServices.has(service) || seen.has(entry) || (user && await this.host.getSSHPassword(entry) !== undefined)) {
                continue
            }
            seen.add(entry)
            this.migrationStatus = '正在迁移旧 SSH 密码，请在 macOS 弹窗中授权。'
            let credentials: { account: string, password: string }[] = []
            try {
                if (user) {
                    const password = await keytar.getPassword(service, user)
                    credentials = password === null ? [] : [{ account: user, password }]
                } else {
                    credentials = await keytar.findCredentials(service)
                    searchedServices.add(service)
                }
            } catch {
                inaccessible++
                continue
            }
            for (const { account, password } of credentials) {
                if (!await this.host.storeSSHPassword(JSON.stringify([service, account]), password, true)) {
                    this.migrationStatus = ''
                    return false
                }
            }
        }
        const complete = await this.host.storeSSHPassword(legacyMigrationMarker, null, true)
        this.migrationStatus = inaccessible ? '部分旧密码未能迁移，连接时可以重新输入 SSH 密码。' : ''
        return complete
    }

    async savePassword (profile: SSHProfile, password: string, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            await this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSWORD, key, value: password })
        } else {
            if (!account) {
                return
            }
            const key = this.getKeytarKeyForConnection(profile)
            if (!await this.host.storeSSHPassword(JSON.stringify([key, account]), password)) {
                await keytar.setPassword(key, account, password)
            }
        }
        this.passwordChanged.next()
    }

    async deletePassword (profile: SSHProfile, username?: string): Promise<void> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            await this.vault.removeSecret(VAULT_SECRET_TYPE_PASSWORD, key)
        } else {
            if (!account) {
                return
            }
            const key = this.getKeytarKeyForConnection(profile)
            await this.host.storeSSHPassword(JSON.stringify([key, account]), null)
            await keytar.deletePassword(key, account)
        }
    }

    async loadPassword (profile: SSHProfile, username?: string): Promise<string|null> {
        const account = username ?? profile.options.user
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForConnection(profile, account)
            return (await this.vault.getSecret(VAULT_SECRET_TYPE_PASSWORD, key))?.value ?? null
        } else {
            if (!account) {
                return null
            }
            const key = this.getKeytarKeyForConnection(profile)
            try {
                const migrated = this.migrateOnStartup && (await this.migration ?? true)
                const entry = JSON.stringify([key, account])
                const stored = await this.host.getSSHPassword(entry)
                if (stored !== undefined) {
                    return stored
                }
                if (migrated) {
                    return null
                }
                const password = await keytar.getPassword(key, account)
                if (password !== null) {
                    await this.host.storeSSHPassword(entry, password, true).catch(() => false)
                }
                return password
            } catch (e) {
                console.warn(`Failed to load stored password for ${account}@${profile.options.host}:${profile.options.port ?? 22}`, e)
                return null
            }
        }
    }

    async savePrivateKeyPassword (id: string, password: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            this.vault.addSecret({ type: VAULT_SECRET_TYPE_PASSPHRASE, key, value: password })
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            return keytar.setPassword(key, 'user', password)
        }
    }

    async deletePrivateKeyPassword (id: string): Promise<void> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            this.vault.removeSecret(VAULT_SECRET_TYPE_PASSPHRASE, key)
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            await keytar.deletePassword(key, 'user')
        }
    }

    async loadPrivateKeyPassword (id: string): Promise<string|null> {
        if (this.vault.isEnabled()) {
            const key = this.getVaultKeyForPrivateKey(id)
            return (await this.vault.getSecret(VAULT_SECRET_TYPE_PASSPHRASE, key))?.value ?? null
        } else {
            const key = this.getKeytarKeyForPrivateKey(id)
            return keytar.getPassword(key, 'user')
        }
    }

    private getKeytarKeyForConnection (profile: SSHProfile): string {
        let key = `ssh@${profile.options.host}`
        if (profile.options.port) {
            key = `ssh@${profile.options.host}:${profile.options.port}`
        }
        return `${this.keychainPrefix}${key}`
    }

    private getKeytarKeyForPrivateKey (id: string): string {
        return `${this.keychainPrefix}ssh-private-key:${id}`
    }

    private getVaultKeyForConnection (profile: SSHProfile, username?: string) {
        return {
            user: username ?? profile.options.user,
            host: profile.options.host,
            port: profile.options.port,
        }
    }

    private getVaultKeyForPrivateKey (id: string) {
        return { hash: id }
    }
}
