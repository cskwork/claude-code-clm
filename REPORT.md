# CLM vs Claude Code's `/compact`: which keeps important context?

**Short answer:** in this benchmark CLM kept every planted fact. Native `/compact` lost 4
answers out of 243, all in one migration run. Both are close to the ceiling, so the gap
is small. Native `/compact` left a smaller context (5.6k vs 7.9k tokens on average) and
cost about half as much to run.

| | no compaction (ceiling) | native `/compact` | CLM |
|---|---|---|---|
| key facts recalled | 100% | 99.4% (173/174) | **100%** (174/174) |
| incidental details recalled | 100% | 96% (66/69) | **100%** (69/69) |
| conversation tokens after compaction | 45.8k | **5.6k** | 7.9k |
| compaction cost per run (API-equivalent USD) | – | **0.30–0.48** | 0.65–1.07 |
| compaction time per run | – | 19–25 s | 16–20 s |

Date: 2026-10-06. Claude Code 2.1.290, `claude-sonnet-5-5` for every call in both arms.

## Setup

**Sessions.** There are three synthetic working sessions of 8 turns each. In each one
Claude reads 3–4 files of 5–105 KB of seeded noise with facts planted inside, and the
user states decisions and later changes some of them:

- `incident`: checkout outage, with a log, config, deploy history and runbook
- `migration`: Postgres migration plan, with table stats, schema and meeting notes
- `vendors`: hosted-search vendor choice, with three vendor documents

Each session ends at 29–55k tokens of conversation. The generators, turns and quizzes are
in [bench/scenarios.py](bench/scenarios.py).

**Arms.** Each session is built once without the plugin, then forked per run, so every
arm compacts the same conversation.

- `none`: no compaction, then the quiz. This is the ceiling (1 run).
- `native`: `/compact`, which is Claude Code's own summary (3 runs).
- `clm`: with the plugin, `/clm-compact`, where Claude edits its mirror with the
  `context_edit` tool, then `/compact`, which installs that edit (3 runs). Every CLM run
  is checked: in 9 of 9 the model's own edit was installed, not a native fallback.

**Quizzes.** Both quizzes run with tools disabled, so answers come from context only.

- Key facts: 20 questions per scenario about names, decisions, superseded values and
  exact values from tool output. Answers are graded by regex.
- Incidental details: 8 questions per scenario about details that sat in tool output
  but were never discussed. These are asked on a fork of each compacted session, so no
  second compaction runs. A question counts only if the uncompacted ceiling answered it.

**Isolation.** User settings, hooks and MCP servers are off (`--setting-sources
project,local --strict-mcp-config`). Without that, connector tool lists made a fresh
session's context swing between 3.6k and 118k tokens. "Conversation tokens after" is the
quiz request's input tokens minus a fresh session's under the same flags (3,643 native;
4,995 with CLM, whose protocol and steering add about 1.35k).

## Results

| Scenario | Arm | Runs | Key-fact recall | Conversation tokens after | Compaction cost (USD) |
|---|---|---|---|---|---|
| incident | none | 1 | 100% | 28,698 | – |
| incident | native | 3 | 100% | 7,763 | 0.30 |
| incident | clm | 3 | 100% | 4,990 | 0.65 |
| migration | none | 1 | 100% | 55,116 | – |
| migration | native | 3 | 98% | 4,507 | 0.48 |
| migration | clm | 3 | 100% | 7,272 | 1.07 |
| vendors | none | 1 | 100% | 53,663 | – |
| vendors | native | 3 | 100% | 4,624 | 0.42 |
| vendors | clm | 3 | 100% | 11,506 | 0.90 |

By kind of fact (key-fact quiz, all runs):

| Fact kind | native | clm |
|---|---|---|
| stated by the user | 42/42 | 42/42 |
| later updated by the user | 33/33 | 33/33 |
| from tool output | 86/87 | 87/87 |
| computed by the model | 12/12 | 12/12 |

Incidental details:

| Scenario | native | clm |
|---|---|---|
| incident | 21/21 | 21/21 |
| migration | 21/24 | 24/24 |
| vendors | 24/24 | 24/24 |

Every native miss was in migration run #3. Its summary dropped:

- the time of the dual-write decision (14:02), which was a key fact
- the table count, the team that confirmed dropping `tax_code`, and the time of that
  decision, which were incidental details

The other two native runs kept all of them.

## What the edits looked like

CLM did not edit surgically in most runs. In 5 of 9 runs Claude deleted almost every block
and wrote one detailed notes block after the first user message, which is a summary in
the model's own words. In vendors, all three runs kept the 21 original message blocks
and deleted only the 6 large tool outputs, adding one notes block. Those runs were the
largest after compaction (11.5k). The remaining migration run sat in between: it kept 18
blocks and deleted 28.

Two things explain the higher cost: the model reads the block list and writes its edit
inside a normal turn, and the context it leaves is larger.

## Reading the result

- **On preservation, CLM was at least as good, and better on one run in nine.** With 3
  runs per arm and scores at the ceiling, this is a weak signal, not a demonstrated gap.
  The native miss was variance between summaries of the same session.
- **Native `/compact` is leaner and cheaper.** CLM's notes blocks were longer than
  Claude Code's summaries, and when the model chose to keep original messages, much
  longer.
- **Sessions of 40–70k tokens are not where compaction strategies part ways.** Both kept
  nearly everything. The paper's gains come from long-horizon tasks that compact many
  times (12–24 hours), where losses compound. This benchmark compacts once.

## Caveats

- n = 3 per arm per scenario, and one ceiling run per scenario.
- The sessions are synthetic and short, and each is compacted once.
- Headless mode: CLM's edit is installed by `/compact` after the edit turn (see README).
  The interactive app does this automatically. Both were tested and installed the same
  edit.
- Grading corrections, applied to every arm alike from the stored answers by
  `bench/report.py`:
  - `incident`: the generated log's timestamps are not in file order. The base session
    resolved the "first error" by timestamp, so the four questions that depend on it are
    graded against what the session concluded (02:37:02, rq-85805, v3.16.7, tnguyen),
    not the planted line.
  - `migration`: two "computed" questions are excluded. In the base session the model
    was denied shell access and declined to compute them, so no value was ever
    established.
- Costs are the CLI's API-equivalent `total_cost_usd`. They were run on a subscription.

## What went wrong on the way

The first CLM version failed all 3 of its first runs, and every one fell back to a native
summary. Two Claude Code guards blocked ordinary file edits of the mirror:

- The mirror was re-rendered before every request, so the Edit tool saw "file modified
  since read".
- Write refuses a file it has not read in full, and Read stops at 25k tokens.

The fix was to render the mirror once per turn and add the `context_edit` tool (list
blocks, then replace/delete/add in one call). The tool calls that perform the edit are
also dropped from the installed context. The results above are from the fixed version
only. The failed runs were discarded and rerun.

## Reproduce

```sh
python3 bench/run.py              # builds sessions, runs all arms (resumable)
python3 bench/hard.py             # incidental-detail quiz on the compacted sessions
python3 bench/report.py           # the tables above
```

Raw answers, session ids and CLM edit histories are in `bench/results/*.json`.
