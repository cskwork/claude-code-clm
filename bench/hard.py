"""Second quiz: incidental details the session saw but did not dwell on.

The key-fact quiz alone saturates (both arms near 100%), so this asks for details
that sat in tool output or in passing: what a summary is most likely to drop.
Each run's quizzed session is forked (no new compaction), so the arms are compared
on the very contexts the first quiz measured. The previous quiz's answers hold none
of these details. Only questions the uncompacted ceiling answers count.

Usage: python3 bench/hard.py [scenario ...]   (after run.py; adds "hard" to each run)
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cc import run  # noqa: E402
from run import RESULTS, WORK  # noqa: E402

HARD = {
    "incident": [
        ("What is the payment gateway endpoint URL in config.yaml?", [r"pg\.internal/v2"]),
        ("What state is the payment gateway circuit breaker set to in config.yaml?", [r"half-?open"]),
        ("What phone number is dialed for the escalation bridge?", [r"650\D*555\D*0100"]),
        ("Which version was deployed right after v3.18.2, and by whom?", [r"v?3\.18\.3", r"jlee"]),
        ("At what time was v3.18.1 deployed?", [r"02:41"]),
        ("What kind of error do the pg-east-1 ERROR lines report?", [r"reset"]),
        ("On which line of app.log is the out-of-order 03:17:42 ERROR?", [r"\b421\b"]),
        ("What request id does that out-of-order line carry?", [r"rq-?88213"]),
    ],
    "migration": [
        ("What is the column type of invoice_lines.tax_code?", [r"VARCHAR\s*\(\s*8\s*\)"]),
        ("What is the name of the money column in invoice_lines?", [r"amount_minor"]),
        ("What is the size in MB of crm.contacts_legacy?", [r"1,?312"]),
        ("How many table rows does table_stats.csv list (excluding the header)?", [r"\b501\b"]),
        ("Which team confirmed dropping tax_code?", [r"finance"]),
        ("At what time was the tax_code decision made?", [r"15:37"]),
        ("Who owns billing.invoice_lines in table_stats.csv?", [r"finance"]),
        ("Is invoice_lines.invoice_id nullable?", [r"NOT NULL|not nullable|\bno\b"]),
    ],
    "vendors": [
        ("What service credits does Atlas give for missing its SLA?", [r"10\s*%", r"0\.1\s*%"]),
        ("Which regions does Atlas offer for data residency?", [r"Frankfurt|EU", r"Oregon|US"]),
        ("Besides Seoul, which regions does Borealis offer?", [r"Tokyo", r"Singapore"]),
        ("What is Cirrus's yearly query cost at 40 million queries?", [r"20,?000|20\s*k"]),
        ("What minimum commitment does Borealis require?", [r"\bno\b|none|no minimum"]),
        ("What is Atlas's SLA?", [r"99\.95"]),
        ("Which vendors meet a 99.95% SLA?", [r"Atlas", r"Cirrus"]),
        ("What P1 response time does Cirrus promise?", [r"15\s*min"]),
    ],
}

HEAD = (
    "Second quiz, different questions. Answer each from what you remember of this "
    "conversation. Do not use any tools and do not guess: write 'unknown' if it is not in "
    "your context. Reply with exactly {n} numbered lines in the form 'N. answer', nothing else.\n\n"
)


def prompt(quiz):
    return HEAD.format(n=len(quiz)) + "\n".join(f"{i}. {q}" for i, (q, _) in enumerate(quiz, 1))


def grade(answer, quiz):
    lines = {}
    for line in answer.splitlines():
        m = re.match(r"^\s*\**(\d+)[.)]\**\s*(.*)$", line)
        if m:
            lines.setdefault(int(m.group(1)), m.group(2))
    return [bool(lines.get(i)) and all(re.search(p, lines[i], re.I) for p in pats) for i, (_, pats) in enumerate(quiz, 1)]


def main(names):
    for name, quiz in HARD.items():
        if names and name not in names:
            continue
        path = RESULTS / f"{name}.json"
        data = json.loads(path.read_text())
        for r in data["runs"]:
            if "hard" in r:
                continue
            out = run(prompt(quiz), WORK / name, resume=r["quiz"]["session"], fork=True, clm=r["arm"] == "clm", tools="")
            r["hard"] = {"result": (out.get("result") or "")[:4000], "marks": grade(out.get("result") or "", quiz)}
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
            print(f"[{name}] hard {r['arm']} #{r['repeat']}: {sum(r['hard']['marks'])}/{len(quiz)}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
