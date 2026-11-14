const { contextBridge, ipcRenderer } = require('electron');

// 渲染进程据此判断是否要给 macOS 的红绿灯留位置。
contextBridge.exposeInMainWorld('electronPlatform', process.platform);

// 红绿灯整组的宽度（pt）。macOS 26 起按钮变大、间距变宽，整组从约 52 变成 60；
// 侧栏收起后的宽度要按它来留，否则最右边的按钮会压到侧栏边线上。
const macMajor = process.platform === 'darwin' && typeof process.getSystemVersion === 'function'
  ? Number.parseInt(process.getSystemVersion(), 10)
  : 0;
contextBridge.exposeInMainWorld('electronTrafficLightsWidth', process.platform === 'darwin' ? (macMajor >= 26 ? 60 : 52) : 0);

contextBridge.exposeInMainWorld('electronSqliteStore', {
  get: (key) => ipcRenderer.invoke('sqlite-store:get', key),
  set: (key, value) => ipcRenderer.invoke('sqlite-store:set', key, value),
  status: () => ipcRenderer.invoke('sqlite-store:status'),
  listPatients: (query) => ipcRenderer.invoke('sqlite-store:list-patients', query)
});
