// Registers main-process error logging - must be first so it catches import-time errors
import { logMainError } from './errors'

import { app, ipcMain, Menu, dialog } from 'electron'
import { execFile } from 'child_process'
import { mkdir } from 'fs/promises'
import * as path from 'path'

// set userData Path on portable version
import './portable'

// set defaults of environment variables
import 'dotenv/config'
process.env.TABBY_PLUGINS ??= ''
process.env.TABBY_CONFIG_DIRECTORY ??= app.getPath('userData')

process.setSourceMapsEnabled(true)
import './sentry'
import './lru'
import { parseArgs } from './cli'
import { Application, configureApplication } from './app'
import electronDebug from 'electron-debug'
import { loadConfig } from './config'
import { AuthClient } from './authClient'
import { AccountLogin } from './accountLogin'

const argv = parseArgs(process.argv, process.cwd())

if (!app.requestSingleInstanceLock()) {
    app.quit()
    app.exit(0)
}

try {
    configureApplication(loadConfig(path.join(process.env.TABBY_CONFIG_DIRECTORY!, 'config.yaml')))
} catch (err) {
    dialog.showErrorBox('Could not read config', err.message)
    app.exit(1)
}

process.mainModule = module

let accountLogin: AccountLogin | undefined = undefined
let application: Application | undefined = undefined
const pendingInvocations: { args: string[], cwd: string }[] = []
let started = false

function dispatchInvocation (args: string[], cwd: string): void {
    if (started && application) {
        application.handleSecondInstance(args, cwd).catch(error => logMainError('Failed to open invocation', error))
    } else {
        pendingInvocations.push({ args, cwd })
        accountLogin?.focus()
    }
}

// Register the product URL scheme without replacing the Tabby handler.
if (process.platform === 'linux') {
    // setAsDefaultProtocolClient runs `xdg-settings set default-url-scheme-handler`,
    // which in xdg-utils 1.1.3 also makes Tabby the text/html handler on GNOME-like desktops
    execFile('xdg-mime', ['default', process.env.CHROME_DESKTOP ?? 'topper-terminal.desktop', 'x-scheme-handler/topper-terminal'], () => null)
} else if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('topper-terminal', process.execPath, [process.argv[1]])
    }
} else {
    app.setAsDefaultProtocolClient('topper-terminal')
}

ipcMain.on('app:new-window', () => {
    application?.newWindow()
})

process.on('uncaughtException', err => {
    application?.broadcast('uncaughtException', err)
})

app.on('activate', () => {
    if (!started || !application) {
        accountLogin?.focus()
    } else if (!application.hasWindows()) {
        application.newWindow()
    } else {
        application.focus()
    }
})

// Handle URL scheme on macOS
app.on('open-url', (event, url) => {
    event.preventDefault()
    dispatchInvocation([url], process.cwd())
})

app.on('second-instance', (_event, newArgv, cwd) => {
    dispatchInvocation(newArgv, cwd)
})

app.on('ready', async () => {
    try {
        accountLogin = new AccountLogin(new AuthClient(process.env.TABBY_DEV ? process.env.TABBY_AUTH_BASE_URL : undefined))
        const accountId = await accountLogin.result
        if (!accountId) {
            app.quit()
            return
        }

        if (argv.d) {
            electronDebug({
                isEnabled: true,
                showDevTools: true,
                devToolsMode: 'undocked',
            })
        }

        const accountDirectory = path.join(process.env.TABBY_CONFIG_DIRECTORY!, 'accounts', accountId)
        await mkdir(accountDirectory, { recursive: true, mode: 0o700 })
        application = new Application(accountId, accountDirectory)
        if (process.platform === 'darwin') {
            app.dock?.setMenu(Menu.buildFromTemplate([
                { label: 'New window', click: () => application?.newWindow() },
            ]))
        }
        application.init()

        const opening = application.newWindow({ hidden: argv.hidden })
        accountLogin.close()
        accountLogin = undefined
        const window = await opening
        window.passCliArguments(process.argv, process.cwd(), false)
        window.focus()
        started = true
        for (const invocation of pendingInvocations.splice(0)) {
            dispatchInvocation(invocation.args, invocation.cwd)
        }
    } catch (err) {
        accountLogin?.close()
        logMainError('Failed to open window', err)
        dialog.showErrorBox('Topper Terminal failed to start', String(err?.stack ?? err))
        app.exit(1)
    }
})
