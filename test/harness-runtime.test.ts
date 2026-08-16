import { describe, expect, it } from 'vitest'
import { buildNodeArguments } from '../src/main/runtime/harness-runtime'

describe('buildNodeArguments', () => {
  it('构建 dsh web 启动参数', () => {
    const args = buildNodeArguments('C:/dsh/lib/bin.js', 12345)
    expect(args).toContain('--use-system-ca')
    expect(args).toContain('--expose-internals')
    expect(args).toContain('C:/dsh/lib/bin.js')
    expect(args).toContain('web')
    expect(args).toContain('--host')
    expect(args).toContain('127.0.0.1')
    expect(args).toContain('--port')
    expect(args).toContain('12345')
  })
})
