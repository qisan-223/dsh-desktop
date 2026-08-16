// 把系统 Node 可执行文件复制到 vendor/node/node.exe。
//
// 为什么需要独立 node.exe（而非复用 Electron 内置 Node）：
// dsh 依赖 sharp / node-pty / koffi 等原生模块，它们按安装时的 Node ABI
// 预编译。Electron 内置 Node 的 ABI 不同，会拒绝加载这些模块。复制安装时
// 使用的同一份 node.exe，即可零配置保证 ABI 一致。
//
// 用法（必须在系统 Node 下运行，不能在 Electron 内运行）：
//   node scripts/fetch-node.mjs
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const src = process.execPath
const dest = resolve(import.meta.dirname, '..', 'vendor', 'node', 'node.exe')

if (!/node(\.exe)?$/i.test(basename(src))) {
  console.error('fetch-node 必须在系统 Node 下运行（node scripts/fetch-node.mjs），不能在 Electron 内运行。')
  process.exit(1)
}

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`已复制 ${src}`)
console.log(`    -> ${dest}`)
console.log(`Node ${process.version} / ${process.platform}-${process.arch} / ${statSync(dest).size} bytes`)
