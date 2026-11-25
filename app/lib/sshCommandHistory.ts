import { randomBytes } from 'node:crypto'
import { applySSHCommandFavorites, isSSHRecentCommandText, mergeSSHRecentCommands } from '../../tabby-core/src/api/sshCommandHistory'
import type { SSHCommandCollections, SSHCommandHistory, SSHCommandHistorySnapshot } from '../../tabby-core/src/api/sshCommandHistory'
import { SSHCredentials } from './sshCredentials'

export class SSHCommandHistoryStore {
    private memory = new Map<string, SSHCommandHistorySnapshot>()
    private dirty = new Set<string>()
    private pending = Promise.resolve()

    constructor (private credentials: SSHCredentials) { }

    async get (profileId: string): Promise<SSHCommandCollections> {
        await this.pending
        return this.view(await this.load(profileId))
    }

    async update (profileId: string, command: unknown, favorite?: unknown): Promise<SSHCommandCollections> {
        if (!isSSHRecentCommandText(command) || (favorite !== undefined && typeof favorite !== 'boolean')) {
            return this.get(profileId)
        }
        const id = randomBytes(16).toString('hex')
        return this.modify(profileId, previous => {
            if (typeof favorite === 'boolean') {
                const edits = previous.edits.filter(edit => edit.command !== command)
                return { ...previous, edits: [...edits, { id, command, favorite }] }
            }
            return { ...previous, recent: mergeSSHRecentCommands(previous.recent, [{ id, command, enteredAt: Date.now() }]) }
        })
    }

    async snapshot (ids: string[]): Promise<SSHCommandHistory> {
        await this.pending
        const histories = await Promise.all(ids.map(async id => [id, await this.load(id)] as SSHCommandHistory[number]))
        return histories.filter(([, data]) => data.recent.length || data.favorites.length || data.edits.length)
    }

    async accept (profileId: string, data: SSHCommandHistorySnapshot): Promise<SSHCommandCollections> {
        const acknowledged = new Set(data.edits.map(edit => edit.id))
        return this.modify(profileId, previous => ({
            recent: mergeSSHRecentCommands(previous.recent, data.recent),
            favorites: data.favorites,
            edits: previous.edits.filter(edit => !acknowledged.has(edit.id)),
        }))
    }

    private async modify (
        profileId: string,
        change: (previous: SSHCommandHistorySnapshot) => SSHCommandHistorySnapshot,
    ): Promise<SSHCommandCollections> {
        const write = this.pending.then(async () => {
            const previous = await this.load(profileId)
            const next = change(previous)
            this.memory.set(profileId, next)
            if (JSON.stringify(next) !== JSON.stringify(previous) || this.dirty.has(profileId)) {
                this.dirty.add(profileId)
                if (await this.credentials.set(this.key(profileId), JSON.stringify(next), false).catch(() => false)) {
                    this.dirty.delete(profileId)
                }
            }
            return this.view(next)
        })
        this.pending = write.then(() => undefined, () => undefined)
        return write
    }

    private view (data: SSHCommandHistorySnapshot): SSHCommandCollections {
        return { recent: data.recent, favorites: applySSHCommandFavorites(data.favorites, data.edits) }
    }

    private async load (profileId: string): Promise<SSHCommandHistorySnapshot> {
        const cached = this.memory.get(profileId)
        if (cached) {
            return cached
        }
        const raw = await this.credentials.get(this.key(profileId)).catch(() => undefined)
        const entries: SSHCommandHistorySnapshot = raw ? JSON.parse(raw) : { recent: [], favorites: [], edits: [] }
        this.memory.set(profileId, entries)
        return entries
    }

    private key (profileId: string): string {
        return `topper-recent-commands:${profileId}`
    }
}
