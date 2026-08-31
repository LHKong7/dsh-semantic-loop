import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('standalone profile Bundle', () => {
  it('supplies the diagnostics service required by its host invariant', async () => {
    const [patch, manifestText] = await Promise.all([
      readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ])
    const manifest = JSON.parse(manifestText) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }

    expect(patch).toContain("name: '@deepseek-ai/dsh-invariants'")
    expect(patch).toContain("name: 'dsh-semantic-loop/invariant'")
    expect(manifest.dependencies?.['@deepseek-ai/dsh-invariants']).toBe('^0.1.1-rc.2')
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-invariants')
  })
})
