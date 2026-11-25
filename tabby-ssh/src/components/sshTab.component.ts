import * as russh from 'russh'
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { interval } from 'rxjs'
import { commandHistoryInitialization, commandHistoryOSC, looksLikeBashPrompt } from '../commandHistoryIntegration'
import { Component, Injector, HostBinding, HostListener } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { GetRecoveryTokenOptions, isSSHRecentCommandText, maxSSHCommandFavorites, Platform, ProfilesService, RecoveryToken, SSHCommandCollections } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { SSHService } from '../services/ssh.service'
import { KeyboardInteractivePrompt, SSHSession } from '../session/ssh'
import { SSHPortForwardingModalComponent } from './sshPortForwardingModal.component'
import { SSHProfile } from '../api'
import { SSHShellSession } from '../session/shell'
import { SSHMultiplexerService } from '../services/sshMultiplexer.service'

/** @hidden */
@Component({
    selector: 'ssh-tab',
    template: `${BaseTerminalTabComponent.template} ${require('./sshTab.component.pug')}`,
    styles: [
        ...BaseTerminalTabComponent.styles,
        require('./sshTab.component.scss'),
    ],
    animations: BaseTerminalTabComponent.animations,
})
export class SSHTabComponent extends ConnectableTerminalTabComponent<SSHProfile> {
    Platform = Platform
    sshSession: SSHSession|null = null
    session: SSHShellSession|null = null
    sftpPanelVisible = false
    sftpPath = '/'
    enableToolbar = true
    toolbarAlwaysPinned = true
    @HostBinding('class.command-history-visible') commandHistoryVisible = true
    commandCollections: SSHCommandCollections = { recent: [], favorites: [] }
    readonly maximumFavorites = maxSSHCommandFavorites
    historyEnabled = false
    commandHistoryTab: 'recent' | 'favorites' = 'recent'
    private historyNonce?: string
    private historyAutoAttempted = false
    private historyBootstrap?: { marker: string, output: string, timer: ReturnType<typeof setTimeout> }
    private shellAtPrompt = false
    private historyRequest = 0
    activeKIPrompt: KeyboardInteractivePrompt|null = null

    constructor (
        injector: Injector,
        public ssh: SSHService,
        private ngbModal: NgbModal,
        private profilesService: ProfilesService,
        private sshMultiplexer: SSHMultiplexerService,
    ) {
        super(injector)
        this.sessionChanged$.subscribe(() => {
            this.historyEnabled = false
            this.shellAtPrompt = false
            this.historyNonce = undefined
            this.historyAutoAttempted = false
            this.clearHistoryBootstrap()
            this.activeKIPrompt = null
        })
    }

    get commandHistoryAvailable (): boolean {
        return this.hostApp.platform !== Platform.Web && Boolean(this.profile?.id)
    }

    @HostBinding('class.command-history-collapsed')
    get commandHistoryCollapsed (): boolean {
        return this.commandHistoryAvailable && !this.commandHistoryVisible
    }

