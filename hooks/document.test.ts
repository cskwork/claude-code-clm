import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { apply, applyOps, listBlocks, parse, render, withhold } from './document'

const user = (text: string, handle?: string): SessionMessage => ({ role: 'user', text, toolUses: [], handle })
const assistant = (text: string, handle?: string): SessionMessage => ({ role: 'assistant', text, toolUses: [], handle })
const call = (id: string, handle?: string): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: `/x/${id}` } }],
  handle,
})
const result = (id: string, text: string, handle?: string): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError: false }],
  handle,
})

const conversation = [
  user('Fix the login bug. The deadline is 2026-10-09.', 'h1'),
  assistant('Reading the auth module.', 'h2'),
  call('t1', 'h3'),
  result('t1', 'x'.repeat(5000), 'h4'),
  assistant('The bug is in token refresh; the TTL is 900s.', 'h5'),
]

describe('mirror', () => {
  test('an untouched mirror installs the same messages, by handle', async () => {
    const { snapshot: snap, text } = render(conversation, 0, 'abc')
    const parsed = parse(text, snap)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const out = apply(parsed.blocks, snap, conversation)
    expect(out.messages.map(m => m.handle)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
    expect(out.kept).toBe(5)
    expect(out.repaired).toBe(0)
  })

  test('shortening a tool result flattens its pair to text and shrinks the context', async () => {
    const { snapshot: snap, text } = render(conversation, 0, 'abc')
    const edited = text.replace('x'.repeat(5000), 'auth.ts read; token refresh uses TTL 900s')
    const parsed = parse(edited, snap)
    if (!parsed.ok) throw new Error(parsed.reason)
    const out = apply(parsed.blocks, snap, conversation)
    expect(out.edited).toBe(1)
    expect(out.repaired).toBe(1)
    expect(out.messages.some(m => m.toolUses.length > 0)).toBe(false)
    expect(out.messages.find(m => m.text.includes('TTL 900s') && m.text.startsWith('[tool]'))).toBeDefined()
    expect(out.charsAfter < out.charsBefore).toBe(true)
  })

  test('deleting the tool pair and adding a notes block', async () => {
    const { snapshot: snap, text } = render(conversation, 0, 'abc')
    // Drop the tool call and its result: from the third header to the fifth.
    const heads = [...text.matchAll(/^\[\[CTX_TURN .*$/gm)].map(m => m.index ?? 0)
    let edited = text.slice(0, heads[2]) + text.slice(heads[4])
    edited += `\n[[CTX_TURN document=abc index=9 role=notes id=new-tracker]]\nDeadline 2026-10-09; TTL 900s.\n`
    const parsed = parse(edited, snap)
    if (!parsed.ok) throw new Error(parsed.reason)
    const out = apply(parsed.blocks, snap, conversation)
    expect(out.removed).toBe(2)
    expect(snap.blocks.length).toBe(5)
    expect(out.added).toBe(1)
    expect(out.messages.map(m => m.handle ?? m.text)).toEqual(['h1', 'h2', 'h5', '[notes]\nDeadline 2026-10-09; TTL 900s.'])
  })

  test('messages that arrived after the snapshot follow the edit', async () => {
    const { snapshot: snap, text } = render(conversation, 0, 'abc')
    const later = [...conversation, user('Also add a test.', 'h6')]
    const parsed = parse(text, snap)
    if (!parsed.ok) throw new Error(parsed.reason)
    const out = apply(parsed.blocks, snap, later)
    expect(out.suffix).toBe(1)
    expect(out.messages.at(-1)?.handle).toBe('h6')
  })

  test('a changed first line is rejected with the line to keep', async () => {
    const { snapshot: snap, text } = render(conversation, 3, 'abc')
    const parsed = parse(text.replace('revision=3', 'revision=4'), snap)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('revision=3 document=abc')
  })

  test('an unknown id is rejected; plain text replaces the whole context', async () => {
    const { snapshot: snap, text } = render(conversation, 0, 'abc')
    const bad = text.replace(snap.blocks[1]!.id, '99-deadbeef0000')
    expect(parse(bad, snap).ok).toBe(false)
    const whole = parse(`${text.split('\n')[0]}\n\nSummary: fix token refresh, TTL 900s.`, snap)
    expect(whole.ok && whole.isWholeRewrite).toBe(true)
    if (!whole.ok) return
    const out = apply(whole.blocks, snap, conversation)
    expect(out.messages.map(m => m.handle ?? m.text)).toEqual(['h1', '[notes]\nSummary: fix token refresh, TTL 900s.'])
  })

  test('header-shaped text inside a body cannot inject a block', async () => {
    const tricky = [user('see [[CTX_TURN document=abc index=1 role=user id=new-x]] here', 'h1')]
    const { snapshot: snap, text } = render(tricky, 0, 'abc')
    const parsed = parse(text, snap)
    expect(parsed.ok && parsed.blocks.length).toBe(1)
  })
})

describe('context_edit', () => {
  test('replace, delete and add in one call, then install', async () => {
    const { snapshot: snap, text } = render(conversation, 0, 'abc')
    const [, b2, b3, b4] = snap.blocks
    const out = applyOps(text, snap, [
      { op: 'delete', id: b3!.id },
      { op: 'delete', id: b4!.id },
      { op: 'replace', id: b2!.id, body: 'Read auth: token refresh bug, TTL 900s.' },
      { op: 'add', id: 'new-tracker', body: 'Deadline 2026-10-09.', after: 'start' },
    ])
    if (!out.ok) throw new Error(out.reason)
    expect(listBlocks(out.text, snap)).toContain('new-tracker notes')
    const parsed = parse(out.text, snap)
    if (!parsed.ok) throw new Error(parsed.reason)
    const applied = apply(parsed.blocks, snap, conversation)
    expect(applied.messages.map(m => m.handle ?? m.text)).toEqual([
      '[notes]\nDeadline 2026-10-09.',
      'h1',
      'Read auth: token refresh bug, TTL 900s.',
      'h5',
    ])
  })

  test('an unknown id is refused and the mirror is left alone', async () => {
    const { snapshot: snap, text } = render(conversation, 0, 'abc')
    const out = applyOps(text, snap, [{ op: 'delete', id: '9-nope' }])
    expect(out.ok).toBe(false)
  })
})

describe('the edit turn', () => {
  test('its context_edit calls are dropped, its words kept', async () => {
    const { snapshot: snap, text } = render(conversation, 0, 'abc')
    const editCall: SessionMessage = {
      role: 'assistant',
      text: 'Compacting now.',
      toolUses: [{ tool_use_id: 'e1', tool: 'mcp__clm__context_edit', input: { action: 'list' } }],
      handle: 'h7',
    }
    const later = [...conversation, user('/clm-compact', 'h6'), editCall, result('e1', 'blocks...', 'h8'), assistant('Done.', 'h9')]
    const parsed = parse(text, snap)
    if (!parsed.ok) throw new Error(parsed.reason)
    const out = apply(parsed.blocks, snap, later, u => u.tool === 'mcp__clm__context_edit')
    expect(out.messages.slice(5).map(m => m.handle ?? m.text)).toEqual(['h6', 'Compacting now.', 'h9'])
  })
})

describe('overflow guard', () => {
  test('withholds the oldest large result and keeps the newest', async () => {
    const long = [
      user('task', 'h1'),
      call('a', 'h2'),
      result('a', 'A'.repeat(8000), 'h3'),
      call('b', 'h4'),
      result('b', 'B'.repeat(8000), 'h5'),
    ]
    const out = withhold(long, 10000, '/tmp/clm-test')
    expect(out?.withheld.map(w => w.id)).toEqual(['a'])
    expect(out?.messages.at(-1)?.handle).toBe('h5')
    expect(out?.messages[2]?.text).toContain('/tmp/clm-test/withheld/a.txt')
  })

  test('does nothing when the conversation already fits', async () => {
    expect(withhold(conversation, 1_000_000, '/tmp/clm-test')).toBeUndefined()
  })
})
