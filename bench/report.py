"""Turn bench/results/*.json into tables for REPORT.md (printed to stdout)."""

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from hard import HARD  # noqa: E402
from hard import grade as grade_hard  # noqa: E402
from run import grade  # noqa: E402
from scenarios import SCENARIOS  # noqa: E402

RESULTS = Path(__file__).parent / "results"
KINDS = {
    "incident": ["user", "update", "update", "update", "update", "tool", "tool", "tool", "tool", "tool",
                 "tool", "tool", "user", "user", "user", "user", "derived", "derived", "tool", "tool"],
    "migration": ["user", "user", "update", "update", "update", "update", "tool", "tool", "tool", "tool",
                  "derived", "tool", "tool", "tool", "tool", "user", "derived", "user", "tool", "tool"],
    "vendors": ["user", "user", "update", "update", "user", "user", "tool", "tool", "user", "tool",
                "tool", "tool", "tool", "tool", "tool", "tool", "derived", "derived", "update", "tool"],
}


def mean(xs):
    return statistics.mean(xs) if xs else float("nan")


def sd(xs):
    return statistics.stdev(xs) if len(xs) > 1 else 0.0


def main():
    rows = []
    by_kind = {}
    per_question = {}
    for sc in SCENARIOS:
        path = RESULTS / f"{sc['name']}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        files = {fname: make() for fname, make in sc["files"].items()}
        # Grade again from the stored answers, so a corrected key applies to every run.
        for r in data["runs"]:
            r["marks"] = grade(r["quiz"]["result"], sc["quiz"], files)
            r["score"] = sum(1 for m in r["marks"] if m)
            r["gradable"] = sum(1 for m in r["marks"] if m is not None)
        base_ctx = data["base"]["turns"][-1]["context_tokens"]
        for arm in ("none", "native", "clm"):
            runs = [r for r in data["runs"] if r["arm"] == arm]
            if not runs:
                continue
            scores = [100 * r["score"] / r["gradable"] for r in runs]
            conv = [r["conversation_tokens"] for r in runs]
            cost = [sum(s["cost_usd"] or 0 for s in r["steps"]) for r in runs]
            secs = [sum(s["wall_s"] or 0 for s in r["steps"]) for r in runs]
            rows.append((sc["name"], arm, len(runs), mean(scores), sd(scores), mean(conv), mean(cost), mean(secs)))
            for r in runs:
                for kind, mark in zip(KINDS[sc["name"]], r["marks"]):
                    if mark is None:
                        continue
                    hit, total = by_kind.get((arm, kind), (0, 0))
                    by_kind[(arm, kind)] = (hit + mark, total + 1)
                for i, mark in enumerate(r["marks"]):
                    if mark is None:
                        continue
                    hit, total = per_question.get((sc["name"], i, arm), (0, 0))
                    per_question[(sc["name"], i, arm)] = (hit + mark, total + 1)
        print(f"<!-- {sc['name']}: last base turn context {base_ctx} tokens -->")

    print("| Scenario | Arm | Runs | Recall % | SD (pts) | Conversation tokens after | Compaction cost (USD) | Compaction time (s) |")
    print("|---|---|---|---|---|---|---|---|")
    for name, arm, n, m, s, c, usd, sec in rows:
        print(f"| {name} | {arm} | {n} | {m:.0f}% | {s:.1f} | {c:,.0f} | {usd:.2f} | {sec:.0f} |")

    print()
    print("| Arm | Recall (all scenarios) | Conversation tokens after (mean) |")
    print("|---|---|---|")
    for arm in ("none", "native", "clm"):
        sel = [r for r in rows if r[1] == arm]
        if sel:
            total = sum(r[2] * r[3] for r in sel) / sum(r[2] for r in sel)
            print(f"| {arm} | {total:.1f}% | {mean([r[5] for r in sel]):,.0f} |")

    print()
    print("| Fact kind | none | native | clm |")
    print("|---|---|---|---|")
    for kind in ("user", "update", "tool", "derived"):
        cells = []
        for arm in ("none", "native", "clm"):
            hit, total = by_kind.get((arm, kind), (0, 0))
            cells.append(f"{hit}/{total} ({hit / total:.0%})" if total else "-")
        print(f"| {kind} | " + " | ".join(cells) + " |")

    print()
    print("Incidental details (second quiz), counting only questions the uncompacted ceiling answered:")
    print()
    print("| Scenario | none | native | clm |")
    print("|---|---|---|---|")
    totals = {}
    for sc in SCENARIOS:
        path = RESULTS / f"{sc['name']}.json"
        if not path.exists():
            continue
        runs = json.loads(path.read_text())["runs"]
        quiz = HARD[sc["name"]]
        for r in runs:
            if "hard" in r:
                r["hard"]["marks"] = grade_hard(r["hard"]["result"], quiz)
        ceiling = next((r["hard"]["marks"] for r in runs if r["arm"] == "none" and "hard" in r), None)
        if ceiling is None:
            continue
        keep = [i for i, m in enumerate(ceiling) if m]
        cells = []
        for arm in ("none", "native", "clm"):
            hits = sum(r["hard"]["marks"][i] for r in runs if r["arm"] == arm and "hard" in r for i in keep)
            total = sum(1 for r in runs if r["arm"] == arm and "hard" in r) * len(keep)
            h, t = totals.get(arm, (0, 0))
            totals[arm] = (h + hits, t + total)
            cells.append(f"{hits}/{total} ({hits / total:.0%})" if total else "-")
        print(f"| {sc['name']} | " + " | ".join(cells) + " |")
    if totals:
        print("| all | " + " | ".join(f"{h}/{t} ({h / t:.0%})" if t else "-" for h, t in (totals.get(a, (0, 0)) for a in ("none", "native", "clm"))) + " |")

    print()
    applied = [r.get("clm_applied") for sc in SCENARIOS if (RESULTS / f"{sc['name']}.json").exists()
               for r in json.loads((RESULTS / f"{sc['name']}.json").read_text())["runs"] if r["arm"] == "clm"]
    print(f"CLM runs whose own edit was installed (not a native fallback): {sum(1 for a in applied if a)}/{len(applied)}")

    print()
    print("Questions where the arms differ (hits / runs):")
    print()
    print("| Scenario | # | Question | native | clm |")
    print("|---|---|---|---|---|")
    for sc in SCENARIOS:
        for i, (q, _) in enumerate(sc["quiz"]):
            n = per_question.get((sc["name"], i, "native"))
            c = per_question.get((sc["name"], i, "clm"))
            if n and c and n[0] / n[1] != c[0] / c[1]:
                print(f"| {sc['name']} | {i + 1} | {q} | {n[0]}/{n[1]} | {c[0]}/{c[1]} |")


if __name__ == "__main__":
    main()
