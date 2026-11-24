const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tabbyAccount', {
    authenticate: (mode, email, password, confirmation) => ipcRenderer.invoke('tabby-account:authenticate', mode, email, password, confirmation),
})
