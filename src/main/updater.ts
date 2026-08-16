import { spawn, type ChildProcess } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export const DSH_PACKAGE = '@deepseek-ai/dsh'

export interface UpdaterContext {
  userDataDir: string
  nodeExecutable: string
  npmCliPath: string
  /** 内置（打包随附）dsh 的 bin.js 路径，用于读基线版本。 */
  bundledBinPath: string
  log(tag: string, message: string): void
}

export interface Settings {
  skipVersion?: string | null
  [key: string]: unknown
}

let activeProc: ChildProcess | null = null

// --- settings ---------------------------------------------------------------

function settingsPath(ctx: UpdaterContext): string {
  return join(ctx.userDataDir, 'settings.json')
}

export function loadSettings(ctx: UpdaterContext): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath(ctx), 'utf8')) as Settings
  } catch {
    return {}
  }
}

export function saveSettings(ctx: UpdaterContext, settings: Settings): void {
  try {
    writeFileSync(settingsPath(ctx), JSON.stringify(settings, null, 2) + '\n')
  } catch (error) {
    ctx.log('update', `保存设置失败: ${(error as Error).message}`)
  }
}

// --- overlay paths ----------------------------------------------------------

function overlayDir(ctx: UpdaterContext): string {
  return join(ctx.userDataDir, 'agent')
}

function stagingDir(ctx: UpdaterContext): string {
  return join(ctx.userDataDir, 'agent-staging')
}

export function overlayBinPath(ctx: UpdaterContext): string {
  return join(overlayDir(ctx), 'node_modules', DSH_PACKAGE, 'lib', 'bin.js')
}

function readPackageVersion(pkgJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

export function overlayVersion(ctx: UpdaterContext): string | null {
  return readPackageVersion(join(overlayDir(ctx), 'node_modules', DSH_PACKAGE, 'package.json'))
}

export function bundledVersion(ctx: UpdaterContext): string | null {
  // dsh 的 bin.js 在 lib/ 下，包根 package.json 在上一级。
  return readPackageVersion(join(dirname(ctx.bundledBinPath), '..', 'package.json'))
}

export function activeVersion(ctx: UpdaterContext): string {
  return overlayVersion(ctx) ?? bundledVersion(ctx) ?? '未知'
}

// --- semver 风格比较（兼容 0.1.0-rc.N 预发布） ------------------------------

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = String(v).split('-')
    const nums = core.split('.').map((s) => parseInt(s, 10) || 0)
    const match = pre.match(/\d+/)
    const preNum = parseInt(match ? match[0] : '', 10)
    return {
      nums,
      pre,
      preNum: Number.isNaN(preNum) ? -1 : preNum,
      hasPre: !!pre
    }
  }
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < 3; i++) {
    const an = A.nums[i] ?? 0
    const bn = B.nums[i] ?? 0
    if (an !== bn) return an - bn
  }
  if (A.hasPre !== B.hasPre) return A.hasPre ? -1 : 1 // 预发布 < 正式版
  if (A.hasPre && A.pre !== B.pre) {
    if (A.preNum >= 0 && B.preNum >= 0 && A.preNum !== B.preNum) {
      return A.preNum - B.preNum
    }
    return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0
  }
  return 0
}

// --- npm runner -------------------------------------------------------------

function killProc(proc: ChildProcess): void {
  if (!proc || !proc.pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    /* ignore */
  }
}

export function abort(): void {
  killProc(activeProc as ChildProcess)
  activeProc = null
}

interface RunNpmOptions {
  timeoutMs?: number
  logStream?: NodeJS.WritableStream | null
}

