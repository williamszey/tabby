import type { SSHCommandCollections } from './sshCommandHistory'
import { Observable, Subject } from 'rxjs'
import { Injector } from '@angular/core'
import { Logger, LogService } from '../services/log.service'
import { SSHCloudConnection, SSHCloudFingerprints, SSHCloudResult } from './sshCloudSync'

export enum Platform {
    Linux = 'Linux',
    macOS = 'macOS',
    Windows = 'Windows',
    Web = 'Web',
}

/**
 * Provides interaction with the main process
 */
export abstract class HostAppService {
    abstract get platform (): Platform
    abstract get configPlatform (): Platform

    protected settingsUIRequest = new Subject<void>()
    protected configChangeBroadcast = new Subject<void>()
    protected logger: Logger

    /**
     * Fired when Preferences is selected in the macOS menu
     */
    get settingsUIRequest$ (): Observable<void> { return this.settingsUIRequest }

    /**
     * Fired when another window modified the config file
     */
    get configChangeBroadcast$ (): Observable<void> { return this.configChangeBroadcast }

    constructor (
        injector: Injector,
    ) {
        this.logger = injector.get(LogService).create('hostApp')
    }

    abstract newWindow (): void

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    emitReady (): void { }

    abstract relaunch (): void

    async signIn (): Promise<void> {
        throw new Error('Signing in is unavailable')
    }

    async signOut (): Promise<void> {
        throw new Error('Signing out is unavailable')
    }

    async syncSSHConnections (_profiles?: SSHCloudConnection[], _fingerprints?: SSHCloudFingerprints): Promise<SSHCloudResult> {
        return { status: 'local' }
    }

    async sshRecentCommands (_profileId: string, _command?: string, _favorite?: boolean): Promise<SSHCommandCollections> {
        return { recent: [], favorites: [] }
    }

    async getSSHPassword (_key: string): Promise<string | null | undefined> {
        return undefined
    }

    async storeSSHPassword (_key: string, _password: string | null, _onlyIfMissing?: boolean): Promise<boolean> {
        return false
    }

    abstract quit (): void
}
