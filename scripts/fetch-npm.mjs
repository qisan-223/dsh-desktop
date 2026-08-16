// 把 devDependencies 里的 npm 包复制到 vendor/npm。
//
// 打包后的应用用它（配合 vendor/node/node.exe）检查并安装官方
// @deepseek-ai/dsh 更新：npm 能正确解析依赖树、处理平台相关的可选依赖，
// 并尊重用户的 .npmrc（registry 镜像、代理）。
//
// 用法（必须在系统 Node 下运行）：
//   node scripts/fetch-npm.mjs
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const src = resolve(import.meta.dirname, '..', 'node_modules', 'npm')
const dest = resolve(import.meta.dirname, '..', 'vendor', 'npm')

if (!existsSync(resolve(src, 'bin', 'npm-cli.js'))) {
  console.error('找不到 npm 包：' + src)
  console.error('请先运行 pnpm install（npm 在 devDependencies 中）。')
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dirname(dest), { recursive: true })
// pnpm 的 node_modules 是符号链接结构，需 dereference 复制实际内容。
cpSync(src, dest, { recursive: true, dereference: true })
const version = require(resolve(dest, 'package.json')).version
console.log(`已复制 npm@${version}`)
console.log(`    ${src}`)
console.log(` -> ${dest}`)
