import { Component, Injector } from '@angular/core'
import { BaseTabComponent, HostAppService, PartialProfile, ProfilesService } from 'tabby-core'
import { SSHProfile } from '../api'
import { PasswordStorageService } from '../services/passwordStorage.service'

interface ConnectionFields {
    name: string
    host: string
    port: number | null
    user: string
    password: string
}

function profileText (value: unknown): string {
    return typeof value === 'string' ? value : ''
}

@Component({
    templateUrl: './sshConnections.component.pug',
    styleUrls: ['./sshConnections.component.scss'],
})
export class SSHConnectionsComponent extends BaseTabComponent {
    connections: PartialProfile<SSHProfile>[] = []
    selected: PartialProfile<SSHProfile> | null = null
    fields: ConnectionFields | null = null
    saving = false
    error = ''
    message = ''

    constructor (
        injector: Injector,
        private profiles: ProfilesService,
        private passwordStorage: PasswordStorageService,
        public host: HostAppService,
    ) {
        super(injector)
        this.setTitle('SSH 连接')
        this.icon = 'fas fa-server'
        this.subscribeUntilDestroyed(this.config.changed$, () => this.refresh())
    }

    async ngOnInit (): Promise<void> {
        await this.refresh()
    }

    select (profile: PartialProfile<SSHProfile>): void {
        if (this.saving || this.selected?.id === profile.id) {
            return
        }
        this.selected = profile
        this.fields = { name: profile.name, ...this.endpoint(profile), password: '' }
        this.error = this.message = ''
    }

    add (): void {
        this.selected = null
        this.fields = { name: '', host: '', port: 22, user: '', password: '' }
        this.error = this.message = ''
    }

    address (profile: PartialProfile<SSHProfile>): string {
        const { host, port, user } = this.endpoint(profile)
        const displayHost = host.includes(':') ? `[${host}]` : host
        return `${user ? `${user}@` : ''}${displayHost || '代理连接'}:${port}`
    }

    async connect (profile: PartialProfile<SSHProfile>): Promise<void> {
        try {
            await this.profiles.launchProfile(profile)
        } catch {
            this.error = '无法打开 SSH 连接。'
        }
    }

    async save (): Promise<void> {
        if (!this.fields || this.saving) {
            return
        }

        const { name, host, port, user, password } = this.fields
        const address = host.trim()
        const username = user.trim()
        this.error = this.message = ''
        if ((!address && !this.selected?.options?.proxyCommand) || !username ||
            port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
            this.error = '请输入服务器地址、用户名和有效端口（1–65535）。'
            return
        }

        const original = this.selected ? { ...this.selected, options: { ...this.selected.options } } : null
        const options = { ...original?.options, host: address, port, user: username }
        if (password) {
            options.auth = 'password'
            delete options.password
        }
        const connection: PartialProfile<SSHProfile> = {
            ...original, type: 'ssh', name: name.trim() || address || username, options,
        }

        this.saving = true
        try {
            if (password) {
                const profile = this.profiles.getConfigProxyForProfile<SSHProfile>(connection)
                await this.passwordStorage.savePassword(profile, password)
            }

            if (original) {
                await this.profiles.writeProfile(connection)
            } else {
                await this.profiles.newProfile(connection)
            }
            try {
                await this.config.save()
            } catch (error) {
                if (original) {
                    await this.profiles.writeProfile(original)
                } else {
                    this.config.store.profiles = this.config.store.profiles.filter(item => item.id !== connection.id)
                }
                throw error
            }
            await this.refresh()
            this.selected = this.connections.find(profile => profile.id === connection.id) ?? null
            this.fields = { name: connection.name, host: address, port, user: username, password: '' }
            this.message = '连接已保存。'
        } catch (error) {
            this.error = '保存失败，请检查系统凭据库和配置目录。'
            console.error('Could not save SSH connection:', error)
        } finally {
            this.saving = false
        }
    }

    async signOut (): Promise<void> {
        try {
            await this.host.signOut()
        } catch {
            this.error = '暂时无法退出登录。'
        }
    }

    private async refresh (): Promise<void> {
        this.connections = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true }))
            .filter((profile): profile is PartialProfile<SSHProfile> => profile.type === 'ssh' && !profile.isBuiltin)
    }

    private endpoint (profile: PartialProfile<SSHProfile>): { host: string, port: number, user: string } {
        const { host, port, user } = this.profiles.getConfigProxyForProfile<SSHProfile>(profile).options
        return { host: profileText(host), port: Number.isInteger(port) ? port : 22, user: profileText(user) }
    }
}
