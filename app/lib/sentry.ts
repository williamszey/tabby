const { init } = String(process.type) === 'main' ? require('@sentry/electron/dist/main') : require('@sentry/electron/dist/renderer')

const SENTRY_DSN = process.env.TOPPER_TERMINAL_SENTRY_DSN
let release = null
try {
    release = require('electron').app.getVersion()
} catch {
    release = require('@electron/remote').app.getVersion()
}

if (SENTRY_DSN && !process.env.TABBY_DEV) {
    init({
        dsn: SENTRY_DSN,
        release,
        integrations (integrations) {
            return integrations.filter(integration => integration.name !== 'Breadcrumbs')
        },
    })
}
