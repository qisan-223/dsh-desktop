import { contextBridge } from 'electron'

// 极简 preload：仅暴露版本信息作为 contextBridge 骨架，
// 证明沙箱 preload 加载正常；后续原生能力（更新状态、窗口控制）在此扩展。
contextBridge.exposeInMainWorld('dshDesktop', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
})
