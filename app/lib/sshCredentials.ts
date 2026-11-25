import { safeStorage } from 'electron'
import { readFile } from 'node:fs/promises'
import { writeFile } from 'atomically'

export class SSHCredentials {
    private entries?: Map<string, string | null>
    private pending = Promise.resolve()

    constructor (private file: string) { }

    get available (): boolean {
        return safeStorage.isEncryptionAvailable() &&
            (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
    }

    async unlock (): Promise<void> {
        if (!this.available || this.entries) {
            return
        }
        const encrypted = await readFile(this.file).catch(error => {
            if (error.code === 'ENOENT') {
                return null
            }
            throw error
        })
        const entries: [string, string | null][] = encrypted ? JSON.parse(safeStorage.decryptString(encrypted)) : []
        this.entries = new Map(entries)
    }

    async get (key: string): Promise<string | null | undefined> {
        if (!this.available) {
            return undefined
        }
        await this.pending
        await this.unlock()
        return this.entries?.get(key)
    }

    async set (key: string, password: string | null, onlyIfMissing: boolean): Promise<boolean> {
        if (!this.available) {
            return false
        }
        const write = this.pending.then(async () => {
            await this.unlock()
            if (onlyIfMissing && this.entries?.has(key)) {
                return
            }
            const entries = new Map(this.entries)
            entries.set(key, password)
            const encrypted = safeStorage.encryptString(JSON.stringify([...entries]))
            await writeFile(this.file, encrypted, { mode: 0o600 })
            this.entries = entries
        })
        this.pending = write.catch(() => undefined)
        await write
        return true
    }
}
