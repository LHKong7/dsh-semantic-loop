/** Agent-scoped semantic-capability discovery and plan-gap projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type {
  SemanticCapability,
  SemanticCapabilityAvailability,
  SemanticCapabilityInventory,
  SemanticCapabilityReport,
  SemanticCapabilityRequest,
  SemanticCheckpoint,
} from './types.ts'

const semanticCapabilityIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const CONFIG_PROVIDER_ID = 'semantic-loop-config'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Extend the owning Agent's available semantic capabilities. Providers
     * call `next()` and append one report with their current declarations.
     * @param request Agent identity whose capabilities are requested.
     * @param next Delegates to the next scoped provider.
     * @mode waterfall
     */
    'semantic/capabilities'(
      request: SemanticCapabilityRequest,
      next: () => Promise<readonly SemanticCapabilityReport[]>,
    ): Promise<readonly SemanticCapabilityReport[]>
  }
}

/** Validate one provider report before its declarations influence a plan check. */
function assertCapabilityReport(report: SemanticCapabilityReport): void {
  if (report.providerId.trim().length === 0 || report.providerId.trim() !== report.providerId
    || report.specVersion.trim().length === 0 || report.specVersion.trim() !== report.specVersion) {
    throw new Error('semantic capability providerId and specVersion must be non-empty and already trimmed')
  }
  const ids = new Set<string>()
  for (const capability of report.capabilities) {
    if (!semanticCapabilityIdPattern.test(capability.id)) {
      throw new Error(`semantic capability id "${capability.id}" must be lower-kebab-case`)
    }
    if (capability.description.trim().length === 0 || capability.description.trim() !== capability.description) {
      throw new Error(`semantic capability "${capability.id}" description must be non-empty and already trimmed`)
    }
    if (ids.has(capability.id)) {
      throw new Error(`semantic capability provider "${report.providerId}" repeats capability "${capability.id}"`)
    }
    ids.add(capability.id)
  }
}

/**
 * Validate static capability declarations during plugin loading.
 * @param capabilities Deployment-configured capabilities.
 * @returns Canonical copied declarations.
 */
export function resolveConfiguredCapabilities(
  capabilities: readonly SemanticCapability[],
): readonly SemanticCapability[] {
  const report: SemanticCapabilityReport = {
    providerId: CONFIG_PROVIDER_ID,
    specVersion: '1',
    capabilities: capabilities.map(capability => ({ ...capability })),
  }
  assertCapabilityReport(report)
  return report.capabilities
}

/** Aggregate validated provider reports and reject conflicting declarations. */
function aggregateCapabilities(
  reports: readonly SemanticCapabilityReport[],
): readonly SemanticCapabilityAvailability[] {
  const available = new Map<string, SemanticCapabilityAvailability>()
  for (const report of reports) {
    for (const capability of report.capabilities) {
      const current = available.get(capability.id)
      if (current === undefined) {
        available.set(capability.id, { ...capability, providerIds: [report.providerId] })
      } else {
        if (current.description !== capability.description) {
          throw new Error(`semantic capability "${capability.id}" has conflicting provider descriptions`)
        }
        available.set(capability.id, {
          ...current,
          providerIds: [...current.providerIds, report.providerId],
        })
      }
    }
  }
  return [...available.values()]
}

/**
 * Resolve the trusted capability inventory visible to one Agent.
 * @param ctx Context that dispatches capability providers.
 * @param agent Agent whose scoped providers are queried.
 * @param configured Static declarations from this plugin instance.
 * @returns Validated and aggregated current capability inventory.
 */
export async function resolveSemanticCapabilities(
  ctx: Context,
  agent: Agent,
  configured: readonly SemanticCapability[] = [],
): Promise<SemanticCapabilityInventory> {
  const request: SemanticCapabilityRequest = { sessionId: agent.id }
  const providerReports = await ctx.waterfall(
    scopeTarget(agent, agent),
    'semantic/capabilities',
    request,
    () => Promise.resolve([]),
  )
  const reports: SemanticCapabilityReport[] = [
    ...configured.length === 0 ? [] : [{
      providerId: CONFIG_PROVIDER_ID,
      specVersion: '1',
      capabilities: configured,
    }],
    ...providerReports,
  ]
  const providerIds = new Set<string>()
  for (const report of reports) {
    assertCapabilityReport(report)
    if (providerIds.has(report.providerId)) {
      throw new Error(`semantic capabilities repeat provider "${report.providerId}"`)
    }
    providerIds.add(report.providerId)
  }
  return { reports: [...reports], available: aggregateCapabilities(reports) }
}

/**
 * Collect unique capability ids required by a plan.
 * @param checkpoint Checkpoint whose plan declares execution requirements.
 * @returns Capability ids in plan-node declaration order.
 */
export function requiredSemanticCapabilities(checkpoint: SemanticCheckpoint): readonly string[] {
  return [...new Set(checkpoint.plan.nodes.flatMap(node => node.requiredCapabilities))]
}

/**
 * Find declared plan requirements absent from an inventory.
 * @param checkpoint Checkpoint whose plan is inspected.
 * @param inventory Current trusted capability inventory.
 * @returns Missing capability ids in plan declaration order.
 */
export function missingSemanticCapabilities(
  checkpoint: SemanticCheckpoint,
  inventory: SemanticCapabilityInventory,
): readonly string[] {
  const available = new Set(inventory.available.map(capability => capability.id))
  return requiredSemanticCapabilities(checkpoint).filter(capability => !available.has(capability))
}