    ngOnInit (): void {
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput('\x1bOH' )
                    break
                case 'end':
                    this.sendInput('\x1bOF' )
                    break
                case 'restart-ssh-session':
                    this.reconnect()
                    break
                case 'launch-winscp':
                    if (this.sshSession) {
                        this.ssh.launchWinSCP(this.sshSession)
                    }
                    break
                case 'open-sftp':
                    this.openSFTP()
                    break
            }
        })

        this.commandHistoryVisible = this.commandHistoryAvailable
        if (this.commandHistoryVisible) {
            void this.updateCommandCollections()
            this.subscribeUntilDestroyed(interval(3000), () => {
                if (this.hasFocus && this.commandHistoryVisible) {
                    void this.updateCommandCollections()
                }
            })
        }
        super.ngOnInit()
    }

    protected onFrontendReady (): void {
        if (this.frontend instanceof XTermFrontend && this.commandHistoryAvailable) {
            const frontend = this.frontend
            const observer = frontend.xterm.onWriteParsed(() => this.enableHistoryAtShellPrompt(frontend))
            this.subscribeUntilDestroyed(this.input$, data => {
                if (data.length && !data.equals(Buffer.from('\x1b[I')) && !data.equals(Buffer.from('\x1b[O'))) {
                    this.historyAutoAttempted = true
                }
            })
            this.frontend.xterm.loadAddon({ activate: () => undefined, dispose: () => observer.dispose() })
            this.frontend.xterm.parser.registerOscHandler(commandHistoryOSC, data => {
                if (!this.historyNonce || !data.startsWith(`topper;${this.historyNonce};`)) {
                    return false
                }
                const event = data.slice(this.historyNonce.length + 8)
                if (event === 'prompt' || event === 'busy') {
                    this.zone.run(() => {
                        this.historyEnabled = true
                        this.shellAtPrompt = event === 'prompt'
                    })
                } else if (event.startsWith('command;') && /^command;[A-Za-z0-9+/=]{1,344}$/.test(event)) {
                    const command = Buffer.from(event.slice(8), 'base64').toString('utf8')
                    if (isSSHRecentCommandText(command)) {
                        this.zone.run(() => void this.updateCommandCollections(command))
                    }
                }
                return true
            })
        }
        super.onFrontendReady()
    }

    get canInsertCommand (): boolean {
        return Boolean(this.session?.open && this.frontend && !this.alternateScreenActive && !this.activeKIPrompt &&
            (!this.historyEnabled || this.shellAtPrompt))
    }

    private enableHistoryAtShellPrompt (frontend: XTermFrontend): void {
        if (this.historyAutoAttempted || this.historyEnabled || !this.canInsertCommand ||
            this.profile.options.scripts?.length || !frontend.supportsBracketedPaste()) {
            return
        }
        const buffer = frontend.xterm.buffer.active
        const line = buffer.getLine(buffer.baseY + buffer.cursorY)
        if (!line || line.isWrapped || !looksLikeBashPrompt(line.translateToString(false, 0, buffer.cursorX), this.profile.options.user)) {
            return
        }
        this.historyAutoAttempted = true
        const nonce = this.newHistoryNonce()
        const marker = `\x1b]${commandHistoryOSC};topper;${nonce};prompt\x07`
        const timer = setTimeout(() => {
            const pending = this.clearHistoryBootstrap()
            if (pending) {
                void this.write(pending.output)
            }
        }, 2500)
        this.historyBootstrap = { marker, output: '', timer }
        this.sendInput(`\x1b[200~ ${commandHistoryInitialization(nonce)}\x1b[201~\r`)
    }

    protected async writeRaw (data: string): Promise<void> {
        const pending = this.historyBootstrap
        if (!pending) {
            await super.writeRaw(data)
            return
        }
        pending.output += data
        const ready = pending.output.indexOf(pending.marker)
        if (ready >= 0) {
            this.clearHistoryBootstrap()
            await super.writeRaw('\r\x1b[2K' + pending.output.slice(ready))
        } else if (pending.output.length > 32_768) {
            this.clearHistoryBootstrap()
            await super.writeRaw(pending.output)
        }
    }

    private clearHistoryBootstrap (): { marker: string, output: string, timer: ReturnType<typeof setTimeout> } | undefined {
        const pending = this.historyBootstrap
        if (pending) {
            clearTimeout(pending.timer)
            this.historyBootstrap = undefined
        }
        return pending
    }

    private newHistoryNonce (): string {
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
        this.historyNonce = nonce
        return nonce
    }

    enableCommandHistory (): void {
        if (!this.canInsertCommand || this.historyBootstrap) {
            return
        }
        this.historyAutoAttempted = true
        this.fillCommandLine(commandHistoryInitialization(this.newHistoryNonce()))
    }

    insertRecentCommand (command: string): void {
        if (this.canInsertCommand && isSSHRecentCommandText(command)) {
            this.fillCommandLine(command)
        }
    }

    async setCommandFavorite (command: string, favorite: boolean): Promise<void> {
        await this.updateCommandCollections(command, favorite)
    }

    toggleCommandHistory (): void {
        this.commandHistoryVisible = !this.commandHistoryVisible
        if (this.commandHistoryVisible) {
            void this.updateCommandCollections()
        }
    }

    navigateCommandHistoryTabs (event: KeyboardEvent, recent: HTMLElement, favorites: HTMLElement): void {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        const showRecent = event.key === 'Home' || (event.key !== 'End' && this.commandHistoryTab === 'favorites')
        this.commandHistoryTab = showRecent ? 'recent' : 'favorites'
        const tab = showRecent ? recent : favorites
        tab.focus()
    }

    private fillCommandLine (command: string): void {
        this.frontend?.focus()
        this.sendInput(this.frontend?.supportsBracketedPaste() ? `\x1b[200~${command}\x1b[201~` : command)
    }

    private async updateCommandCollections (command?: string, favorite?: boolean): Promise<void> {
        if (!this.profile.id) {
            return
        }
        const request = ++this.historyRequest
        try {
            const collections = await this.hostApp.sshRecentCommands(this.profile.id, command, favorite)
            if (request === this.historyRequest) {
                this.commandCollections = collections
            }
        } catch {
            // A closing window can lose its IPC connection.
        }
    }

    async setupOneSession (injector: Injector, profile: SSHProfile, multiplex = true): Promise<SSHSession> {
        let session = await this.sshMultiplexer.getSession(profile)
        if (!multiplex || !session || !profile.options.reuseSession) {
            session = new SSHSession(injector, profile)

            if (profile.options.jumpHost) {
                const jumpConnection = (await this.profilesService.getProfiles()).find(x => x.id === profile.options.jumpHost)

                if (!jumpConnection) {
                    throw new Error(`${profile.options.host}: jump host "${profile.options.jumpHost}" not found in your config`)
                }

                // The non-multiplexed retry must not pick the same (possibly dead) jump connection from the cache again
                const jumpSession = await this.setupOneSession(
                    this.injector,
                    this.profilesService.getConfigProxyForProfile<SSHProfile>(jumpConnection),
                    multiplex,
                )

                jumpSession.ref()
                session.willDestroy$.subscribe(() => jumpSession.unref())
                jumpSession.willDestroy$.subscribe(() => {
                    if (session?.open) {
                        session.destroy()
                    }
                })

                if (!(jumpSession.ssh instanceof russh.AuthenticatedSSHClient)) {
                    throw new Error('Jump session is not authenticated yet somehow')
                }

                try {
                    session.jumpChannel = await jumpSession.ssh.openTCPForwardChannel({
                        addressToConnectTo: profile.options.host,
                        portToConnectTo: profile.options.port ?? 22,
                        originatorAddress: '127.0.0.1',
                        originatorPort: 0,
                    })
                } catch (err) {
                    // A failure on a reused connection is retried on a fresh one first
                    if (!multiplex) {
                        this.notifications.error(
                            this.translate.instant(_('Could not set up port forward on {host}'), { host: jumpConnection.name }),
                            err.toString(),
                        )
                    }
                    throw err
                }
            }
        }

        this.attachSessionHandler(session.serviceMessage$, msg => {
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
        })

        this.attachSessionHandler(session.willDestroy$, () => {
            this.activeKIPrompt = null
        })

        this.attachSessionHandler(session.keyboardInteractivePrompt$, prompt => {
            this.activeKIPrompt = prompt
            setTimeout(() => {
                this.frontend?.scrollToBottom()
            })
        })

        if (!session.open) {
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` Connecting to ${session.profile.name}\r\n`)

            this.startSpinner(this.translate.instant(_('Connecting')))

            try {
                await session.start()
            } finally {
                this.stopSpinner()
            }

            this.sshMultiplexer.addSession(session)
        }

        return session
    }

    protected onSessionDestroyed (): void {
        this.clearHistoryBootstrap()
        if (this.frontend) {
            // Session was closed abruptly
            this.write('\r\n' + colors.black.bgWhite(' SSH ') + ` ${this.sshSession?.profile.options.host}: session closed\r\n`)

            super.onSessionDestroyed()
        }
    }

    private async initializeSessionMaybeMultiplex (multiplex = true): Promise<void> {
        this.sshSession = await this.setupOneSession(this.injector, this.profile, multiplex)
        const session = new SSHShellSession(this.injector, this.sshSession, this.profile)

        this.setSession(session)
        this.attachSessionHandler(session.serviceMessage$, msg => {
            msg = msg.replace(/\n/g, '\r\n      ')
            this.write(`\r${colors.black.bgWhite(' SSH ')} ${msg}\r\n`)
            session.resize(this.size.columns, this.size.rows)
        })

        await session.start()

        this.session?.resize(this.size.columns, this.size.rows)
    }

    async initializeSession (): Promise<void> {
        await super.initializeSession()
        try {
            await this.initializeSessionMaybeMultiplex(true)
        } catch {
            try {
                await this.initializeSessionMaybeMultiplex(false)
            } catch (e) {
                console.error('SSH session initialization failed', e)
                this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
                return
            }
        }
    }

    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        const token = await super.getRecoveryToken(options)
        if (this.profile.options.rememberCwd) {
            const cwd = await this.session?.getWorkingDirectory() ?? this.profile.options.cwd
            if (cwd) {
                token.profile = {
                    ...token.profile,
                    options: {
                        ...token.profile.options,
                        cwd,
                    },
                }
            }
        }
        return token
    }

    showPortForwarding (): void {
        const modal = this.ngbModal.open(SSHPortForwardingModalComponent).componentInstance as SSHPortForwardingModalComponent
        modal.session = this.sshSession!
    }

    async canClose (): Promise<boolean> {
        if (!this.session?.open) {
            return true
        }
        if (!(this.profile.options.warnOnClose ?? this.config.store.ssh.warnOnClose)) {
            return true
        }
        return (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(_('Disconnect from {host}?'), this.profile.options),
                buttons: [
                    this.translate.instant(_('Disconnect')),
                    this.translate.instant(_('Do not close')),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )).response === 0
    }

    async openSFTP (): Promise<void> {
        this.sftpPath = await this.session?.getWorkingDirectory() ?? this.sftpPath
        setTimeout(() => {
            this.sftpPanelVisible = true
        }, 100)
    }

    @HostListener('click')
    onClick (): void {
        this.sftpPanelVisible = false
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated() ||
        this.recentInputs.charCodeAt(this.recentInputs.length - 1) === 4 ||
        this.recentInputs.endsWith('exit\r')
    }
}
