import { join } from 'node:path'
import { existsSync, mkdirSync, createWriteStream, type WriteStream } from 'node:fs'
import os from 'node:os'
import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { HarnessRuntime } from './runtime/harness-runtime'
import { secureWindow } from './security'
import {
  activeVersion,
  applyUpdate,
  bundledVersion,
  checkLatest,
  compareVersions,
  DSH_PACKAGE,
  loadSettings,
  overlayBinPath,
  overlayVersion,
  rollback,
  saveSettings,
  type UpdaterContext
} from './updater'
import type { RuntimeSnapshot } from '../shared/contracts'

let mainWindow: BrowserWindow | undefined
let runtime: HarnessRuntime
let updCtx: UpdaterContext
let quitting = false
let updateBusy = false
let desktopLog: WriteStream | undefined

// --- logging ----------------------------------------------------------------

function log(tag: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`
  try {
    desktopLog?.write(line)
  } catch {
    /* ignore */
  }
  if (process.env.DSH_DESKTOP_DEBUG) process.stdout.write(line)
}

// --- runtime paths ----------------------------------------------------------

function nodeExe(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'node', 'node.exe')
  return join(app.getAppPath(), 'vendor', 'node', 'node.exe')
}

function npmCli(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js')
  return join(app.getAppPath(), 'vendor', 'npm', 'bin', 'npm-cli.js')
}

function bundledBinPath(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'app',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js'
    )
  }
  return join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** 用户已批准安装的官方新版（overlay）优先，内置包兜底。 */
function dshBinPath(): string {
  const overlay = overlayBinPath(updCtx)
  if (overlay && existsSync(overlay)) return overlay
  return bundledBinPath()
}

function dshHome(): string {
  return process.env.DSH_HOME || join(os.homedir(), '.dsh')
}

// --- window -----------------------------------------------------------------

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'DSH Desktop',
    icon: join(app.getAppPath(), 'build', 'icon.ico'),
    backgroundColor: '#0b1220',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      preload: join(import.meta.dirname, '../preload/index.cjs')
    }
  })
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    win.setTitle('DSH Desktop')
  })
  secureWindow(win)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })
  mainWindow = win
  return win
}

function showBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options)
  return dialog.showMessageBox(options)
}

// --- harness lifecycle ------------------------------------------------------

async function openHarness(url: string): Promise<void> {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  const current = win.webContents.getURL()
  if (current === '' || current === 'about:blank') {
    await win.loadURL(url)
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

async function launchHarness(): Promise<void> {
  mainWindow?.hide()
  await runtime.start()
}

function showRuntimeFailure(snapshot: RuntimeSnapshot): void {
  if (quitting) return
  const hasOverlay = existsSync(overlayBinPath(updCtx))
  void (async () => {
    const buttons = hasOverlay ? ['回退到内置版本', '重试', '查看日志', '退出'] : ['重试', '查看日志', '退出']
    const result = await showBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: snapshot.message,
      detail: `日志文件：${join(app.getPath('logs'), 'harness.log')}`,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1
    })
    const label = buttons[result.response]
    if (label === '回退到内置版本') {
      rollback(updCtx)
      await launchHarness().catch((e) => fatal(e))
    } else if (label === '重试') {
      await launchHarness().catch((e) => fatal(e))
    } else if (label === '查看日志') {
      shell.showItemInFolder(join(app.getPath('logs'), 'harness.log'))
    } else {
      app.quit()
    }
  })()
}

function fatal(error: unknown): void {
  log('fatal', error instanceof Error ? (error.stack ?? error.message) : String(error))
  dialog.showErrorBox(
    'DSH Desktop 遇到错误',
    (error instanceof Error ? error.message : String(error)) +
      `\n\n日志目录：${app.getPath('logs')}`
  )
  app.quit()
}

// --- official update flow (user-consented) ----------------------------------

async function runUpdateFlow(manual: boolean): Promise<void> {
  if (quitting) return
  if (updateBusy) {
    if (manual) {
      await showBox({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。', buttons: ['确定'] })
    }
    return
  }
  let latest: string
  try {
    latest = await checkLatest(updCtx)
  } catch (error) {
    log('update', `检查失败: ${(error as Error).message}`)
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查更新失败',
        message: '无法连接 npm registry。',
        detail: `${(error as Error).message}\n\n可通过环境变量 NPM_CONFIG_REGISTRY 配置镜像。`,
        buttons: ['确定']
      })
    }
    return
  }
  const current = activeVersion(updCtx)
  const settings = loadSettings(updCtx)
  if (compareVersions(latest, current) <= 0) {
    if (manual) {
      await showBox({
        type: 'info',
        title: '检查更新',
        message: '当前已是最新版本。',
        detail: `${DSH_PACKAGE}@${current}`,
        buttons: ['确定']
      })
    }
    return
  }
  if (!manual && settings.skipVersion === latest) return

  const { response } = await showBox({
    type: 'info',
    title: '发现新版本',
    message: `官方 ${DSH_PACKAGE} 发布了新版本：${latest}`,
    detail:
      `当前版本：${current}\n\n是否立即更新？\n` +
      '· 从 npm 官方源下载新版本及其依赖\n' +
      '· 更新期间界面保持可用，完成后重启应用生效\n' +
      '· 失败会自动保留当前版本',
    buttons: ['立即更新', '跳过此版本', '稍后'],
    defaultId: 0,
    cancelId: 2
  })
  if (response === 1) {
    settings.skipVersion = latest
    saveSettings(updCtx, settings)
    log('update', `用户跳过版本 ${latest}`)
    return
  }
  if (response === 2) return

  updateBusy = true
  try {
    await applyUpdate(updCtx, latest)
    const { response: r2 } = await showBox({
      type: 'info',
      title: '更新完成',
      message: `已更新到 ${DSH_PACKAGE}@${latest}`,
      detail: '重启应用后生效。',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1
    })
    if (r2 === 0) {
      quitting = true
      await runtime.stop()
      app.relaunch()
      app.exit(0)
    }
  } catch (error) {
    log('update', `更新失败: ${(error as Error).message}`)
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成更新，仍使用当前版本。',
      detail: (error as Error).message,
      buttons: ['确定']
    })
  } finally {
    updateBusy = false
  }
}

// --- menu -------------------------------------------------------------------

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'DSH 桌面',
      submenu: [
        {
          label: '检查更新…',
          accelerator: 'CmdOrCtrl+U',
          click: () => void runUpdateFlow(true).catch(fatal)
        },
        {
          label: '重启 Harness',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => void launchHarness().catch(fatal)
        },
        {
          label: '显示 Harness 日志',
          click: () => shell.showItemInFolder(join(app.getPath('logs'), 'harness.log'))
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// --- bootstrap --------------------------------------------------------------

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  mkdirSync(join(userData, 'logs'), { recursive: true })
  desktopLog = createWriteStream(join(userData, 'logs', 'desktop.log'), { flags: 'a' })

  updCtx = {
    userDataDir: userData,
    nodeExecutable: nodeExe(),
    npmCliPath: npmCli(),
    bundledBinPath: bundledBinPath(),
    log
  }

  runtime = new HarnessRuntime({
    dshEntryPath: dshBinPath(),
    dshHome: dshHome(),
    logPath: join(app.getPath('logs'), 'harness.log'),
    nodeExecutable: nodeExe(),
    cwd: os.homedir(),
    onChanged: (snapshot) => {
      if (snapshot.phase === 'ready' && snapshot.url) {
        void openHarness(snapshot.url).catch(fatal)
      } else if (snapshot.phase === 'failed') {
        showRuntimeFailure(snapshot)
      }
    }
  })

  createWindow()
  installMenu()
  await launchHarness()

  // 启动后自动检测官方更新（仅提示，不强制；用户可自主选择）。
  void runUpdateFlow(false).catch((e) => log('update', `自动检查失败: ${(e as Error).message}`))
}

process.on('uncaughtException', (error) => {
  log('crash', `uncaughtException: ${error.stack ?? error.message}`)
  dialog.showErrorBox('DSH Desktop 遇到异常', String(error.stack ?? error.message).slice(0, 500))
})

process.on('unhandledRejection', (reason) => {
  log('crash', `unhandledRejection: ${String(reason)}`)
})

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const snapshot = runtime?.snapshot()
    if (snapshot?.phase === 'ready' && snapshot.url) {
      void openHarness(snapshot.url).catch(fatal)
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((error) => {
    fatal(error)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting || !runtime) return
    event.preventDefault()
    quitting = true
    void runtime.stop().finally(() => app.quit())
  })
}

// 导出仅供测试/诊断使用的版本信息。
export const versionInfo = {
  overlay: overlayVersion,
  bundled: bundledVersion,
  active: activeVersion
}
