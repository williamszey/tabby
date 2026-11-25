const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tabbyAccount', {
    authenticate: (mode, email, password, confirmation, importLocal) => ipcRenderer.invoke('tabby-account:authenticate', mode, email, password, confirmation, importLocal),
})
