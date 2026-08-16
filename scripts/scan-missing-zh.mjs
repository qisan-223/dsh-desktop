// 扫描所有 @deepseek-ai 包的 client.js，对比 zh/en 字典，找出 zh 缺失的键。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const base = join('E:/deepseek工作区/dsh-desktop/node_modules/@deepseek-ai')

function extractDict(content, name) {
  // 匹配 const zh = {...}; 或 const zh$1 = {...}; 或 const en$1 = {...};
  const re = new RegExp(`const\\s+${name}(?:\\$\\d+)?\\s*=\\s*\\{([\\s\\S]*?)\\};`)
  const m = re.exec(content)
  if (!m) return null
  const body = m[1]
  const keys = new Set()
  const keyRe = /["']([^"']+)["']\s*:/g
  let k
  while ((k = keyRe.exec(body)) !== null) keys.add(k[1])
  return keys
}

function walkJs(dir, out) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      if (statSync(full).isDirectory()) walkJs(full, out)
      else if (name === 'client.js') out.push(full)
    } catch {}
  }
}

const files = []
walkJs(base, files)

const report = []
for (const f of files) {
  const content = readFileSync(f, 'utf8')
  const zh = extractDict(content, 'zh')
  const en = extractDict(content, 'en')
  if (!en) continue // 没有 en 字典，跳过
  const rel = f.replace(base + '\\', '')
  if (!zh) {
    report.push({ pkg: rel, missing: 'WHOLE_DICT', keys: [] })
    continue
  }
  const missing = [...en].filter((k) => !zh.has(k))
  if (missing.length > 0) {
    report.push({ pkg: rel, missing: 'KEYS', keys: missing })
  }
}

console.log('=== zh 缺失情况汇总 ===\n')
for (const r of report) {
  console.log(`\n[${r.pkg}]`)
  if (r.missing === 'WHOLE_DICT') {
    console.log('  ⚠ 整个 zh 字典缺失（该包所有文本显示英文）')
  } else {
    console.log(`  缺失 ${r.keys.length} 个键:`)
    for (const k of r.keys) console.log(`    - ${k}`)
  }
}
