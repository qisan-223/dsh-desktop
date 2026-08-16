// 端到端 smoke test：用内置 node.exe 拉起 dsh web，确认 Web UI 就绪后回收。
// 用法：node scripts/smoke-dsh-web.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
const node = join(import.meta.dirname, '..', 'vendor', 'node', 'node.exe')
const entry = join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const child = spawn(
  node,
  ['--use-system-ca', '--expose-internals', entry, 'web', '--host', '127.0.0.1', '--port', '0'],
  {
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

let output = ''
let url = null
let done = false

function finish(err, msg) {
  if (done) return
  done = true
  clearTimeout(timer)
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {}
  } else {
    child.kill('SIGKILL')
  }
  rmSync(home, { recursive: true, force: true })
  if (err) {
    console.error('\nSMOKE FAIL:', msg || err.message)
    console.error('--- 最后输出 ---')
    console.error(output.slice(-3000))
    process.exit(1)
  }
  console.log('\nSMOKE OK:', msg)
  process.exit(0)
}

const timer = setTimeout(() => finish(new Error('timeout'), 'dsh web 未在 120s 内就绪'), 120000)

child.stdout.on('data', (c) => {
  const text = c.toString()
  output += text
  process.stdout.write(text)
  if (!url) {
    const m = text.match(/dsh web:\s+(https?:\/\/\S+)/)
    if (m) {
      url = m[1]
      probe(m[1])
    }
  }
})
child.stderr.on('data', (c) => {
  const text = c.toString()
  output += text
  process.stderr.write(text)
})
child.on('exit', (code) => {
  if (!done) finish(new Error('exit'), `dsh web 提前退出（code ${code}）`)
})

async function probe(u) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
      if (res.status >= 200 && res.status < 500) {
        finish(null, `Web UI 就绪 ${u} (HTTP ${res.status})`)
        return
      }
    } catch {
      /* 启动中 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  finish(new Error('no-http'), '找到 URL 但 HTTP 未就绪')
}