function runNpm(ctx: UpdaterContext, args: string[], options: RunNpmOptions = {}): Promise<string> {
  const { timeoutMs = 30 * 60 * 1000, logStream = null } = options
  return new Promise((resolve, reject) => {
    const nodeBin = ctx.nodeExecutable
    const cli = ctx.npmCliPath
    if (!existsSync(nodeBin) || !existsSync(cli)) {
      reject(new Error('内置 Node/npm 运行时缺失，无法检查或执行更新。'))
      return
    }
    ctx.log('update', 'npm ' + args.join(' '))
    try {
      mkdirSync(ctx.userDataDir, { recursive: true })
    } catch {
      /* ignore */
    }
    const proc = spawn(nodeBin, [cli, ...args], {
      cwd: ctx.userDataDir,
      env: {
        ...process.env,
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_AUDIT: 'false'
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    activeProc = proc
    let settled = false
    let stdoutBuf = ''
    let stderrBuf = ''

    const finish = (fn: (v: string) => void, value: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeProc = null
      fn(value)
    }
    const timer = setTimeout(() => {
      killProc(proc)
      finish(reject, `npm 执行超时（${Math.round(timeoutMs / 1000)} 秒）`)
    }, timeoutMs)

    proc.stdout.on('data', (c: Buffer) => {
      const text = c.toString()
      stdoutBuf += text
      logStream?.write(c)
    })
    proc.stderr.on('data', (c: Buffer) => {
      const text = c.toString()
      stderrBuf += text
      logStream?.write(c)
    })
    proc.on('error', (err) => finish(reject, err.message))
    proc.on('exit', (code) => {
      if (code === 0) {
        finish(resolve, stdoutBuf)
      } else {
        const tail = (stderrBuf + stdoutBuf)
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-6)
          .join(' | ')
        finish(reject, `npm 退出码 ${code}${tail ? '：' + tail.slice(-500) : ''}`)
      }
    })
  })
}

// --- public API -------------------------------------------------------------

export async function checkLatest(ctx: UpdaterContext): Promise<string> {
  const out = await runNpm(ctx, ['view', DSH_PACKAGE, 'version'], { timeoutMs: 90_000 })
  const lines = out.trim().split(/\r?\n/).filter(Boolean)
  const v = (lines[lines.length - 1] ?? '').trim()
  if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(`无法解析官方版本号: ${JSON.stringify(v)}`)
  return v
}

export async function applyUpdate(
  ctx: UpdaterContext,
  version: string
): Promise<{ version: string; logPath: string }> {
  const staging = stagingDir(ctx)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const logPath = join(ctx.userDataDir, 'logs', 'update.log')
  mkdirSync(dirname(logPath), { recursive: true })
  const logStream = createWriteStream(logPath, { flags: 'a' })
  try {
    await runNpm(
      ctx,
      [
        'install',
        '--prefix',
        staging,
        DSH_PACKAGE + '@' + version,
        '--save-exact',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--no-update-notifier'
      ],
      { timeoutMs: 30 * 60 * 1000, logStream }
    )
  } catch (error) {
    logStream.end()
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`${(error as Error).message}（日志: ${logPath}）`)
  }
  logStream.end()

  const bin = join(staging, 'node_modules', DSH_PACKAGE, 'lib', 'bin.js')
  if (!existsSync(bin)) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`安装完成但未找到 dsh 入口文件（日志: ${logPath}）`)
  }

  // 原子切换：旧 overlay -> backup，staging -> overlay，成功后删 backup。
  const overlay = overlayDir(ctx)
  const backup = join(ctx.userDataDir, 'agent-old-' + Date.now())
  try {
    if (existsSync(overlay)) renameSync(overlay, backup)
    renameSync(staging, overlay)
  } catch (error) {
    try {
      if (!existsSync(overlay) && existsSync(backup)) renameSync(backup, overlay)
    } catch (rollbackError) {
      ctx.log('update', `回滚 overlay 失败: ${(rollbackError as Error).message}`)
    }
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`切换新版本失败: ${(error as Error).message}（staging 已清理）`)
  }
  rmSync(backup, { recursive: true, force: true })

  const settings = loadSettings(ctx)
  settings.skipVersion = null
  saveSettings(ctx, settings)
  ctx.log('update', `更新完成: ${DSH_PACKAGE}@${version}`)
  return { version, logPath }
}

export function rollback(ctx: UpdaterContext): string | null {
  const overlay = overlayDir(ctx)
  if (!existsSync(overlay)) return null
  const broken = join(ctx.userDataDir, 'agent-broken-' + Date.now())
  renameSync(overlay, broken)
  ctx.log('update', `已回退到内置版本（问题副本保留在 ${broken}）`)
  return broken
}
