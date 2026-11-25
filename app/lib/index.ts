// Registers main-process error logging - must be first so it catches import-time errors
import { logMainError } from './errors'

import { app, BrowserWindow, ipcMain, Menu, dialog, session } from 'electron'
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
import { SSHCommandHistoryStore } from './sshCommandHistory'
import { SSHCredentials } from './sshCredentials'
import { hasLocalSSHProfiles, importLocalSSHProfiles, localWorkspaceDirectory } from './localWorkspace'

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

function relaunchWorkspace (): void {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    app.relaunch(portable ? { execPath: portable } : {})
    app.exit()
}

app.on('ready', async () => {
    try {
        const directory = process.env.TABBY_CONFIG_DIRECTORY!
        const origin = process.env.TABBY_DEV ? process.env.TABBY_AUTH_BASE_URL : undefined
        const auth = new AuthClient(directory, origin)
        const accountId = await auth.restoreSession()

        if (argv.d) {
            electronDebug({
                isEnabled: true,
                showDevTools: true,
                devToolsMode: 'undocked',
            })
        }

        const accountDirectory = accountId ? path.join(directory, 'accounts', accountId) : localWorkspaceDirectory(directory)
        await mkdir(accountDirectory, { recursive: true, mode: 0o700 })
        const credentials = new SSHCredentials(path.join(accountDirectory, 'ssh-credentials.bin'))
        await credentials.unlock().catch(() => console.warn('Could not unlock the SSH credential store'))
        application = new Application(accountId, accountDirectory, auth.accountEmail)
        const accountSession = session.fromPartition(application.sessionPartition)
        ipcMain.handle('app:ssh-credentials:get', (event, key) => {
            if (event.sender.session === accountSession && typeof key === 'string' && key.length <= 2048) {
                return credentials.get(key)
            }
            return undefined
        })
        ipcMain.handle('app:ssh-credentials:set', (event, key, password, onlyIfMissing) => {
            if (event.sender.session === accountSession && typeof key === 'string' && key.length <= 2048 &&
                (password === null || (typeof password === 'string' && password.length <= 16_384))) {
                return credentials.set(key, password, onlyIfMissing === true)
            }
            return false
        })
        const commandHistory = new SSHCommandHistoryStore(credentials)
        ipcMain.handle('app:ssh-recent-commands', (event, profileId, command, favorite) => {
            if (event.sender.session !== accountSession || typeof profileId !== 'string' ||
                !/^[^\u0000-\u001f]{1,256}$/.test(profileId)) {
                return { recent: [], favorites: [] }
            }
            return command === undefined ? commandHistory.get(profileId) : commandHistory.update(profileId, command, favorite)
        })
        let cloudSync = Promise.resolve()
        ipcMain.handle('app:ssh-cloud-sync', async (event, profiles, fingerprints) => {
            if (event.sender.session !== accountSession) {
                return { status: 'unavailable' }
            }
            if (!accountId) {
                return { status: 'local' }
            }
            const ids = Array.isArray(profiles) && profiles.length <= 200
                ? profiles.map(profile => profile?.id).filter(id => typeof id === 'string' && /^[^\u0000-\u001f]{1,256}$/.test(id))
                : []
            const sync = cloudSync.then(async () => {
                const history = await commandHistory.snapshot(ids)
                const result = await auth.syncSSHConnections(profiles, fingerprints, history)
                if (result.status === 'active' && result.history) {
                    for (const [id, commands] of result.history) {
                        await commandHistory.accept(id, commands)
                    }
                    delete result.history
                }
                return result
            })
            cloudSync = sync.then(() => undefined, () => undefined)
            return sync
        })
        ipcMain.handle('app:sign-in', async event => {
            if (event.sender.session !== accountSession || accountLogin) {
                return
            }
            const parent = BrowserWindow.fromWebContents(event.sender)
            if (!parent) {
                return
            }
            // Use a separate client so in-flight sync keeps using the current account during sign-in.
            const login = new AccountLogin(new AuthClient(directory, origin), parent, !accountId && hasLocalSSHProfiles(directory))
            accountLogin = login
            try {
                const result = await login.result
                if (!result) {
                    return
                }
                if (result.importLocal) {
                    try {
                        await importLocalSSHProfiles(directory, result.accountId)
                    } catch (error) {
                        logMainError('Could not import local SSH connections', error)
                        login.close()
                        await dialog.showMessageBox(parent, {
                            type: 'warning',
                            message: '本机 SSH 连接未能加入账号。',
                            detail: '登录仍会继续。本机连接可在退出登录后查看。',
                        })
                    }
                }
                relaunchWorkspace()
            } finally {
                login.close()
                accountLogin = undefined
            }
        })
        ipcMain.handle('app:sign-out', async event => {
            if (!accountId || event.sender.session !== accountSession || accountLogin) {
                return
            }
            const parent = BrowserWindow.fromWebContents(event.sender)
            if (!parent) {
                return
            }
            const result = await dialog.showMessageBox(parent, {
                type: 'question',
                message: '退出登录会关闭当前 SSH 会话，并回到本机模式。',
                buttons: ['取消', '退出登录'],
                defaultId: 0,
                cancelId: 0,
            })
            if (result.response === 1) {
                await auth.clearSession()
                relaunchWorkspace()
            }
        })
        if (process.platform === 'darwin') {
            app.dock?.setMenu(Menu.buildFromTemplate([
                { label: 'New window', click: () => application?.newWindow() },
            ]))
        }
        application.init()

        const window = await application.newWindow({ hidden: argv.hidden })
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
