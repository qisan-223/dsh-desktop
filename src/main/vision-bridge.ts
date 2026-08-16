import { cpSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 官方 @deepseek-ai/dsh 不含 vision bridge（图片识图桥接）。这里把 fork 编译好的
 * 4 个包 lib/ 作为 vendor 资产（extraResources → resources/vision-bridge），在
 * 启动时和官方更新完成后幂等地复制进当前生效的 dsh 安装（内置或 overlay）。
 *
 * 幂等判定：以 dsh-host-apiproxy 的 types/vision-bridge.js 是否已存在作为“已打补丁”
 * 标记。存在则跳过，从而不会用本地的旧 vendor 覆盖官方未来的新版（或上游已合入的
 * 同名能力）。
 */

/** 携带 vision bridge 的包名。 */
const BRIDGE_PACKAGES = ['dsh-host-apiproxy', 'dsh-llm-deepseek', 'dsh-llm-pi-ai', 'dsh-llm'] as const

/** extraResources 落点：<resources>/vision-bridge/<pkg>/lib */
function vendorLibRoot(pkg: string): string {
  return join(process.resourcesPath, 'vision-bridge', pkg, 'lib')
}

/** 证明桥接已应用的标记文件。 */
function bridgeMarker(nodeModulesRoot: string): string {
  return join(nodeModulesRoot, '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'types', 'vision-bridge.js')
}

/**
 * 幂等地把 vendor 的 vision bridge 复制到某个 dsh 安装的 node_modules 下。
 * @param nodeModulesRoot 目标 node_modules 根目录（内置 app/node_modules 或 overlay 的 agent/node_modules）。
 * @param log 记录日志的回调（tag, message）。
 */
export function ensureVisionBridge(nodeModulesRoot: string, log: (tag: string, message: string) => void): void {
  if (!existsSync(nodeModulesRoot)) return
  if (existsSync(bridgeMarker(nodeModulesRoot))) {
    log('vision-bridge', `已存在，跳过 ${nodeModulesRoot}`)
    return
  }
  let applied = 0
  for (const pkg of BRIDGE_PACKAGES) {
    const src = vendorLibRoot(pkg)
    const dst = join(nodeModulesRoot, '@deepseek-ai', pkg, 'lib')
    if (!existsSync(src) || !existsSync(dst)) continue
    // 逐项复制，明确按“src 内容 → dst”合并覆盖（保留 dst 里官方版本独有的文件）。
    for (const entry of readdirSync(src)) {
      cpSync(join(src, entry), join(dst, entry), { recursive: true, force: true })
    }
    applied += 1
  }
  log('vision-bridge', `已应用 ${applied} 个包到 ${nodeModulesRoot}`)
}
