export interface SSHRecentCommand {
    id: string
    command: string
    enteredAt: number
}

export interface SSHCommandCollections {
    recent: SSHRecentCommand[]
    favorites: string[]
}

export interface SSHCommandFavoriteEdit {
    command: string
    favorite: boolean
    id: string
}

export interface SSHCommandHistorySnapshot extends SSHCommandCollections {
    edits: SSHCommandFavoriteEdit[]
}

export type SSHCommandHistory = [profileId: string, commands: SSHCommandHistorySnapshot][]

export const maxSSHCommandFavorites = 30

export function applySSHCommandFavorites (base: string[], edits: SSHCommandFavoriteEdit[]): string[] {
    const favorites = new Set(base.filter(isSSHRecentCommandText).reverse())
    for (const { command, favorite } of edits) {
        favorites.delete(command)
        if (favorite && isSSHRecentCommandText(command)) {
            favorites.add(command)
        }
    }
    return [...favorites].slice(-maxSSHCommandFavorites).reverse()
}

export function isSSHRecentCommandText (value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 &&
        !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value) && new TextEncoder().encode(value).length <= 256
}

export function mergeSSHRecentCommands (...histories: SSHRecentCommand[][]): SSHRecentCommand[] {
    const entries = new Map<string, SSHRecentCommand>()
    for (const entry of histories.flat()) {
        if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{32}$/.test(entry.id) ||
            !Number.isSafeInteger(entry.enteredAt) || entry.enteredAt < 0 || !isSSHRecentCommandText(entry.command)) {
            continue
        }
        entries.set(entry.id, { id: entry.id, command: entry.command, enteredAt: entry.enteredAt })
    }
    return [...entries.values()].sort((a, b) => b.enteredAt - a.enteredAt || a.id.localeCompare(b.id)).slice(0, 10)
}
