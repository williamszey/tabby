import { Inject, Injectable } from '@angular/core'
import { AppService, BOOTSTRAP_DATA, BootstrapData, Command, CommandLocation, CommandProvider } from 'tabby-core'
import { SSHConnectionsComponent } from './components/sshConnections.component'

@Injectable({ providedIn: 'root' })
export class SSHConnectionsCommand extends CommandProvider {
    constructor (
        private app: AppService,
        @Inject(BOOTSTRAP_DATA) private bootstrap: BootstrapData,
    ) {
        super()
    }

    open (): void {
        const open = this.app.tabs.find(tab => tab instanceof SSHConnectionsComponent)
        if (open) {
            this.app.selectTab(open)
        } else {
            this.app.openNewTabRaw({ type: SSHConnectionsComponent })
        }
    }

    async provide (): Promise<Command[]> {
        return this.bootstrap.accountId ? [{
            id: 'ssh:connections',
            label: 'SSH 连接',
            locations: [CommandLocation.LeftToolbar, CommandLocation.StartPage],
            icon: require('../../tabby-core/src/icons/profiles.svg'),
            run: async () => this.open(),
        }] : []
    }
}
