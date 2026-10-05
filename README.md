# claude-code-clm

Context Language Model (CLM) mode for [Claude Code](https://code.claude.com), as a mod
(a plugin of function hooks). Claude manages its own context: the conversation is mirrored
to a file, Claude edits that file with its ordinary tools, and the edited version becomes
its conversation.

This is a port of [pi-clm](https://github.com/lolipopshock/pi-clm) (the Pi extension
for the paper [Context Language Models](https://arxiv.org/abs/2609.37725),
Shao et al. 2026) to Claude Code's plugin API.

**Benchmark result** ([REPORT.md](REPORT.md)): over 3 sessions × 3 runs, CLM kept 100% of
the planted facts and native `/compact` kept 99.4% (key facts) and 96% (incidental details).
Native `/compact` left a smaller context (5.6k vs 7.9k tokens) at about half the cost.
Both were near the ceiling, so treat the gap as small.

## Install

You need a Claude Code version that loads function-hook plugins (tested on 2.1.290).

```sh
git clone https://github.com/cskwork/claude-code-clm
claude --plugin-dir ./claude-code-clm
```

To load it in every session, add the folder's absolute path to
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Use

| command | what it does |
|---|---|
| `/clm-compact [instructions]` | ask Claude to compact its own context now by editing the mirror; anything you add (for example what to keep) is passed along |
| `/clm` | status: revision, edits, context size, mirror path, last outcome |
| `/clm on` / `/clm off` | enable, or go back to plain Claude Code behaviour |

Claude can also edit its context at any time without being asked. The protocol is in its
system prompt, and `[CLM BUDGET]` notes tell it when the context passes 50%, 75% and 90%
of the budget. Edits go through the `context_edit` tool (`mcp__clm__context_edit`):
`list` shows each block's id, role, size and a preview, and one `apply` call replaces,
deletes and adds blocks. Ordinary file tools work on the mirror too.

## CLM vs `/compact`

The main differences are who compacts, when, and how much of the original survives.

| | Claude Code `/compact` | CLM |
|---|---|---|
| who compacts | a separate summarization request reads the whole conversation | the working Claude edits its own conversation |
| when | at the auto-compact threshold (about 97% of the window), or when you type `/compact` | whenever Claude decides to, prompted by budget notes or `/clm-compact` |
| how | everything becomes one summary | anything from a targeted edit (drop one tool output, shorten one reply, add a notes block) to a full rewrite |
| original messages | all replaced by the summary | messages Claude does not touch stay verbatim |
| what to keep | a fixed summarization prompt decides | Claude decides, knowing what it still has to do |

### What happens as the context fills

| context | `/compact` alone | with CLM |
|---|---|---|
| 50%, 75%, 90% of the budget | nothing | a `[CLM BUDGET]` note is added to Claude's context, once per level; Claude may compact or carry on |
| auto-compact threshold (about 97%) | summarize everything | 1. install Claude's pending edit, if there is one; 2. otherwise withhold the oldest large tool outputs to files, if that brings the conversation under half the budget; 3. otherwise summarize, as `/compact` does |

The notes only ask: Claude compacts at 50/75/90% only if it chooses to. At the threshold,
CLM follows the fixed steps above, and Claude is not asked again.

### What the benchmark showed

In [REPORT.md](REPORT.md), Claude was asked to compact with `/clm-compact` in every CLM run.

- In 5 of 9 runs Claude deleted nearly every block and wrote one notes block, which is a
  summary in its own words, much like `/compact`.
- In the 3 `vendors` runs it kept all 21 original messages and deleted only the 6 large
  document outputs. That is the targeted kind of edit CLM allows, but it left 11.5k tokens
  against 4.6k for `/compact`.
- Recall was nearly the same: 100% for CLM, 99.4% for `/compact` on key facts. `/compact`
  was leaner and cost about half as much.

Not measured: whether Claude compacts on its own after a budget note, and the
withhold-to-files step. No session in the benchmark came near the threshold.

## How it works

```text
start of each turn   the conversation is rendered to LIVE_CONTEXT.md
during the turn      Claude edits it with context_edit (or file tools): shortens
                     tool output, deletes, reorders, adds notes blocks, or
                     rewrites it all
end of the turn      the edit is parsed and validated; untouched blocks keep the
                     engine's original messages, edited ones become text, broken
                     tool-call pairs are flattened to text, and the edit turn's
                     own context_edit calls are dropped
between turns        the edit is installed through Claude Code's compaction path
                     (a session.compact hook answers with the edited conversation
                     instead of a summary), and a [LIVE CONTEXT] note reports it
```

The mirror and its state live in `$TMPDIR/claude-clm/<session id>/`. Edits Claude makes
to the mirror with Read/Edit/Write are allowed without a permission prompt.

### Differences from pi-clm

- **Edits apply between turns, not between requests.** Claude Code does not let a plugin
  change the messages of a request inside a turn, so an edit made during a long turn
  takes effect when that turn ends. Pi applies it before the next request.
- **The mirror is rendered once per turn, and there is an edit tool.** Claude Code's Edit
  tool refuses a file that changed since it was read, and Write refuses a file it has not
  read in full (Read stops at 25k tokens). Re-rendering before every request, as Pi does,
  broke both, so the mirror is written at the start of each turn and `context_edit` edits
  it by block id.
- **In headless mode (`claude -p`) the edit waits for `/compact`.** A plugin cannot start
  a compaction there, so the next `/compact` installs the pending edit instead of
  summarizing. In the interactive app it is installed automatically.
- **Auto-compaction becomes the overflow guard.** When Claude Code would auto-compact and
  no edit is pending, the oldest large tool results are replaced by one-line notes (the
  full text is saved under `withheld/`), if that brings the conversation under half the
  budget. Otherwise Claude Code's own compaction runs.
- Not ported: the `/clm` panel (timeline, diff viewer, settings page), branch-aware
  revision history, calibration against provider token counts, and the paper-parity
  switches (one tool per turn, size trailer, observation cap).

## Settings

Set them in the `/config` menu, or under `pluginConfigs.clm.options` in settings.

| setting | default | what it controls |
|---|---|---|
| `budget` | `0` (model window) | tokens the budget notes and the overflow guard measure against |
| `reminders` | `50/75/90` | budget fractions for `[CLM BUDGET]` notes; `off` disables them |
| `guard` | `true` | replace auto-compaction with the overflow guard when that suffices |
| `steering` | `house` | append pi-clm's context-management brief to the system prompt; `none` for the protocol alone |

## Safety

The mirror holds conversation data in your temp directory. Model-editable context is a
prompt-injection surface: text that reaches the context could persuade Claude to drop or
rewrite what it should keep. Edited and added blocks reach Claude as plain user-role text,
never as system instructions, and the real system prompt is never in the mirror. CLM
cannot stop Claude from deleting something it later needs.

## Develop

```sh
claude plugin validate .
claude plugin test .           # unit tests for render/parse/apply and the guard
python3 bench/run.py           # the benchmark (uses your Claude Code login)
python3 bench/report.py        # tables for REPORT.md
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE): derived from pi-clm (MIT). No code from
the CC BY-NC research repository is included.

## Citation

```bibtex
@article{shao2026context,
  title   = {Context Language Models},
  author  = {Shao, Rulin and Shen, Shannon Zejiang and Yin, Junjie Oscar and Li, Yuetai and
             Wang, Minheng and Ivison, Hamish and Poovendran, Radha and Lambert, Nathan and
             Xiao, Teng and Lewis, Mike and Yih, Wen-tau and Zettlemoyer, Luke and Koh, Pang Wei},
  journal = {arXiv preprint arXiv:2609.37725},
  year    = {2026}
}
```
