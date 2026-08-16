'use strict'

// electron-builder afterPack 钩子。
//
// electron-builder 的文件复制器会剥离 extraResources 里嵌套的 node_modules，
// 但内置 npm CLI 需要自己的依赖（graceful-fs、semver 等）。打包后把 vendor/npm
// 完整复制进打包产物，NSIS 与 portable 目标随后都会归档这份副本。
//
// 注意：不要清理 *.md —— @deepseek-ai/dsh 内置的 agent presets 依赖
// SKILL.md（创建模式 skills），误删会破坏功能。

const fs = require('node:fs')
const path = require('node:path')

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context
  if (electronPlatformName !== 'win32') return

  const src = path.resolve(__dirname, '..', 'vendor', 'npm')
  const dest = path.join(appOutDir, 'resources', 'npm')
  if (fs.existsSync(src)) {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(src, dest, { recursive: true, dereference: true })
    let deps = 0
    try {
      deps = fs.readdirSync(path.join(dest, 'node_modules')).length
    } catch {
      /* ignore */
    }
    console.log(`afterPack: bundled npm copied (deps: ${deps})`)
  } else {
    console.warn('afterPack: vendor/npm missing — npm CLI will not be bundled')
  }
}
