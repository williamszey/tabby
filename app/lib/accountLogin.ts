import { app, BrowserWindow, ipcMain } from 'electron'
import * as path from 'path'
import { logMainError } from './errors'
import { AuthClient, LoginResult } from './authClient'

const channel = 'tabby-account:authenticate'

interface SignedInAccount {
    accountId: string
    importLocal: boolean
}

export class AccountLogin {
    readonly result: Promise<SignedInAccount | null>
    private window: BrowserWindow

    constructor (auth: AuthClient, parent: BrowserWindow, canImportLocal: boolean) {
        const assets = path.join(app.getAppPath(), 'assets', 'account-login')
        this.window = new BrowserWindow({
            title: 'TopperTerminal 登录',
            width: 480,
            height: canImportLocal ? 616 : 554,
            parent,
            modal: true,
            useContentSize: true,
            resizable: false,
            show: false,
            backgroundColor: '#101317',
            webPreferences: {
                preload: path.join(assets, 'preload.cjs'),
                partition: 'tabby-local-login',
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                devTools: false,
            },
        })
        const window = this.window
        window.setMenuBarVisibility(false)
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.webContents.on('will-navigate', event => event.preventDefault())
        window.webContents.on('will-attach-webview', event => event.preventDefault())
        window.once('ready-to-show', () => window.show())

        this.result = new Promise((resolve, reject) => {
            let submitting = false
            let authenticated = false
            ipcMain.handle(channel, async (event, mode: unknown, email: unknown, password: unknown, confirmation: unknown, importLocal: unknown): Promise<LoginResult> => {
                if (window.isDestroyed() || event.sender !== window.webContents ||
                    event.senderFrame?.parent !== null || submitting || authenticated) {
                    return 'unavailable'
                }
                if (mode === 'register' && (!password || password !== confirmation)) {
                    return 'invalid'
                }

                submitting = true
                try {
                    const result = await auth.authenticate(mode, email, password)
                    if (result.status === 'ok' && !window.isDestroyed()) {
                        authenticated = true
                        resolve({ accountId: result.accountId, importLocal: canImportLocal && importLocal === true })
                    }
                    return result.status
                } catch (error) {
                    logMainError('Account authentication request failed', error)
                    return 'error'
                } finally {
                    submitting = false
                }
            })

            window.on('close', event => {
                if (submitting) {
                    event.preventDefault()
                }
            })
            window.once('closed', () => {
                ipcMain.removeHandler(channel)
                resolve(null)
            })
            window.webContents.once('render-process-gone', () => {
                reject(new Error('The account login window closed unexpectedly'))
            })
            window.loadFile(path.join(assets, 'index.html'), { query: { importLocal: canImportLocal ? '1' : '0' } }).catch(error => {
                if (!window.isDestroyed()) {
                    reject(error)
                }
            })
        })
    }

    focus (): void {
        if (!this.window.isDestroyed() && this.window.isVisible()) {
            this.window.focus()
        }
    }

    close (): void {
        if (!this.window.isDestroyed()) {
            this.window.destroy()
        }
    }
}
