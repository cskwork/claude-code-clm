// CLM for Claude Code: the model manages its own context by editing a mirror file.
// A port of pi-clm (https://github.com/lolipopshock/pi-clm, MIT) for the paper
// "Context Language Models" (arXiv 2609.37725).
//
// Claude Code pins the messages of each model request, so an accepted edit is
// installed between turns through the compaction path: a `session.compact` hook
// answers with the edited conversation instead of a summary.

import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { apply, applyOps, digest, estimateTokens, listBlocks, parse, render, withhold, type Op, type Snapshot } from './document'
import { APPLY_TAG, budgetNote, compactPrompt, EDIT_TOOL, EDIT_TOOL_DESCRIPTION, EDIT_TOOL_SCHEMA, formatCount, parseReminders, protocol } from './text'

type History = {
  revision: number
  at: string
  kind: 'edit' | 'guard'
  kept: number
  edited: number
  added: number
  removed: number
  tokensBefore: number
  tokensAfter: number
}

type State = {
  enabled: boolean
  revision: number
  nonce: string
  snapshot?: Snapshot
  isPending: boolean
  lastTier: number
  lastOutcome?: string
  history: History[]
}

type Options = { budget: number; reminders: string; guard: boolean; steering: string }

const FRESH: State = { enabled: true, revision: 0, nonce: '', isPending: false, lastTier: 0, history: [] }

let steeringText: string | undefined

function newNonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

async function dirOf($: EngineInterface): Promise<string> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  return `${tmp}/claude-clm/${await $.session.id()}`
}

async function mirrorOf($: EngineInterface): Promise<string> {
  return `${await dirOf($)}/LIVE_CONTEXT.md`
}

async function load($: EngineInterface): Promise<State> {
  try {
    return { ...FRESH, ...JSON.parse(await $.fs.read(`${await dirOf($)}/state.json`)) }
  } catch {
    return { ...FRESH, nonce: newNonce() }
  }
}

async function save($: EngineInterface, state: State): Promise<void> {
  await $.fs.write(`${await dirOf($)}/state.json`, JSON.stringify(state))
}

async function readMirror($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.fs.read(await mirrorOf($))
  } catch {
    return undefined
  }
}

// Write the conversation to the mirror unless the model has an edit in it.
async function refresh($: EngineInterface, state: State): Promise<State> {
  const onDisk = await readMirror($)
  if (state.snapshot && onDisk !== undefined && digest(onDisk) !== state.snapshot.textDigest) return state
  const messages = await $.session.messages()
  const { snapshot, text } = render(messages, state.revision, state.nonce)
  if (onDisk !== text) await $.fs.write(await mirrorOf($), text)
  const next = { ...state, snapshot }
  await save($, next)
  return next
}

async function contextTokens($: EngineInterface): Promise<{ tokens: number; window: number }> {
  const { context } = await $.session.usage()
  return { tokens: context.tokens ?? 0, window: context.window }
}

async function note($: EngineInterface, text: string): Promise<void> {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

async function remind($: EngineInterface, state: State, options: Options): Promise<State> {
  const tiers = parseReminders(options.reminders)
  if (tiers.length === 0) return state
  const { tokens, window } = await contextTokens($)
  const budget = options.budget > 0 ? options.budget : window
  if (!tokens || !budget) return state
  const pct = (tokens / budget) * 100
  const tier = [...tiers].reverse().find(t => pct >= t) ?? 0
  if (tier === state.lastTier) return state
  const next = { ...state, lastTier: tier }
  if (tier > state.lastTier) await note($, budgetNote(tokens, budget, tier, await mirrorOf($)))
  await save($, next)
  return next
}

// At turn end: is there an edit, and does it validate?
async function settle($: EngineInterface, state: State): Promise<State> {
  const text = await readMirror($)
  if (!state.snapshot || text === undefined || digest(text) === state.snapshot.textDigest) return state
  const parsed = parse(text, state.snapshot)
  if (!parsed.ok) {
    const outcome = `rejected: ${parsed.reason}`
    await note($, `[LIVE CONTEXT] Your mirror edit was rejected (${parsed.reason}). The mirror was rewritten from the current conversation; nothing changed.`)
    const next = { ...state, isPending: false, lastOutcome: outcome, snapshot: undefined }
    await save($, next)
    return refresh($, next)
  }
  const next = { ...state, isPending: true }
  await save($, next)
  return next
}

async function installNow($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'compact', args: APPLY_TAG })
  } catch (error) {
    $.ui.log(`clm: the edit stays pending until the next /compact (${String(error)})`)
  }
}

