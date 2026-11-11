const { contextBridge, ipcRenderer } = require('electron');

const invoke = (name) => (...args) => ipcRenderer.invoke('see:' + name, ...args);
contextBridge.exposeInMainWorld('seeNow', {
  info: invoke('info'), sources: invoke('sources'), start: invoke('start'), stop: invoke('stop'),
  finish: invoke('finish'), question: invoke('question'), overlay: invoke('overlay'),
  showMain: invoke('showMain'), account: invoke('account'), signIn: invoke('signIn'),
  chooseAuth: invoke('chooseAuth'), signOut: invoke('signOut'), models: invoke('models'), setModel: invoke('setModel'),
  usage: invoke('usage'), speaking: invoke('speaking'), captureReady: invoke('captureReady'),
  frame: (payload) => ipcRenderer.send('see:frame', payload),
  level: (db) => ipcRenderer.send('see:level', db),
  audio: (payload) => ipcRenderer.send('see:audio', payload),
  listen: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('see:event', listener);
    return () => ipcRenderer.removeListener('see:event', listener);
  },
});
