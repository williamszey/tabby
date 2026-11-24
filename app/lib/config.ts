import * as fs from 'fs'
import * as yaml from 'js-yaml'
import { writeFile } from 'atomically'


export function loadConfig (configPath: string): any {
    if (fs.existsSync(configPath)) {
        return yaml.load(fs.readFileSync(configPath, 'utf8')) ?? {}
    } else {
        return {}
    }
}

export async function saveConfig (configPath: string, content: string): Promise<void> {
    await writeFile(configPath, content, { encoding: 'utf8', mode: 0o600 })
    await writeFile(configPath + '.backup', content, { encoding: 'utf8', mode: 0o600 })
}
