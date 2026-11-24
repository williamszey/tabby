import { Arch, build, Platform } from 'electron-builder'

const mac = process.platform === 'darwin'
if (!mac && process.platform !== 'win32') {
    throw new Error('Build the macOS and Windows installers on their respective platforms')
}

const version = process.env.TOPPER_TERMINAL_VERSION ?? '1.0.0-beta.4'
const arch = process.arch === 'arm64' ? Arch.arm64 : Arch.x64
const config = {
    extends: './electron-builder.yml',
    extraMetadata: { version },
    publish: null,
}

if (process.env.TOPPER_TERMINAL_ELECTRON_DIST) {
    config.electronDist = process.env.TOPPER_TERMINAL_ELECTRON_DIST
}

if (mac) {
    const release = process.env.TOPPER_TERMINAL_SIGN === '1'
    config.forceCodeSigning = release
    config.mac = release ? { notarize: true } : { identity: '-', hardenedRuntime: false, notarize: false }
} else {
    config.forceCodeSigning = process.env.TOPPER_TERMINAL_SIGN === '1'
}

await build({
    config,
    targets: mac ? Platform.MAC.createTarget('dmg', arch) : Platform.WINDOWS.createTarget('nsis', arch),
    publish: 'never',
})