async function applyEdit($: EngineInterface, state: State, messages: readonly SessionMessage[]) {
  const text = (await readMirror($)) ?? ''
  const parsed = state.snapshot ? parse(text, state.snapshot) : { ok: false as const, reason: 'no snapshot' }
  if (!parsed.ok || !state.snapshot) return { state: { ...state, isPending: false, lastOutcome: `rejected: ${parsed.ok ? '' : parsed.reason}` } }
  const mirror = await mirrorOf($)
  const isEditing = (u: SessionMessage['toolUses'][number]) =>
    u.tool === `mcp__clm__${EDIT_TOOL}` || (MIRROR_TOOLS.has(u.tool) && u.input.file_path === mirror)
  const result = apply(parsed.blocks, state.snapshot, messages, isEditing)
  const revision = state.revision + 1
  const tokensBefore = estimateTokens(result.charsBefore)
  const tokensAfter = estimateTokens(result.charsAfter)
  const summary = `revision ${revision} accepted: ${result.kept} kept, ${result.edited} edited, ${result.added} added, ${result.removed} removed; ~${formatCount(tokensBefore)} → ~${formatCount(tokensAfter)} tokens`
  const history: History = { revision, at: new Date().toISOString(), kind: 'edit', kept: result.kept, edited: result.edited, added: result.added, removed: result.removed, tokensBefore, tokensAfter }
  const next: State = { ...state, revision, nonce: newNonce(), snapshot: undefined, isPending: false, lastTier: 0, lastOutcome: summary, history: [...state.history, history] }
  const messagesOut = [...result.messages, { role: 'user' as const, text: `[LIVE CONTEXT] Your mirror ${summary}.`, toolUses: [] }]
  return { state: next, messages: messagesOut, tokensBefore, tokensAfter }
}

async function guard($: EngineInterface, state: State, messages: readonly SessionMessage[], options: Options) {
  const { window } = await contextTokens($)
  const budget = options.budget > 0 ? Math.min(options.budget, window) : window
  const dir = await dirOf($)
  const out = withhold(messages, budget * 4 * 0.5, dir)
  if (!out) return undefined
  for (const w of out.withheld) await $.fs.write(w.path, w.text)
  const before = estimateTokens(messages.reduce((n, m) => n + m.text.length + (m.toolResults ?? []).reduce((k, r) => k + r.text.length, 0), 0))
  const after = estimateTokens(out.charsAfter)
  const summary = `overflow guard withheld ${out.withheld.length} old tool result(s): ~${formatCount(before)} → ~${formatCount(after)} tokens; full text in ${dir}/withheld/`
  const history: History = { revision: state.revision + 1, at: new Date().toISOString(), kind: 'guard', kept: 0, edited: out.withheld.length, added: 0, removed: 0, tokensBefore: before, tokensAfter: after }
  const next: State = { ...state, revision: state.revision + 1, nonce: newNonce(), snapshot: undefined, lastTier: 0, lastOutcome: summary, history: [...state.history, history] }
  return { state: next, messages: [...out.messages, { role: 'user' as const, text: `[CLM BUDGET] ${summary}.`, toolUses: [] }] }
}

