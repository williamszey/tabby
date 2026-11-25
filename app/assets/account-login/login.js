const form = document.querySelector('form')
const heading = document.querySelector('#heading')
const description = document.querySelector('#description')
const email = document.querySelector('#email')
const password = document.querySelector('#password')
const passwordHint = document.querySelector('#password-hint')
const confirmation = document.querySelector('#confirm-password')
const confirmationField = document.querySelector('#confirmation-field')
const statusMessage = document.querySelector('#status')
const submit = document.querySelector('#submit')
const switchMode = document.querySelector('#switch-mode')
const modeHint = document.querySelector('#mode-hint')
const importChoice = document.querySelector('#import-choice')
const importLocal = document.querySelector('#import-local')
importChoice.hidden = new URLSearchParams(location.search).get('importLocal') !== '1'
const visibilityButtons = Array.from(document.querySelectorAll('.visibility'))
const fields = [email, password, confirmation]
let registering = false

function setPasswordVisibility (button, visible) {
    const field = document.getElementById(button.getAttribute('aria-controls'))
    const action = visible ? '隐藏' : '显示'
    field.type = visible ? 'text' : 'password'
    button.textContent = action
    button.setAttribute('aria-pressed', String(visible))
    button.setAttribute('aria-label', action + (field === confirmation ? '确认密码' : '密码'))
}

function resetPasswords () {
    password.value = confirmation.value = ''
    visibilityButtons.forEach(button => setPasswordVisibility(button, false))
}

function showStatus (message = '', invalidField) {
    statusMessage.textContent = message
    for (const field of fields) {
        if (field === invalidField) {
            field.setAttribute('aria-invalid', 'true')
            field.setAttribute('aria-errormessage', 'status')
        } else {
            field.removeAttribute('aria-invalid')
            field.removeAttribute('aria-errormessage')
        }
    }
    invalidField?.focus()
}

function setBusy (busy) {
    form.setAttribute('aria-busy', String(busy))
    submit.disabled = switchMode.disabled = importLocal.disabled = busy
    for (const field of fields) field.readOnly = busy
    for (const button of visibilityButtons) button.disabled = busy
    submit.textContent = registering ? (busy ? '正在创建账号…' : '注册并登录') : (busy ? '正在登录…' : '登录')
}

if (window.tabbyAccount) {
    setBusy(false)
} else {
    showStatus('无法加载登录功能，请重新启动 TopperTerminal。')
}

for (const button of visibilityButtons) {
    button.addEventListener('click', () => setPasswordVisibility(button, button.getAttribute('aria-pressed') !== 'true'))
}

form.addEventListener('input', () => {
    if (statusMessage.textContent) showStatus()
})

switchMode.addEventListener('click', () => {
    registering = !registering
    heading.textContent = registering ? '创建账号' : '登录终端'
    description.textContent = registering ? '注册即可免费试用 7 天 SSH 云同步。' : '登录后管理和连接你的 SSH 服务器。'
    password.autocomplete = registering ? 'new-password' : 'current-password'
    password.minLength = registering ? 12 : 1
    passwordHint.hidden = !registering
    if (registering) {
        password.setAttribute('aria-describedby', passwordHint.id)
    } else {
        password.removeAttribute('aria-describedby')
    }
    confirmationField.hidden = !registering
    confirmation.required = registering
    resetPasswords()
    showStatus()
    setBusy(false)
    modeHint.textContent = registering ? '已经有账号？' : '还没有账号？'
    switchMode.textContent = registering ? '返回登录' : '注册'
    email.focus()
})

form.addEventListener('submit', async event => {
    event.preventDefault()
    if (submit.disabled) return

    const address = email.value.trim()
    if (!address || email.validity.typeMismatch) {
        showStatus('请输入有效的邮箱地址。', email)
        return
    }
    if (!password.value || (registering && password.value.length < 12)) {
        showStatus(registering ? '请设置至少 12 个字符的密码。' : '请输入密码。', password)
        return
    }
    if (registering && password.value !== confirmation.value) {
        showStatus('两次输入的密码不一致。', confirmation)
        return
    }

    showStatus()
    setBusy(true)
    let result
    try {
        result = await window.tabbyAccount.authenticate(registering ? 'register' : 'login', address, password.value, registering ? confirmation.value : undefined, importLocal.checked)
    } catch {
        result = 'error'
    }

    resetPasswords()
    if (result === 'ok') {
        submit.textContent = '正在打开终端…'
        return
    }

    setBusy(false)
    const messages = {
        invalid: registering ? '请检查邮箱和密码格式。' : '邮箱或密码错误。',
        duplicate: '该邮箱已注册，可以返回登录。',
        limited: '尝试次数过多，请稍后重试。',
        error: '暂时无法连接登录服务，请重试。',
        storage: '无法安全保存登录状态，请检查系统凭据库。',
        unavailable: '登录服务暂不可用，请稍后重试。',
    }
    if (result === 'duplicate' || result === 'invalid') {
        showStatus(messages[result], result === 'duplicate' ? email : password)
    } else {
        showStatus(messages[result] ?? '请重试。')
        password.focus()
    }
})
