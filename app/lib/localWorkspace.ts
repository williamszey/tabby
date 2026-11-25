import { mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { localWorkspaceSSHKeyPrefix } from '../../tabby-core/src/api/localWorkspace'
import { loadConfig, saveConfig } from './config'
import { SSHCredentials } from './sshCredentials'

export function localWorkspaceDirectory (directory: string): string {
    return path.join(directory, 'local-workspace')
}

interface LocalSSHProfile {
    id: string
    type: 'ssh'
    name: string
    options?: { host?: string, port?: number, user?: string }
}

function localProfiles (config: any): LocalSSHProfile[] {
    if (!Array.isArray(config.profiles)) {
        return []
    }
    return config.profiles.filter(profile => profile?.type === 'ssh' && !profile.isBuiltin &&
        typeof profile.id === 'string' && /^[^\u0000-\u001f]{1,256}$/.test(profile.id) && typeof profile.name === 'string')
}

export function hasLocalSSHProfiles (directory: string): boolean {
    const config = loadConfig(path.join(localWorkspaceDirectory(directory), 'config.yaml'))
    return localProfiles(config).length > 0
}

export async function importLocalSSHProfiles (directory: string, accountId: string): Promise<void> {
    const localDirectory = localWorkspaceDirectory(directory)
    const accountDirectory = path.join(directory, 'accounts', accountId)
    const local = loadConfig(path.join(localDirectory, 'config.yaml'))
    const targetPath = path.join(accountDirectory, 'config.yaml')
    const account = loadConfig(targetPath)
    if (local.encrypted || account.encrypted) {
        throw new Error('Encrypted workspace configuration must be opened before importing')
    }
    account.profiles ??= []
    if (!Array.isArray(account.profiles)) {
        throw new Error('Invalid account workspace profiles')
    }
    const ids = new Set(account.profiles.map(profile => profile?.id))
    const profiles = localProfiles(local).filter(profile => {
        if (ids.has(profile.id)) {
            return false
        }
        ids.add(profile.id)
        return true
    })
    if (!profiles.length) {
        return
    }

    await mkdir(accountDirectory, { recursive: true, mode: 0o700 })
    const localCredentials = new SSHCredentials(path.join(localDirectory, 'ssh-credentials.bin'))
    const accountCredentials = new SSHCredentials(path.join(accountDirectory, 'ssh-credentials.bin'))
    for (const profile of profiles) {
        const { host, port, user } = profile.options ?? {}
        if (typeof host === 'string' && typeof user === 'string' && host && user) {
            const endpoint = `ssh@${host}${port ? `:${port}` : ''}`
            const password = await localCredentials.get(JSON.stringify([localWorkspaceSSHKeyPrefix + endpoint, user]))
            if (typeof password === 'string') {
                const key = JSON.stringify([`tabby:${accountId}:${endpoint}`, user])
                await accountCredentials.set(key, password, true)
            }
        }
        const key = `topper-recent-commands:${profile.id}`
        const commands = await localCredentials.get(key)
        if (typeof commands === 'string') {
            await accountCredentials.set(key, commands, true)
        }
    }
    account.profiles.push(...profiles)
    await saveConfig(targetPath, yaml.dump(account))
}