async function status($: EngineInterface, state: State, options: Options): Promise<string> {
  const { tokens, window } = await contextTokens($)
  const budget = options.budget > 0 ? options.budget : window
  const edits = state.history.filter(h => h.kind === 'edit').length
  const guards = state.history.length - edits
  return [
    `clm ${state.enabled ? 'on' : 'off'} · revision ${state.revision} · ${edits} edit(s), ${guards} guard run(s)${state.isPending ? ' · edit pending' : ''}`,
    `context ~${formatCount(tokens)} of ${formatCount(budget)} tokens`,
    `mirror ${await mirrorOf($)}`,
    state.lastOutcome ? `last: ${state.lastOutcome}` : 'last: no edit yet',
  ].join('\n')
}

async function steering($: EngineInterface, options: Options): Promise<string> {
  if (options.steering !== 'house') return ''
  steeringText ??= await $.fs.read(`${$.plugin.root}/steering/house-brief.md`)
  return `\n\n## Context-management guidance (house)\n\n${steeringText.trim()}`
}

async function isHeadless($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length === 0
}

async function beforeStep($: EngineInterface, opts: Options): Promise<void> {
  const state = await load($)
  if (!state.enabled) return
  await remind($, await refresh($, state), opts)
}

async function afterTurn($: EngineInterface): Promise<void> {
  const state = await load($)
  if (!state.enabled) return
  const settled = await settle($, state)
  if (settled.isPending && !(await isHeadless($))) $.clock.after(0, () => void installNow($))
}

async function contextEdit($: EngineInterface, action: string, ops: readonly Op[]): Promise<string> {
  const state = await load($)
  if (!state.enabled) return 'clm is off.'
  const ready = state.snapshot ? state : await refresh($, state)
  const snapshot = ready.snapshot
  const text = await readMirror($)
  if (!snapshot || text === undefined) return 'The mirror is not ready yet; try again next turn.'
  if (action === 'list') return listBlocks(text, snapshot)
  if (ops.length === 0) return 'Nothing to apply: pass ops, or action "list" to see block ids.'
  const out = applyOps(text, snapshot, ops)
  if (!out.ok) return `Not applied: ${out.reason}`
  await $.fs.write(await mirrorOf($), out.text)
  const before = estimateTokens(text.length)
  const after = estimateTokens(out.text.length)
  return `Applied ${ops.length} operation(s) to the mirror: ~${formatCount(before)} → ~${formatCount(after)} tokens. It becomes your context when this turn ends.`
}

const MIRROR_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit'])

