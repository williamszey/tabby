const form = document.querySelector('form')
const email = document.querySelector('#email')
const password = document.querySelector('#password')
const confirmation = document.querySelector('#confirm-password')
const confirmationField = document.querySelector('#confirmation-field')
const statusMessage = document.querySelector('#status')
const submit = document.querySelector('#submit')
const switchMode = document.querySelector('#switch-mode')
let registering = false

if (window.tabbyAccount) {
    submit.disabled = false
    switchMode.disabled = false
} else {
    statusMessage.textContent = '无法加载登录功能，请重新启动 Topper Terminal。'
}

switchMode.addEventListener('click', () => {
    registering = !registering
    document.querySelector('h1').textContent = registering ? '创建账号' : '登录终端'
    document.querySelector('#description').textContent = registering ? '使用邮箱和至少 12 个字符的密码注册。' : '使用 Topper Terminal 账号登录。'
    password.autocomplete = registering ? 'new-password' : 'current-password'
    password.minLength = registering ? 12 : 1
    confirmationField.hidden = !registering
    confirmation.required = registering
    confirmation.minLength = registering ? 12 : 0
    password.value = confirmation.value = ''
    statusMessage.textContent = ''
    submit.textContent = registering ? '注册并登录' : '登录'
    switchMode.textContent = registering ? '返回登录' : '注册'
    email.focus()
})

form.addEventListener('submit', async event => {
    event.preventDefault()
    if (submit.disabled) {
        return
    }
    if (registering && password.value !== confirmation.value) {
        statusMessage.textContent = '两次输入的密码不一致。'
        confirmation.focus()
        return
    }
    submit.disabled = switchMode.disabled = true
    statusMessage.textContent = ''
    email.readOnly = password.readOnly = confirmation.readOnly = true
    let result
    try {
        result = await window.tabbyAccount.authenticate(registering ? 'register' : 'login', email.value, password.value, registering ? confirmation.value : undefined)
    } catch {
        result = 'error'
    }

    password.value = confirmation.value = ''
    if (result === 'ok') {
        submit.textContent = '正在打开终端…'
        return
    }
    statusMessage.textContent = {
        invalid: registering ? '请检查邮箱和密码格式。' : '邮箱或密码错误。',
        duplicate: '该邮箱已注册，请返回登录。',
        limited: '尝试次数过多，请稍后重试。',
        error: '暂时无法连接登录服务，请重试。',
    }[result] ?? '请重试。'
    email.readOnly = password.readOnly = confirmation.readOnly = false
    submit.disabled = switchMode.disabled = false
    password.focus()
})
