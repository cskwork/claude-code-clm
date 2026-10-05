// The mirror: render the conversation as an editable document, parse the model's
// edit, and turn it back into the message list a `session.compact` hook hands up.
// Pure functions only; ported from pi-clm's context-document.ts (MIT, Emanuel Casco).

import type { SessionMessage } from 'claude-code'

export const DOCUMENT_VERSION = 1

// What is kept of a render to judge an edit: digests, not bodies, so the saved
// state stays small however long the conversation grows.
export type Block = {
  id: string
  role: string
  key: string
  digest: string
}

export type Snapshot = {
  revision: number
  nonce: string
  blocks: Block[]
  textDigest: string
  firstUser?: { id: string; role: string; body: string }
}

export type ParsedBlock = { id: string; role: string; body: string }

export type Parsed =
  | { ok: true; blocks: ParsedBlock[]; isWholeRewrite: boolean }
  | { ok: false; reason: string }

export type BuiltMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: SessionMessage['toolUses']
  handle?: string
}

export type Applied = {
  messages: BuiltMessage[]
  kept: number
  edited: number
  added: number
  removed: number
  suffix: number
  repaired: number
  charsBefore: number
  charsAfter: number
}

// FNV-1a, two lanes: a stable 16-hex digest without Node's crypto.
export function digest(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

// What identifies a message across `$.session.messages()` and a compaction's input.
// A tool use's answer is left out: it arrives later on the same message.
export function messageKey(m: SessionMessage): string {
  const uses = m.toolUses.map(u => u.tool_use_id).join(',')
  const results = (m.toolResults ?? []).map(r => `${r.tool_use_id}:${digest(r.text)}`).join(',')
  return digest(`${m.role}\u0001${m.text}\u0001${uses}\u0001${results}`)
}

export function roleOf(m: SessionMessage): string {
  if (m.role === 'assistant') return 'assistant'
  return m.toolResults?.length && !m.text.trim() ? 'tool' : 'user'
}

export function renderBody(m: SessionMessage): string {
  const parts: string[] = []
  if (m.text.trim()) parts.push(m.text.trim())
  for (const u of m.toolUses) parts.push(`[tool call: ${u.tool} id=${u.tool_use_id}]\n${JSON.stringify(u.input)}`)
  for (const r of m.toolResults ?? []) {
    parts.push(`[tool result id=${r.tool_use_id}${r.isError ? ' error' : ''}]\n${r.text}`)
  }
  return parts.join('\n\n')
}

const STRUCTURAL = /^(\\*)(\[\[(?:CTX_TURN|LIVE_CONTEXT) )/gm

export function escapeStructural(body: string): string {
  return body.replace(STRUCTURAL, (_m, s: string, start: string) => `\\${s}${start}`)
}

export function unescapeStructural(body: string): string {
  return body.replace(STRUCTURAL, (_m, s: string, start: string) => `${s.slice(1)}${start}`)
}

export function metaLine(revision: number, nonce: string): string {
  return `[[LIVE_CONTEXT version=${DOCUMENT_VERSION} revision=${revision} document=${nonce}]]`
}

export function headerLine(nonce: string, index: number, role: string, id: string): string {
  return `[[CTX_TURN document=${nonce} index=${index} role=${role} id=${id}]]`
}

export function render(messages: readonly SessionMessage[], revision: number, nonce: string): { snapshot: Snapshot; text: string } {
  const rendered = messages.map((m, i) => {
    const key = messageKey(m)
    return { id: `${i + 1}-${key.slice(0, 12)}`, role: roleOf(m), key, body: escapeStructural(renderBody(m)) }
  })
  const text = `${[
    metaLine(revision, nonce),
    '# Edit bodies, delete, reorder or add blocks (id=new-NAME). Keep this first line and the headers you retain.',
    ...rendered.map((b, i) => `${headerLine(nonce, i + 1, b.role, b.id)}\n${b.body}`),
  ].join('\n\n')}\n`
  const first = rendered.find(b => b.role === 'user')
  const snapshot: Snapshot = {
    revision,
    nonce,
    blocks: rendered.map(b => ({ id: b.id, role: b.role, key: b.key, digest: digest(b.body.trim()) })),
    textDigest: digest(text),
    firstUser: first && { id: first.id, role: first.role, body: first.body.trim() },
  }
  return { snapshot, text }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parse(text: string, snap: Snapshot): Parsed {
  const expected = metaLine(snap.revision, snap.nonce)
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine !== expected) {
    return { ok: false, reason: `the first line must stay exactly: ${expected}` }
  }
  const headerRe = new RegExp(
    `^\\[\\[CTX_TURN document=${escapeRegExp(snap.nonce)} index=\\d+ role=([A-Za-z][A-Za-z0-9_-]*) id=([A-Za-z0-9-]+)\\]\\][ \\t]*$`,
    'gm',
  )
  const matches = [...text.matchAll(headerRe)]
  const known = new Set(snap.blocks.map(b => b.id))
  const body = text.slice(text.indexOf('\n') + 1)

  if (matches.length === 0) {
    const notes = stripHint(body).trim()
    if (!notes) return { ok: false, reason: 'the mirror is empty; nothing would remain' }
    const blocks: ParsedBlock[] = snap.firstUser ? [{ ...snap.firstUser }] : []
    blocks.push({ id: 'new-notes', role: 'notes', body: notes })
    return { ok: true, blocks, isWholeRewrite: true }
  }

  const seen = new Set<string>()
  const blocks: ParsedBlock[] = []
  const heads = matches.map(m => ({ at: m.index ?? 0, line: m[0], role: m[1] ?? '', id: m[2] ?? '' }))
  const preamble = stripHint(text.slice(firstLine.length, heads[0]?.at ?? text.length)).trim()
  if (preamble) blocks.push({ id: 'new-preamble', role: 'notes', body: preamble })
  for (const [i, h] of heads.entries()) {
    if (!h.id.startsWith('new-') && !known.has(h.id)) {
      return { ok: false, reason: `unknown block id ${h.id}: ids come only from current headers, or start with new-` }
    }
    if (seen.has(h.id)) return { ok: false, reason: `duplicate block id ${h.id}` }
    seen.add(h.id)
    const end = heads[i + 1]?.at ?? text.length
    blocks.push({ id: h.id, role: h.role, body: text.slice(h.at + h.line.length, end).trim() })
  }
  const stray = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.startsWith(`[[CTX_TURN document=${snap.nonce} `) && !heads.some(h => h.line.trim() === l))
  if (stray[0] !== undefined) return { ok: false, reason: `malformed header: ${stray[0].slice(0, 160)}` }
  return { ok: true, blocks, isWholeRewrite: false }
}

function stripHint(text: string): string {
  return text.replace(/^# Edit bodies, delete, reorder or add blocks.*$/m, '')
}

function textMessage(role: string, body: string): BuiltMessage {
  const text = unescapeStructural(body).trim()
  if (role === 'user') return { role: 'user', text, toolUses: [] }
  if (role === 'assistant') return { role: 'assistant', text, toolUses: [] }
  // Authored and tool roles reach the model as user-role text, never as authority.
  return { role: 'user', text: `[${role}]\n${text}`, toolUses: [] }
}

// Build the conversation the compaction installs: untouched blocks keep the
// engine's own message (by handle), edited and new blocks become text, messages
// that arrived after the snapshot follow unchanged, and broken tool pairs are
// flattened to text so the request stays legal.
// `isEditing` names the tool calls that performed the edit (the mirror's own
// traffic): they are dropped from what follows the snapshot, so the edit does not
// leave its working behind in the context it produced.
export function apply(
  parsed: ParsedBlock[],
  snap: Snapshot,
  current: readonly SessionMessage[],
  isEditing: (use: SessionMessage['toolUses'][number]) => boolean = () => false,
): Applied {
  const byId = new Map(snap.blocks.map(b => [b.id, b]))
  const baseline = new Map<string, number>()
  for (const b of snap.blocks) baseline.set(b.key, (baseline.get(b.key) ?? 0) + 1)

  const pool = new Map<string, SessionMessage[]>()
  const suffix: SessionMessage[] = []
  const left = new Map(baseline)
  for (const m of current) {
    const key = messageKey(m)
    const n = left.get(key) ?? 0
    if (n > 0) {
      left.set(key, n - 1)
      pool.set(key, [...(pool.get(key) ?? []), m])
    } else {
      suffix.push(m)
    }
  }

  type Item = { msg: BuiltMessage; source?: SessionMessage }
  const out: Item[] = []
  let kept = 0
  let edited = 0
  let added = 0
  const used = new Set<string>()
  for (const p of parsed) {
    const b = byId.get(p.id)
    if (b) used.add(b.id)
    if (b && p.role === b.role && digest(p.body) === b.digest) {
      const original = pool.get(b.key)?.shift()
      if (original) {
        out.push({ msg: { role: original.role, text: original.text, toolUses: original.toolUses, handle: original.handle }, source: original })
        kept++
      }
      continue
    }
    const built = textMessage(p.role, p.body)
    if (!built.text) continue
    out.push({ msg: built })
    if (b) edited++
    else added++
  }
  const editIds = new Set(suffix.flatMap(m => m.toolUses.filter(isEditing).map(u => u.tool_use_id)))
  for (const m of suffix) {
    const results = m.toolResults ?? []
    if (results.length > 0 && results.every(r => editIds.has(r.tool_use_id)) && !m.text.trim()) continue
    if (m.toolUses.length > 0 && m.toolUses.every(u => editIds.has(u.tool_use_id))) {
      if (m.text.trim()) out.push({ msg: { role: m.role, text: m.text, toolUses: [] } })
      continue
    }
    out.push({ msg: { role: m.role, text: m.text, toolUses: m.toolUses, handle: m.handle }, source: m })
  }

  const repaired = repairToolPairs(out)
  const messages = out.map(i => i.msg)
  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', text: '[context]', toolUses: [] })

  const charsBefore = current.reduce((n, m) => n + renderBody(m).length, 0)
  const charsAfter = messages.reduce((n, m) => n + m.text.length + JSON.stringify(m.toolUses.map(u => u.input)).length, 0)
  return {
    messages,
    kept,
    edited,
    added,
    removed: snap.blocks.filter(b => !used.has(b.id)).length,
    suffix: suffix.length,
    repaired,
    charsBefore,
    charsAfter,
  }
}

type RepairItem = { msg: BuiltMessage; source?: SessionMessage }

function flatten(item: RepairItem): void {
  if (!item.source) return
  const role = item.source.role === 'assistant' ? 'assistant' : roleOf(item.source)
  item.msg = textMessage(role, renderBody(item.source))
  item.source = undefined
}

function resultsOf(item: RepairItem | undefined): readonly { tool_use_id: string }[] {
  return item?.source?.toolResults ?? []
}

function repairToolPairs(items: RepairItem[]): number {
  let repaired = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const uses = it?.source?.role === 'assistant' ? it.source.toolUses : []
    if (!it || uses.length === 0) continue
    const want = new Set(uses.map(u => u.tool_use_id))
    const got = new Set<string>()
    let j = i + 1
    while (j < items.length && resultsOf(items[j]).length > 0 && got.size < want.size) {
      for (const r of resultsOf(items[j])) got.add(r.tool_use_id)
      j++
    }
    const isWhole = got.size === want.size && [...got].every(id => want.has(id))
    if (isWhole) {
      i = j - 1
      continue
    }
    flatten(it)
    for (const item of items.slice(i + 1, j)) flatten(item)
    repaired++
  }
  // A tool result whose call is no longer right before it.
  for (const [i, item] of items.entries()) {
    const results = resultsOf(item)
    if (results.length === 0) continue
    let k = i - 1
    while (k >= 0 && resultsOf(items[k]).length > 0) k--
    const call = items[k]?.source
    const ids = new Set(call?.role === 'assistant' ? call.toolUses.map(u => u.tool_use_id) : [])
    if (!results.every(r => ids.has(r.tool_use_id))) {
      flatten(item)
      repaired++
    }
  }
  return repaired
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

export type Withheld = { id: string; tool: string; path: string; text: string }

// The overflow guard: replace the oldest large tool results with one-line notes
// (full text saved to a file) until the conversation fits `targetChars`. The
// newest results stay, so a re-read of a withheld file is never withheld again.
export function withhold(
  current: readonly SessionMessage[],
  targetChars: number,
  dir: string,
  minChars = 2000,
): { messages: BuiltMessage[]; withheld: Withheld[]; charsAfter: number } | undefined {
  const items: RepairItem[] = current.map(m => ({ msg: { role: m.role, text: m.text, toolUses: m.toolUses, handle: m.handle }, source: m }))
  const size = (m: SessionMessage) => renderBody(m).length
  let total = current.reduce((n, m) => n + size(m), 0)
  if (total <= targetChars) return undefined
  const toolOf = new Map<string, string>()
  for (const m of current) for (const u of m.toolUses) toolOf.set(u.tool_use_id, u.tool)
  const withheld: Withheld[] = []
  const lastResult = current.map(m => !!m.toolResults?.length).lastIndexOf(true)
  for (const [i, m] of current.entries()) {
    if (total <= targetChars) break
    if (!m.toolResults?.length || i === lastResult) continue
    const big = m.toolResults.filter(r => r.text.length >= minChars)
    if (big.length === 0) continue
    const lines: string[] = []
    for (const r of m.toolResults) {
      if (r.text.length < minChars) {
        lines.push(`[tool result id=${r.tool_use_id}]\n${r.text}`)
        continue
      }
      const tool = toolOf.get(r.tool_use_id) ?? 'tool'
      const path = `${dir}/withheld/${r.tool_use_id}.txt`
      withheld.push({ id: r.tool_use_id, tool, path, text: r.text })
      lines.push(
        `[CLM withheld] ${tool} result ${r.tool_use_id}: ~${estimateTokens(r.text.length)} tokens, full text at ${path}`,
      )
    }
    const note = lines.join('\n\n')
    total += note.length - size(m)
    items[i] = { msg: { role: 'user', text: `[tool]\n${note}`, toolUses: [] } }
  }
  if (withheld.length === 0 || total > targetChars) return undefined
  repairToolPairs(items)
  const messages = items.map(i => i.msg)
  return { messages, withheld, charsAfter: messages.reduce((n, m) => n + m.text.length, 0) }
}

export type Op =
  | { op: 'replace'; id: string; body: string }
  | { op: 'delete'; id: string }
  | { op: 'add'; id?: string; role?: string; body: string; after?: string }
  | { op: 'rewrite'; body: string }

export function serialize(blocks: readonly ParsedBlock[], snap: Snapshot): string {
  return `${[
    metaLine(snap.revision, snap.nonce),
    '# Edit bodies, delete, reorder or add blocks (id=new-NAME). Keep this first line and the headers you retain.',
    ...blocks.map((b, i) => `${headerLine(snap.nonce, i + 1, b.role, b.id)}\n${b.body}`),
  ].join('\n\n')}\n`
}

// The context_edit tool: apply operations to the mirror's current text and
// return the new text, or why not. Bodies given here are escaped, so a header
// typed into one stays text.
export function applyOps(text: string, snap: Snapshot, ops: readonly Op[]): { ok: true; text: string } | { ok: false; reason: string } {
  const parsed = parse(text, snap)
  if (!parsed.ok) return parsed
  let blocks = [...parsed.blocks]
  const find = (id: string) => blocks.findIndex(b => b.id === id)
  for (const [n, o] of ops.entries()) {
    const at = `operation ${n + 1} (${o.op})`
    if (o.op === 'rewrite') {
      if (!o.body.trim()) return { ok: false, reason: `${at}: empty body` }
      blocks = [...(snap.firstUser ? [{ ...snap.firstUser }] : []), { id: 'new-notes', role: 'notes', body: escapeStructural(o.body.trim()) }]
      continue
    }
    if (o.op === 'add') {
      const id = o.id ?? `new-${n + 1}-${digest(o.body).slice(0, 6)}`
      if (!/^new-[A-Za-z0-9-]+$/.test(id)) return { ok: false, reason: `${at}: an added block's id must look like new-NAME` }
      if (find(id) >= 0) return { ok: false, reason: `${at}: id ${id} already exists` }
      const role = o.role ?? 'notes'
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(role)) return { ok: false, reason: `${at}: bad role ${role}` }
      const block = { id, role, body: escapeStructural(o.body.trim()) }
      if (o.after === undefined) blocks.push(block)
      else if (o.after === 'start') blocks.unshift(block)
      else {
        const i = find(o.after)
        if (i < 0) return { ok: false, reason: `${at}: no block ${o.after}` }
        blocks.splice(i + 1, 0, block)
      }
      continue
    }
    const i = find(o.id)
    if (i < 0) return { ok: false, reason: `${at}: no block ${o.id} (list the blocks for current ids)` }
    if (o.op === 'delete') blocks.splice(i, 1)
    else blocks[i] = { ...blocks[i]!, body: escapeStructural(o.body.trim()) }
  }
  return { ok: true, text: serialize(blocks, snap) }
}

export function listBlocks(text: string, snap: Snapshot): string {
  const parsed = parse(text, snap)
  if (!parsed.ok) return `The mirror does not parse: ${parsed.reason}`
  const lines = parsed.blocks.map(b => {
    const preview = unescapeStructural(b.body).replace(/\s+/g, ' ').slice(0, 100)
    return `${b.id} ${b.role} ~${estimateTokens(b.body.length)} tok: ${preview}`
  })
  const total = estimateTokens(parsed.blocks.reduce((n, b) => n + b.body.length, 0))
  return [`${parsed.blocks.length} blocks, ~${total} tokens`, ...lines].join('\n')
}