export const register: Register = (on, options) => {
  const opts = options as unknown as Options

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'clm', description: 'CLM status; /clm on, /clm off' })
    await $.command.register({ name: 'clm-compact', description: 'Ask Claude to compact its own context by editing the mirror' })
    await $.tool.register({ name: EDIT_TOOL, description: EDIT_TOOL_DESCRIPTION, inputSchema: EDIT_TOOL_SCHEMA })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const state = await load($)
    if (!state.enabled) return out
    const text = protocol(await mirrorOf($)) + (await steering($, opts))
    return { sections: [...out.sections, { id: 'clm:protocol', text, scope: 'session' as const }] }
  })

  on('turn.step', async function* ($, e, next) {
    // Rendered once per turn: re-rendering mid-turn would invalidate the model's
    // read of the file before its edit lands.
    if (e.agentId === undefined && e.index === 0) await beforeStep($, opts).catch(error => $.ui.log(`clm: ${String(error)}`, { to: 'debug' }))
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) await afterTurn($).catch(error => $.ui.log(`clm: ${String(error)}`, { to: 'debug' }))
    return out
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    let decided: Awaited<ReturnType<typeof decide>>
    try {
      decided = await decide($, e.trigger, e.instructions, e.messages, opts)
    } catch (error) {
      $.ui.log(`clm: compaction hook failed, native compaction runs instead (${String(error)})`, { to: 'debug' })
      return next(e)
    }
    if (decided) return decided
    const state = await load($)
    const out = await next(e)
    if (state.enabled && out.skip === undefined) {
      await save($, { ...state, revision: state.revision + 1, nonce: newNonce(), snapshot: undefined, isPending: false, lastTier: 0, lastOutcome: `native ${e.trigger} compaction replaced the conversation` })
    }
    return out
  })

  on('tool.call', { tool: `mcp__clm__${EDIT_TOOL}` }, async ($, e) => {
    const input = e as unknown as { action?: string; ops?: Op[] }
    try {
      return { result: await contextEdit($, input.action ?? 'apply', input.ops ?? []) }
    } catch (error) {
      return { result: `context_edit failed: ${String(error)}`, isError: true as const }
    }
  })

  on('tool.check', async ($, e, next) => {
    if (e.tool === `mcp__clm__${EDIT_TOOL}`) return { decision: 'allow' as const, reason: 'clm: edits only the live-context mirror' }
    if (!MIRROR_TOOLS.has(e.tool)) return next(e)
    const path = (e.input as { file_path?: unknown } | undefined)?.file_path
    const isMirror = typeof path === 'string' && (await mirrorOf($).catch(() => '')) === path
    return isMirror ? { decision: 'allow' as const, reason: 'clm: the live-context mirror' } : next(e)
  })

  on('command.run', { command: 'clm' }, async ($, e) => {
    const state = await load($)
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off') {
      await save($, { ...state, enabled: arg === 'on', snapshot: undefined, isPending: false })
      return { text: `clm ${arg}` }
    }
    return { text: await status($, state, opts) }
  })

  // `/clm-compact` becomes the compact prompt itself, so it runs as an ordinary turn
  // in every mode (a plugin's own submit waits for an idle REPL, which -p never has).
  on('prompt.submit', async ($, e, next) => {
    const match = /^\/clm-compact(?:\s+([\s\S]*))?$/.exec(e.text.trim())
    if (!match) return next(e)
    const state = await load($)
    if (!state.enabled) return next(e)
    const { tokens, window } = await contextTokens($)
    const budget = opts.budget > 0 ? opts.budget : window
    return next({ ...e, text: compactPrompt(await mirrorOf($), tokens, budget, match[1] ?? '') })
  })

  on('command.run', { command: 'clm-compact' }, async ($, e) => {
    const state = await load($)
    if (!state.enabled) return { text: 'clm is off; /clm on first' }
    const { tokens, window } = await contextTokens($)
    const budget = opts.budget > 0 ? opts.budget : window
    const text = compactPrompt(await mirrorOf($), tokens, budget, e.args)
    $.clock.after(0, () => void $.prompt.submit({ text, asUser: true }).catch(error => $.ui.log(`clm: ${String(error)}`)))
    return { text: 'Asked Claude to compact its live context.' }
  })
}

// The compaction CLM answers itself, or undefined to let the engine's run.
async function decide($: EngineInterface, trigger: string, instructions: string | undefined, messages: readonly SessionMessage[], opts: Options) {
  const state = await load($)
  if (!state.enabled) return undefined
  // A /compact after an edit not yet settled installs it, as the end of the turn would have.
  const settled = state.isPending ? state : await settle($, state)
  if (settled.isPending) return applyAndSave($, settled, messages)
  if (instructions === APPLY_TAG) return { skip: 'clm: no edit pending' }
  if (trigger === 'auto' && opts.guard) {
    const guarded = await guard($, state, messages, opts)
    if (guarded) {
      await save($, guarded.state)
      return { messages: guarded.messages }
    }
  }
  return undefined
}

async function applyAndSave($: EngineInterface, state: State, messages: readonly SessionMessage[]) {
  const out = await applyEdit($, state, messages)
  await save($, out.state)
  if (!out.messages) {
    await note($, `[LIVE CONTEXT] Your mirror edit was rejected (${out.state.lastOutcome}).`)
    return { skip: `clm: ${out.state.lastOutcome}` }
  }
  return { messages: out.messages, tokensBefore: out.tokensBefore, tokensAfter: out.tokensAfter }
}
