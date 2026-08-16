// 扫描 dsh 生态里所有包的 peerDependencies，找出「未被安装到顶层 node_modules」的缺失项。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const store = join(root, 'node_modules', '.pnpm')

const missing = new Map() // pkgName -> Set(依赖它的包)

// 递归收集 .pnpm/<dir>/node_modules 下所有包的 package.json
function walkPkgs(dir, out) {
  if (!existsSync(dir)) return
  const pj = join(dir, 'package.json')
  if (existsSync(pj)) {
    try { out.push(JSON.parse(readFileSync(pj, 'utf8'))) } catch {}
  }
  for (const name of readdirSync(dir)) {
    if (name === '.bin') continue
    const full = join(dir, name)
    try { if (statSync(full).isDirectory()) walkPkgs(full, out) } catch {}
  }
}

const pkgs = []
for (const dir of readdirSync(store)) {
  const nm = join(store, dir, 'node_modules')
  walkPkgs(nm, pkgs)
}

const seen = new Set()
for (const pkg of pkgs) {
  if (!pkg || !pkg.name || seen.has(pkg.name)) continue
  seen.add(pkg.name)
  const peers = pkg.peerDependencies
  if (!peers || typeof peers !== 'object') continue
  for (const [name] of Object.entries(peers)) {
    // 检查是否在顶层 node_modules 存在（含 scope 路径）
    const topPath = join(root, 'node_modules', ...name.split('/'))
    if (!existsSync(topPath)) {
      if (!missing.has(name)) missing.set(name, new Set())
      missing.get(name).add(`${pkg.name}@${pkg.version}`)
    }
  }
}

console.log('=== 缺失的 peer dependencies（不在顶层 node_modules） ===')
if (missing.size === 0) {
  console.log('（无）')
} else {
  const sorted = [...missing.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [name, dependents] of sorted) {
    const deps = [...dependents]
    console.log(`\n${name}  (被 ${deps.length} 个包 peer 引用)`)
    for (const d of deps.slice(0, 8)) console.log(`  - ${d}`)
  }
}

const ds = [...missing.keys()].filter((n) => n.startsWith('@deepseek-ai/'))
console.log('\n=== @deepseek-ai/* 缺失项（可直接加入 dependencies） ===')
if (ds.length === 0) console.log('（无）')
else console.log(ds.map((n) => `    "${n}": "0.1.0-rc.6",`).join('\n'))
