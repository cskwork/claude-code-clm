"""Benchmark: Claude Code's native /compact vs CLM, on recall of planted facts.

For each scenario: build one long session (no plugin), then fork it per arm
and repeat, compact, and quiz with tools disabled.

  none    fork, no compaction, quiz                      (ceiling, 1 run)
  native  fork, /compact, quiz                           (Claude Code's summary)
  clm     fork with the plugin, /clm-compact, /compact   (model edits its mirror;
          the second call installs the edit), quiz

Usage: python3 bench/run.py [scenario ...] [--repeats N]
Results: bench/results/<scenario>.json (written after every step).
"""

import json
import os
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cc import context_tokens, run  # noqa: E402
from scenarios import SCENARIOS, derived  # noqa: E402

HERE = Path(__file__).parent
WORK = Path(os.environ.get("BENCH_WORK", Path.home() / "Downloads/Code/clm-bench-work"))
RESULTS = HERE / "results"
TMP = Path(os.environ.get("TMPDIR", "/tmp").rstrip("/")) / "claude-clm"

QUIZ_HEAD = (
    "Quiz time. Answer each question from what you remember of this conversation. "
    "Do not use any tools and do not guess: write 'unknown' if it is not in your context. "
    "Reply with exactly {n} numbered lines in the form 'N. answer', nothing else.\n\n"
)


def quiz_prompt(quiz):
    return QUIZ_HEAD.format(n=len(quiz)) + "\n".join(f"{i}. {q}" for i, (q, _) in enumerate(quiz, 1))


def grade(answer, quiz, files):
    lines = {}
    for line in answer.splitlines():
        m = re.match(r"^\s*\**(\d+)[.)]\**\s*(.*)$", line)
        if m:
            lines.setdefault(int(m.group(1)), m.group(2))
    marks = []
    for i, (_, expected) in enumerate(quiz, 1):
        if isinstance(expected, str) and expected.startswith("excluded:"):
            marks.append(None)
            continue
        patterns = derived(expected.split(":", 1)[1], files) if isinstance(expected, str) else expected
        got = lines.get(i, "")
        marks.append(bool(got) and all(re.search(p, got, re.I) for p in patterns))
    return marks


def clm_state(session):
    try:
        state = json.loads((TMP / session / "state.json").read_text())
        state.pop("snapshot", None)
        return state
    except (OSError, ValueError):
        return None


def save(name, data):
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / f"{name}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False))


def summarize_call(out):
    return {
        "session": out.get("session_id"),
        "context_tokens": context_tokens(out),
        "cost_usd": out.get("total_cost_usd"),
        "wall_s": out.get("wall_s"),
        "turns": out.get("num_turns"),
        "result": (out.get("result") or "")[:4000],
    }


def overhead(cwd, clm):
    """Context of a fresh session under the quiz's flags: what is not conversation."""
    out = run("Reply with OK.", cwd, clm=clm, tools="")
    return context_tokens(out)


def bench(scenario, repeats):
    name = scenario["name"]
    cwd = WORK / name
    cwd.mkdir(parents=True, exist_ok=True)
    files = {fname: make() for fname, make in scenario["files"].items()}
    for fname, text in files.items():
        (cwd / fname).write_text(text)

    path = RESULTS / f"{name}.json"
    data = json.loads(path.read_text()) if path.exists() else {"scenario": name, "runs": []}

    if "base" not in data:
        session = str(uuid.uuid4())
        turns = []
        for i, prompt in enumerate(scenario["turns"]):
            out = run(prompt, cwd, session=session if i == 0 else None, resume=None if i == 0 else session)
            turns.append(summarize_call(out))
            print(f"[{name}] base turn {i + 1}/{len(scenario['turns'])}: ctx {turns[-1]['context_tokens']}", flush=True)
        data["base"] = {"session": session, "turns": turns}
        save(name, data)

    if "overhead" not in data:
        data["overhead"] = {"native": overhead(cwd, False), "clm": overhead(cwd, True)}
        save(name, data)

    base = data["base"]["session"]
    quiz = scenario["quiz"]
    plan = [("none", 0)] + [(arm, r) for r in range(repeats) for arm in ("native", "clm")]
    done = {(r["arm"], r["repeat"]) for r in data["runs"]}
    for arm, rep in plan:
        if (arm, rep) in done:
            continue
        steps = []
        if arm == "none":
            q = run(quiz_prompt(quiz), cwd, resume=base, fork=True, tools="")
        elif arm == "native":
            c = run("/compact", cwd, resume=base, fork=True)
            steps.append(summarize_call(c))
            q = run(quiz_prompt(quiz), cwd, resume=c["session_id"], tools="")
        else:
            c = run("/clm-compact", cwd, resume=base, fork=True, clm=True)
            steps.append(summarize_call(c))
            a = run("/compact", cwd, resume=c["session_id"], clm=True)
            steps.append(summarize_call(a))
            q = run(quiz_prompt(quiz), cwd, resume=c["session_id"], clm=True, tools="")
        marks = grade(q.get("result") or "", quiz, files)
        record = {
            "arm": arm,
            "repeat": rep,
            "steps": steps,
            "quiz": summarize_call(q),
            "marks": marks,
            "score": sum(1 for m in marks if m),
            "conversation_tokens": context_tokens(q) - data["overhead"]["clm" if arm == "clm" else "native"],
        }
        if arm == "clm":
            record["clm_state"] = clm_state(q["session_id"])
            history = (record["clm_state"] or {}).get("history", [])
            # A CLM run counts only if the model's edit was installed, not a native fallback.
            record["clm_applied"] = any(h.get("kind") == "edit" for h in history)
        data["runs"].append(record)
        save(name, data)
        print(f"[{name}] {arm} #{rep}: {record['score']}/{sum(1 for m in marks if m is not None)}, conversation ~{record['conversation_tokens']} tokens", flush=True)


def main(argv):
    repeats = 3
    if "--repeats" in argv:
        i = argv.index("--repeats")
        repeats = int(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    chosen = [s for s in SCENARIOS if not argv or s["name"] in argv]
    for scenario in chosen:
        bench(scenario, repeats)


if __name__ == "__main__":
    main(sys.argv[1:])
