/** Structured environment actions and conservative classifier composition. */

import { basename, normalize, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { canonicalJson, semanticDigest } from './canonical.ts'
import { isSemanticToolName } from './protocol.ts'

/** Observable effect classes used by semantic policy providers. */
export type SemanticEffect = 'read' | 'create' | 'modify' | 'delete' | 'execute'
  | 'network' | 'external-message' | 'financial' | 'permission-change' | 'unknown'

/** Host-resolved resource identity used only as policy input. */
export interface SemanticResourceRef {
  readonly scheme: 'file' | 'database' | 'url' | 'process' | 'account' | 'opaque'
  readonly locator: string
  readonly canonicalLocator?: string
  readonly resourceIdentityDigest?: string
  readonly opaqueId: string
  readonly sanitizedLabel: string
  readonly resolutionStatus: 'resolved' | 'partial' | 'unknown'
  readonly digest?: string
  readonly sensitivity: 'public' | 'internal' | 'confidential' | 'secret' | 'unknown'
  readonly trustBoundary: 'local' | 'workspace' | 'network' | 'external-account' | 'unknown'
}

/** Whether the runtime holds independently verifiable restoration material. */
export type SemanticReversibility =
  | { readonly kind: 'verified'; readonly undoRef: string; readonly beforeDigest?: string }
  | { readonly kind: 'none' | 'unknown' }

/** Runtime-minted description of one exact immutable tool call. */
export interface SemanticAction {
  readonly callId: string
  readonly rootCallId: string
  readonly toolName: string
  readonly argumentsDigest: string
  readonly actionDigest: string
  readonly operation: string
  readonly effects: readonly SemanticEffect[]
  readonly reads: readonly SemanticResourceRef[]
  readonly writes: readonly SemanticResourceRef[]
  readonly reversibility: SemanticReversibility
  readonly risk: 'none' | 'low' | 'medium' | 'high' | 'critical'
  readonly riskCeiling: 'low' | 'medium' | 'high' | 'critical' | 'unknown'
  readonly egress: 'none' | 'metadata' | 'content' | 'unknown'
  readonly purpose: 'normal' | 'diagnostic' | 'reconciliation-only'
  readonly classifierId: string
  readonly classifierVersion: string
  readonly confidence: 'exact' | 'conservative' | 'unknown'
}

/** Classifier input containing only immutable execution identity. */
export interface SemanticActionDescriptionRequest {
  readonly sessionId: string
  readonly turn: number
  readonly callId: string
  readonly rootCallId: string
  readonly toolName: string
  readonly frozenArguments: unknown
  readonly argumentsDigest: string
  readonly toolContractDigest?: string
  readonly signal: AbortSignal
}

/** Untrusted proposal returned by a classifier provider. */
export interface SemanticActionProposal {
  readonly operation: string
  readonly effects: readonly SemanticEffect[]
  readonly resourceHints: readonly {
    readonly scheme: SemanticResourceRef['scheme']
    readonly locator: string
    readonly access: 'read' | 'write'
  }[]
  readonly estimatedRisk: 'none' | 'low' | 'medium' | 'high' | 'critical' | 'unknown'
  readonly confidence: 'exact' | 'conservative' | 'unknown'
}

/** Versioned output of one scoped action classifier. */
export interface SemanticActionDescriptionReport {
  readonly classifierId: string
  readonly classifierVersion: string
  readonly proposal: SemanticActionProposal
  readonly completeness: 'complete' | 'partial' | 'unknown'
  readonly detail: string
}

const RISK_ORDER = ['none', 'low', 'medium', 'high', 'critical'] as const

function actionCore(action: SemanticAction): Omit<SemanticAction, 'actionDigest'> {
  const { actionDigest: _digest, ...core } = action
  return core
}

/** Compute the digest of one action without its self-identifying field. */
export function semanticActionDigest(action: Omit<SemanticAction, 'actionDigest'>): string {
  return semanticDigest('action', 1, action)
}

/** Validate the self-binding digest of one complete action. */
export function assertSemanticAction(action: SemanticAction): void {
  if (action.actionDigest !== semanticActionDigest(actionCore(action))) {
    throw new Error(`semantic action ${action.callId} digest does not match its fields`)
  }
  if (action.effects.length === 0) throw new Error(`semantic action ${action.callId} must declare at least one effect`)
}

function argumentsRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function resource(
  scheme: SemanticResourceRef['scheme'],
  locator: string,
  workspaceRoot: string | undefined,
): SemanticResourceRef {
  const fileLike = scheme === 'file' || scheme === 'database'
  const canonical = fileLike ? resolve(workspaceRoot ?? process.cwd(), normalize(locator)) : locator
  return {
    scheme,
    locator,
    ...(fileLike ? { canonicalLocator: canonical } : {}),
    resourceIdentityDigest: semanticDigest('resource', 1, { scheme, canonical }),
    opaqueId: `resource:${semanticDigest('resource-id', 1, { scheme, canonical }).slice(0, 24)}`,
    sanitizedLabel: fileLike ? basename(locator) || '(workspace)' : scheme === 'url' ? '(network resource)' : '(opaque resource)',
    resolutionStatus: fileLike ? 'partial' : 'unknown',
    sensitivity: 'unknown',
    trustBoundary: fileLike ? 'workspace' : scheme === 'url' ? 'network' : 'unknown',
  }
}

function pathHint(args: unknown): string | undefined {
  const record = argumentsRecord(args)
  const value = record?.['file_path'] ?? record?.['path']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function bashProposal(args: unknown): SemanticActionDescriptionReport {
  const record = argumentsRecord(args)
  const command = typeof record?.['command'] === 'string' ? record['command'].trim() : ''
  const mutating = /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|rmdir|chmod|chown|touch)\b|(?:^|\s)(?:>|>>)(?:\s|$)|\.(?:import|restore)\b|\b(?:VACUUM|ATTACH|DETACH|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/iu
  const readOnly = /^(?:pwd|ls(?:\s|$)|rg(?:\s|$)|grep(?:\s|$)|sed\s+-n(?:\s|$)|cat(?:\s|$)|wc(?:\s|$)|find(?:\s|$)|git\s+(?:status|diff|log|show)(?:\s|$))[^;&|><]*$/u
  if (command.length > 0 && mutating.test(command)) {
    return {
      classifierId: 'semantic-runtime-bash', classifierVersion: '1', completeness: 'partial',
      detail: 'recognized an explicitly effectful shell operation',
      proposal: {
        operation: 'shell-effectful', effects: ['execute', 'modify'], resourceHints: [],
        estimatedRisk: 'high', confidence: 'conservative',
      },
    }
  }
  if (command.length > 0 && readOnly.test(command)) {
    return {
      classifierId: 'semantic-runtime-bash', classifierVersion: '1', completeness: 'complete',
      detail: 'recognized a bounded observation-only shell command',
      proposal: {
        operation: 'shell-observe', effects: ['execute', 'read'], resourceHints: [],
        estimatedRisk: 'low', confidence: 'exact',
      },
    }
  }
  return {
    classifierId: 'semantic-runtime-bash', classifierVersion: '1', completeness: 'unknown',
    detail: 'arbitrary shell code cannot be proven side-effect-free by the built-in classifier',
    proposal: {
      operation: 'shell-unknown', effects: ['execute', 'unknown'], resourceHints: [],
      estimatedRisk: 'unknown', confidence: 'unknown',
    },
  }
}

function pwshProposal(args: unknown): SemanticActionDescriptionReport {
  const record = argumentsRecord(args)
  const command = typeof record?.['command'] === 'string' ? record['command'].trim() : ''
  const mutating = /\b(?:Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|Set-Content|Add-Content|Out-File|Set-Acl|Start-Process)\b/iu
  const readOnly = /^(?:Get-Location|Get-ChildItem|Get-Content|Select-String|Measure-Object|rg(?:\s|$)|git\s+(?:status|diff|log|show)(?:\s|$))[^;|><]*$/iu
  if (command.length > 0 && mutating.test(command)) {
    return {
      classifierId: 'semantic-runtime-pwsh', classifierVersion: '1', completeness: 'partial',
      detail: 'recognized an explicitly effectful PowerShell operation',
      proposal: {
        operation: 'shell-effectful', effects: ['execute', 'modify'], resourceHints: [],
        estimatedRisk: 'high', confidence: 'conservative',
      },
    }
  }
  if (command.length > 0 && readOnly.test(command)) {
    return {
      classifierId: 'semantic-runtime-pwsh', classifierVersion: '1', completeness: 'complete',
      detail: 'recognized a bounded observation-only PowerShell command',
      proposal: {
        operation: 'shell-observe', effects: ['execute', 'read'], resourceHints: [],
        estimatedRisk: 'low', confidence: 'exact',
      },
    }
  }
  return {
    classifierId: 'semantic-runtime-pwsh', classifierVersion: '1', completeness: 'unknown',
    detail: 'arbitrary PowerShell code cannot be proven side-effect-free by the built-in classifier',
    proposal: {
      operation: 'shell-unknown', effects: ['execute', 'unknown'], resourceHints: [],
      estimatedRisk: 'unknown', confidence: 'unknown',
    },
  }
}

/** Built-in conservative classifier for the tools shipped by the Semantic preset. */
export function builtinSemanticActionDescription(
  request: SemanticActionDescriptionRequest,
): SemanticActionDescriptionReport {
  const path = pathHint(request.frozenArguments)
  if (isSemanticToolName(request.toolName)) {
    return {
      classifierId: 'semantic-runtime', classifierVersion: '1', completeness: 'complete', detail: 'semantic protocol control',
      proposal: { operation: 'semantic-control', effects: ['read'], resourceHints: [], estimatedRisk: 'none', confidence: 'exact' },
    }
  }
  if (request.toolName === 'read' || request.toolName === 'read_image'
    || request.toolName === 'glob' || request.toolName === 'grep') {
    return {
      classifierId: 'semantic-runtime', classifierVersion: '1', completeness: 'complete', detail: 'typed workspace observation',
      proposal: {
        operation: request.toolName, effects: ['read'],
        resourceHints: path === undefined ? [] : [{ scheme: 'file', locator: path, access: 'read' }],
        estimatedRisk: 'low', confidence: 'exact',
      },
    }
  }
  if (request.toolName === 'write' || request.toolName === 'edit') {
    return {
      classifierId: 'semantic-runtime', classifierVersion: '1', completeness: 'complete', detail: 'typed workspace modification without a runtime undo receipt',
      proposal: {
        operation: request.toolName, effects: ['modify'],
        resourceHints: path === undefined ? [] : [{ scheme: 'file', locator: path, access: 'write' }],
        estimatedRisk: 'high', confidence: 'exact',
      },
    }
  }
  if (request.toolName === 'bash') return bashProposal(request.frozenArguments)
  if (request.toolName === 'pwsh') return pwshProposal(request.frozenArguments)
  if (request.toolName === 'web_search' || request.toolName === 'web_fetch') {
    return {
      classifierId: 'semantic-runtime', classifierVersion: '1', completeness: 'partial', detail: 'network operation may cross a trust boundary',
      proposal: { operation: request.toolName, effects: ['network', 'read'], resourceHints: [], estimatedRisk: 'high', confidence: 'conservative' },
    }
  }
  return {
    classifierId: 'semantic-runtime', classifierVersion: '1', completeness: 'unknown', detail: 'tool has no trusted built-in effect contract',
    proposal: { operation: request.toolName, effects: ['unknown'], resourceHints: [], estimatedRisk: 'unknown', confidence: 'unknown' },
  }
}

function riskCeiling(toolName: string): SemanticAction['riskCeiling'] {
  if (isSemanticToolName(toolName)) return 'low'
  if (toolName === 'read' || toolName === 'read_image' || toolName === 'glob' || toolName === 'grep') return 'low'
  if (toolName === 'write' || toolName === 'edit' || toolName === 'web_search' || toolName === 'web_fetch') return 'high'
  if (toolName === 'bash' || toolName === 'pwsh' || toolName === 'run_code') return 'critical'
  return 'unknown'
}

function mergeReports(reports: readonly SemanticActionDescriptionReport[]): SemanticActionDescriptionReport {
  if (reports.length === 0) throw new Error('semantic action classification produced no report')
  const complete = reports.filter(report => report.completeness === 'complete')
  const selected = complete.length > 0 ? complete : reports
  const operation = new Set(selected.map(report => report.proposal.operation))
  const confidence = selected.every(report => report.proposal.confidence === 'exact') && operation.size === 1
    ? 'exact' as const
    : selected.some(report => report.proposal.confidence === 'unknown') ? 'unknown' as const : 'conservative' as const
  const effects = [...new Set(selected.flatMap(report => report.proposal.effects))]
  const risks = selected.map(report => report.proposal.estimatedRisk)
  const knownRisks = risks.filter((risk): risk is Exclude<typeof risk, 'unknown'> => risk !== 'unknown')
  const estimatedRisk = risks.includes('unknown') || knownRisks.length === 0
    ? 'unknown' as const
    : knownRisks.reduce((highest, risk) => RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(highest) ? risk : highest)
  return {
    classifierId: selected.map(report => report.classifierId).join('+'),
    classifierVersion: selected.map(report => report.classifierVersion).join('+'),
    completeness: complete.length === selected.length && confidence === 'exact' ? 'complete' : confidence === 'unknown' ? 'unknown' : 'partial',
    detail: selected.map(report => report.detail).join('; '),
    proposal: {
      operation: operation.size === 1 ? selected[0]!.proposal.operation : 'conflicting-classification',
      effects: effects.length === 0 ? ['unknown'] : effects,
      resourceHints: selected.flatMap(report => report.proposal.resourceHints),
      estimatedRisk,
      confidence,
    },
  }
}

/** Resolve built-in and scoped classifier reports into one runtime-minted action. */
export async function describeSemanticAction(
  ctx: Context,
  agent: Agent,
  exec: ToolExecution,
  turn: number,
): Promise<SemanticAction> {
  const request: SemanticActionDescriptionRequest = {
    sessionId: agent.id, turn, callId: exec.callId, rootCallId: exec.rootCallId,
    toolName: exec.name, frozenArguments: exec.arguments,
    argumentsDigest: semanticDigest('tool-arguments', 1, JSON.parse(canonicalJson(exec.arguments))),
    signal: exec.signal,
  }
  const providerReports = await ctx.waterfall(
    scopeTarget(agent, agent), 'semantic/describe-action', request, () => Promise.resolve([]),
  )
  const merged = mergeReports([builtinSemanticActionDescription(request), ...providerReports])
  const workspaceRoot = agent.session.header.cwd
  const reads = merged.proposal.resourceHints.filter(hint => hint.access === 'read')
    .map(hint => resource(hint.scheme, hint.locator, workspaceRoot))
  const writes = merged.proposal.resourceHints.filter(hint => hint.access === 'write')
    .map(hint => resource(hint.scheme, hint.locator, workspaceRoot))
  const risk = merged.proposal.estimatedRisk === 'unknown' ? 'critical' : merged.proposal.estimatedRisk
  const core: Omit<SemanticAction, 'actionDigest'> = {
    callId: exec.callId, rootCallId: exec.rootCallId, toolName: exec.name,
    argumentsDigest: request.argumentsDigest, operation: merged.proposal.operation,
    effects: merged.proposal.effects, reads, writes,
    reversibility: { kind: writes.length === 0 ? 'none' : 'unknown' },
    risk, riskCeiling: riskCeiling(exec.name),
    egress: merged.proposal.effects.includes('network') ? 'unknown' : 'none',
    purpose: 'normal', classifierId: merged.classifierId,
    classifierVersion: merged.classifierVersion, confidence: merged.proposal.confidence,
  }
  return { ...core, actionDigest: semanticActionDigest(core) }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Extend conservative action classification for one immutable tool call.
     * @param request Immutable execution identity and arguments.
     * @mode waterfall
     */
    'semantic/describe-action'(
      request: SemanticActionDescriptionRequest,
      next: () => Promise<readonly SemanticActionDescriptionReport[]>,
    ): Promise<readonly SemanticActionDescriptionReport[]>
  }
}
