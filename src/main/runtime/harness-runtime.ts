import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import type { RuntimePhase, RuntimeSnapshot } from '../../shared/contracts'

type DshChild = ChildProcessByStdio<null, Readable, Readable>

export interface HarnessRuntimeOptions {
  /** 指向 dsh 的 lib/bin.js（overlay 优先，内置包兜底，由调用方决定）。 */
  dshEntryPath: string
  /** DSH_HOME，即 dsh 的配置/会话数据目录。 */
  dshHome: string
  /** dsh web 启动日志路径。 */
  logPath: string
  /** 独立 Node 可执行文件路径（真实 Node ABI，供 dsh 原生模块加载）。 */
  nodeExecutable: string
  /** dsh 子进程的工作目录。 */
  cwd: string
  startupTimeoutMs?: number
  onChanged(snapshot: RuntimeSnapshot): void
}

/** 传给 node 的参数：先跑 dsh 入口，再跑 `dsh web --host 127.0.0.1 --port <port>`。 */
export function buildNodeArguments(dshEntryPath: string, port: number): string[] {
  return [
    // 信任系统证书库：代理/MITM 场景下内置 node 的默认 CA 无法验证，
    // 会导致插件市场等对外 fetch 失败。
    '--use-system-ca',
    // Cordis HMR 需要访问 Node 内部 ESM loader。
    '--expose-internals',
    dshEntryPath,
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    String(port)
  ]
}

export class HarnessRuntime {
  private child?: DshChild
  private logStream?: WriteStream
  private phase: RuntimePhase = 'idle'
  private message = 'Harness is not running.'
  private url?: string
  private readonly logLines: string[] = []

  constructor(private readonly options: HarnessRuntimeOptions) {}

  snapshot(): RuntimeSnapshot {
    return {
      phase: this.phase,
      message: this.message,
      url: this.url,
      logs: [...this.logLines]
    }
  }

  async start(): Promise<void> {
    await this.stop()
    this.url = undefined

    if (!existsSync(this.options.dshEntryPath)) {
      this.setState('failed', `Harness 入口未找到: ${this.options.dshEntryPath}`)
      return
    }
    if (!existsSync(this.options.nodeExecutable)) {
      this.setState('failed', `内置 Node 运行时未找到: ${this.options.nodeExecutable}`)
      return
    }

    await mkdir(this.options.dshHome, { recursive: true })
    await mkdir(dirname(this.options.logPath), { recursive: true })
    this.logStream = createWriteStream(this.options.logPath, { flags: 'a' })

    const port = await reservePort()
    const url = `http://127.0.0.1:${port}`
    const args = buildNodeArguments(this.options.dshEntryPath, port)
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'

    this.writeLog(`\n[desktop] starting ${new Date().toISOString()}`)
    this.writeLog(`[desktop] entry ${this.options.dshEntryPath}`)
    this.writeLog(`[desktop] endpoint ${url}`)
    this.setState('starting', '正在启动 DeepSeek Harness…')

    const child = spawn(this.options.nodeExecutable, args, {
      cwd: this.options.cwd,
      env: this.childEnv(pathKey),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    child.stdout.on('data', (chunk: Buffer) => this.writeChunk('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => this.writeChunk('stderr', chunk))
    child.once('error', (error) => {
      if (this.child !== child) return
      this.child = undefined
      this.setState('failed', `Harness 启动失败: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      this.setState('failed', `Harness 意外退出（${detail}）。`)
    })

    const ready = await waitUntilReady(
      url,
      () => this.child === child && child.exitCode === null,
      this.options.startupTimeoutMs ?? 60_000
    )

    if (this.child !== child) return
    if (!ready) {
      await this.stopChild(child)
      this.setState('failed', 'Harness 未在 60 秒内就绪。')
      return
    }

    this.url = url
    this.setState('ready', 'Harness 已就绪。')
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) {
      this.closeLog()
      if (this.phase !== 'failed') this.setState('idle', 'Harness 未运行。')
      return
    }

    this.setState('stopping', '正在停止 Harness…')
    this.child = undefined
    await this.stopChild(child)
    this.closeLog()
    this.url = undefined
    this.setState('idle', 'Harness 未运行。')
  }

  private childEnv(pathKey: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    // 丢弃当前 harness/会话残留，避免桌面实例被污染；保留代理、API key 等。
    for (const key of [
      'DSH_WEB_URL',
      'DSH_SESSION_ID',
      'DSH_SESSION_JSONL',
      'DSH_SHELL',
      'ELECTRON_RUN_AS_NODE',
      'NODE_OPTIONS'
    ]) {
      delete env[key]
    }
    env.DSH_HOME = this.options.dshHome
    env.NO_COLOR = '1'
    env[pathKey] = process.env[pathKey] ?? process.env.PATH ?? ''
    return env
  }

  private async stopChild(child: DshChild): Promise<void> {
    if (child.exitCode !== null) return
    if (process.platform === 'win32') {
      // Windows 下回收整个进程树，避免 dsh 派生的子进程残留。
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000))
      ])
      return
    }
    child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000))
    ])
    if (!exited && child.exitCode === null) child.kill('SIGKILL')
  }

  private setState(phase: RuntimePhase, message: string): void {
    this.phase = phase
    this.message = message
    this.options.onChanged(this.snapshot())
  }

  private writeChunk(source: 'stdout' | 'stderr', chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.length > 0) this.writeLog(`[${source}] ${line}`)
    }
  }

  private writeLog(line: string): void {
    this.logLines.push(line)
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200)
    this.logStream?.write(`${line}\n`)
  }

  private closeLog(): void {
    this.logStream?.end()
    this.logStream = undefined
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配本地端口。'))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitUntilReady(
  url: string,
  isAlive: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && isAlive()) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
      if (response.status >= 200 && response.status < 500) return true
    } catch {
      // 服务启动期间拒绝连接是预期的。
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
