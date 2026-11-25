import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'

import TabbyCorePlugin from 'tabby-core'

import { PluginsSettingsTabComponent } from './components/pluginsSettingsTab.component'
import { PluginManagerService } from './services/pluginManager.service'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCorePlugin,
    ],
    declarations: [
        PluginsSettingsTabComponent,
    ],
})
export default class PluginManagerModule { } // eslint-disable-line @typescript-eslint/no-extraneous-class

export { PluginManagerService }
