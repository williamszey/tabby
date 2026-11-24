import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toElectronAccelerator } from '../src/globalHotkey.ts'
import { getKeyName, getKeystrokeName, isDisabledWindowHotkey } from '../../tabby-core/src/services/hotkeys.util.ts'

test('recorded non-US Backquote keys produce a valid punctuation accelerator', () => {
    for (const key of ['§', 'œ', '²', 'Dead']) {
        const name = getKeyName({ key, code: 'Backquote', eventName: 'keydown', time: 1, registrationTime: 1 })
        assert.equal(name, 'Backquote')
        const recorded = getKeystrokeName(['Ctrl', name])
        assert.equal(recorded, 'Ctrl-Backquote')
        assert.equal(toElectronAccelerator(recorded), 'Ctrl+`')
    }
})

test('supports existing Backquote bindings with either separator', () => {
    assert.equal(toElectronAccelerator('Backquote'), '`')
    assert.equal(toElectronAccelerator('Ctrl-Shift-Backquote'), 'Ctrl+Shift+`')
    assert.equal(toElectronAccelerator('Ctrl+Backquote'), 'Ctrl+`')
})

test('preserves US backquote, tilde, and modifier aliases', () => {
    assert.equal(toElectronAccelerator('Ctrl-`'), 'Ctrl+`')
    assert.equal(toElectronAccelerator('⌘-⌥-~'), 'Command+Alt+~')
    assert.equal(toElectronAccelerator('Meta-Space'), 'Super+Space')
})

test('keeps ordinary global shortcuts unchanged', () => {
    assert.equal(toElectronAccelerator('Ctrl-Space'), 'Ctrl+Space')
    assert.equal(toElectronAccelerator('Ctrl-Shift-F12'), 'Ctrl+Shift+F12')
    assert.equal(toElectronAccelerator('⌘-Enter'), 'Command+Enter')
})

test('blocks only Control-Space accelerator variants from the global window toggle', () => {
    for (const shortcut of ['Ctrl-Space', 'Control+Space', '⌃-Space', ' Control + Spacebar ']) {
        assert.equal(isDisabledWindowHotkey(shortcut, 'darwin'), true)
    }
    assert.equal(isDisabledWindowHotkey('CommandOrControl+Space', 'win32'), true)
    assert.equal(isDisabledWindowHotkey('CommandOrControl+Space', 'darwin'), false)
    assert.equal(isDisabledWindowHotkey('Ctrl+Shift+Space', 'darwin'), false)
    assert.equal(isDisabledWindowHotkey('Ctrl+Shift+F9', 'darwin'), false)
})
