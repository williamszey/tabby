import { Component, Inject, Injector } from '@angular/core'
import { BaseTabComponent, BOOTSTRAP_DATA, BootstrapData, HostAppService, PartialProfile, PlatformService, ProfilesService } from 'tabby-core'
import { SSHProfile } from '../api'
import { PasswordStorageService } from '../services/passwordStorage.service'
import { SSHCloudSyncService } from '../services/sshCloudSync.service'

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
    passwordVisible = false
    passwordPreview: string | null = null
    passwordStatus = ''
    saving = false
    error = ''
    message = ''
    readonly accountEmail?: string
    readonly signedIn: boolean
    openingLogin = false
    private passwordLookup: Promise<string | null> | null = null

    constructor (
        injector: Injector,
        private profiles: ProfilesService,
        public passwordStorage: PasswordStorageService,
        public host: HostAppService,
        public cloud: SSHCloudSyncService,
        private platformService: PlatformService,
        @Inject(BOOTSTRAP_DATA) bootstrap: BootstrapData,
    ) {
        super(injector)
        this.accountEmail = bootstrap.accountEmail
        this.signedIn = Boolean(bootstrap.accountId)
        this.setTitle('SSH 连接')
        this.icon = 'fas fa-server'
        this.subscribeUntilDestroyed(this.config.changed$, () => this.refresh())
        this.subscribeUntilDestroyed(this.blurred$, () => this.hidePassword())
    }

    async ngOnInit (): Promise<void> {
        await this.refresh()
    }

    async openShop (): Promise<void> {
        try {
            await this.platformService.openExternal('https://www.topperapi.com/TopperTerminal/shop')
            this.cloud.watchPurchase()
        } catch {
            this.error = '无法打开套餐页面。'
        }
    }

    select (profile: PartialProfile<SSHProfile>): void {
        if (this.saving || this.selected?.id === profile.id) {
            return
        }
        this.selected = profile
        this.fields = { name: profile.name, ...this.endpoint(profile), password: '' }
        this.hidePassword()
        this.error = this.message = ''
    }

    add (): void {
        this.selected = null
        this.fields = { name: '', host: '', port: 22, user: '', password: '' }
        this.hidePassword()
        this.error = this.message = ''
    }

    async togglePassword (): Promise<void> {
        if (this.passwordVisible) {
            this.hidePassword()
            return
        }

        this.passwordVisible = true
        const fields = this.fields
        const selected = this.selected
        if (!fields || fields.password || !selected) {
            return
        }

        const { host, port, user } = this.endpoint(selected)
        if (host !== fields.host.trim() || port !== fields.port || user !== fields.user.trim()) {
            return
        }

        const profile = this.profiles.getConfigProxyForProfile<SSHProfile>(selected)
        const lookup = this.passwordLookup = this.passwordStorage.loadPassword(profile, user)
        try {
            const password = await lookup
            if (this.passwordLookup === lookup) {
                this.passwordPreview = password ?? (profileText(profile.options.password) || null)
                this.passwordStatus = this.passwordPreview === null ? '没有已保存的密码。' : ''
            }
        } catch {
            if (this.passwordLookup === lookup) {
                this.passwordStatus = '无法读取已保存的密码。'
            }
        }
    }

    hidePassword (): void {
        this.passwordVisible = false
        this.clearPasswordPreview()
    }

    clearPasswordPreview (): void {
        this.passwordLookup = null
        this.passwordPreview = null
        this.passwordStatus = ''
    }

    address (profile: PartialProfile<SSHProfile>): string {
        const { host, port, user } = this.endpoint(profile)
        const displayHost = host.includes(':') ? `[${host}]` : host
        return `${user ? `${user}@` : ''}${displayHost || '代理连接'}:${port}`
    }

    async connect (profile: PartialProfile<SSHProfile>): Promise<void> {
        try {
            const saved = this.connections.find(item => item.id === profile.id) ?? profile
            await this.profiles.launchProfile(saved)
        } catch {
            this.error = '无法打开 SSH 连接。'
        }
    }

    async save (): Promise<void> {
        if (!this.fields || this.saving) {
            return
        }

        const fields = this.fields
        this.hidePassword()
        this.error = this.message = ''
        this.saving = true
        try {
            await this.cloud.editProfiles(() => this.saveFields(fields))
        } catch (error) {
            this.error = '保存失败，请检查系统凭据库和配置目录。'
            console.error('Could not save SSH connection:', error)
        } finally {
            this.saving = false
        }
    }

    private async saveFields (fields: ConnectionFields): Promise<void> {
        const { name, host, port, user, password } = fields
        const address = host.trim()
        const username = user.trim()
        const selected = this.selected
        const latest = selected ? this.config.store.profiles.find(profile => profile.id === selected.id) as PartialProfile<SSHProfile> | undefined : undefined
        if (selected && !latest) {
            this.error = '这条连接已被移除，请重新选择。'
            return
        }
        if ((!address && !latest?.options?.proxyCommand) || !username ||
            port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
            this.error = '请输入服务器地址、用户名和有效端口（1–65535）。'
            return
        }

        const original = latest ? { ...latest, options: { ...latest.options } } : null
        const initial = selected && this.endpoint(selected)
        const current = original && this.endpoint(original)
        const endpointChanged = Boolean(password) || !initial || initial.host !== address || initial.port !== port || initial.user !== username
        const draft = { host: address, port, user: username }
        const target = endpointChanged ? draft : current ?? draft
        const options = { ...original?.options, ...target }
        if (current && (current.host !== target.host || current.port !== target.port || current.user !== target.user)) {
            delete options.password
        }
        if (password) {
            options.auth = 'password'
            delete options.password
        }
        const chosenName = (original && name === selected?.name ? original.name : name.trim()) || target.host || target.user
        const connection: PartialProfile<SSHProfile> = {
            ...original, type: 'ssh', name: chosenName, options,
        }

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
        this.fields = { name: connection.name, ...target, password: '' }
        this.message = '连接已保存。'
    }

    async signIn (): Promise<void> {
        this.openingLogin = true
        try {
            await this.host.signIn()
        } catch {
            this.error = '暂时无法打开登录窗口。'
        } finally {
            this.openingLogin = false
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
