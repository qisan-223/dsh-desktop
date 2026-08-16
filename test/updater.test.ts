import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/main/updater'

describe('compareVersions', () => {
  it('相同版本返回 0', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
  })

  it('数值比较', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0)
  })

  it('预发布版本小于正式版', () => {
    expect(compareVersions('0.1.0-rc.6', '0.1.0')).toBeLessThan(0)
    expect(compareVersions('0.1.0', '0.1.0-rc.6')).toBeGreaterThan(0)
  })

  it('rc 序号比较', () => {
    expect(compareVersions('0.1.0-rc.7', '0.1.0-rc.6')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0-rc.5', '0.1.0-rc.6')).toBeLessThan(0)
  })
})
