import { Inject, Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { LinkHandler } from './api'

// The xterm addon and OSC 8 handler both report this buffer range.
// eslint-disable-next-line @typescript-eslint/no-type-alias
type LinkRange = Parameters<NonNullable<XTermFrontend['xterm']['options']['linkHandler']>['activate']>[2]

function parseURL (uri: string): URL|null {
    try {
        return new URL(uri)
    } catch {
        return null
    }
}

@Injectable()
export class LinkHighlighterDecorator extends TerminalDecorator {
    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        @Inject(LinkHandler) private handlers: LinkHandler[],
    ) {
        super()
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        if (!(tab.frontend instanceof XTermFrontend)) {
            // not xterm
            return
        }

        const frontend = tab.frontend
        const xterm = frontend.xterm
        const element = xterm.element
        if (!element) {
            return
        }

        let hovered: LinkRange | undefined = undefined
        const screen = element.querySelector('.xterm-screen')
        const highlight = document.createElement('div')
        highlight.className = 'tabby-link-highlight'
        screen?.append(highlight)
        const repaint = () => {
            highlight.replaceChildren()
            if (!hovered) {
                return
            }

            const { viewportY } = xterm.buffer.active
            const firstRow = Math.max(hovered.start.y, viewportY + 1)
            const lastRow = Math.min(hovered.end.y, viewportY + xterm.rows)
            for (let row = firstRow; row <= lastRow; row++) {
                const start = row === hovered.start.y ? hovered.start.x - 1 : 0
                const end = row === hovered.end.y ? hovered.end.x : xterm.cols
                const tint = document.createElement('span')
                tint.style.left = `${100 * start / xterm.cols}%`
                tint.style.top = `${100 * (row - viewportY - 1) / xterm.rows}%`
                tint.style.width = `${100 * (end - start) / xterm.cols}%`
                tint.style.height = `${100 / xterm.rows}%`
                highlight.append(tint)
            }
        }
        const updateCursor = (event: MouseEvent | KeyboardEvent) => {
            element.classList.toggle('tabby-link-can-open', !!hovered && this.hasModifier(event))
        }
        const hover = (event: MouseEvent, _uri: string, range: LinkRange) => {
            hovered = range
            updateCursor(event)
            repaint()
        }
        const leave = () => {
            hovered = undefined
            element.classList.remove('tabby-link-can-open')
            repaint()
        }
        frontend.isLinkActivationClick = event => !!hovered && this.willHandleEvent(event)
        element.classList.add('tabby-link-modifier')
        window.addEventListener('keydown', updateCursor, true)
        window.addEventListener('keyup', updateCursor, true)
        window.addEventListener('blur', leave)
        xterm.loadAddon({
            activate: () => undefined,
            dispose: () => {
                window.removeEventListener('keydown', updateCursor, true)
                window.removeEventListener('keyup', updateCursor, true)
                window.removeEventListener('blur', leave)
                highlight.remove()
                frontend.isLinkActivationClick = undefined
                element.classList.remove('tabby-link-modifier', 'tabby-link-can-open')
            },
        })

        xterm.options.linkHandler = {
            allowNonHttpProtocols: true,
            hover,
            leave,
            activate: (event, uri) => {
                if (!this.willHandleEvent(event)) {
                    return
                }
                const url = parseURL(uri)
                if (!url) {
                    return
                }
                // A file: URL with a host is a UNC path - opening it would reach out
                // over SMB to a server the remote side chose. Only allow local files.
                const isLocalFile = url.protocol === 'file:' && !url.host
                if (!['http:', 'https:'].includes(url.protocol) && !isLocalFile) {
                    return
                }
                this.platform.openExternal(url.href)
            },
        }

        const openLink = async uri => {
            for (const handler of this.handlers) {
                if (!handler.fullMatchRegex.test(uri)) {
                    continue
                }
                if (!await handler.verify(await handler.convert(uri, tab), tab)) {
                    continue
                }
                handler.handle(await handler.convert(uri, tab), tab)
                return
            }
        }

        let regex = new RegExp('')
        const regexSource = this.handlers.map(x => `(${x.regex.source})`).join('|')
        try {
            regex = new RegExp(regexSource)
            console.debug('Linkifier regexp', regex)
        } catch (error) {
            console.error('Could not build regex for your link handlers:', error)
            console.error('Regex source was:', regexSource)
            return
        }

        const addon = new WebLinksAddon(
            async (event, uri) => {
                if (!this.willHandleEvent(event)) {
                    return
                }
                openLink(uri)
            },
            {
                urlRegex: regex,
                hover,
                leave,
            },
        )

        xterm.loadAddon(addon)
    }

    private willHandleEvent (event: MouseEvent): boolean {
        return event.button === 0 && this.hasModifier(event)
    }

    private hasModifier (event: MouseEvent | KeyboardEvent): boolean {
        const modifier = this.config.store.clickableLinks.modifier
        return !modifier || event[modifier]
    }
}
