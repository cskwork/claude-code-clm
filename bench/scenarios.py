"""Three long working sessions, each with 20 planted facts and a quiz.

Every fact comes from one of four places, so the benchmark shows *what kind* of
context each compaction keeps:
  user     - stated by the user in a prompt (decisions, constraints, names)
  tool     - buried in a file the model read (exact values among noise)
  derived  - a number the model computed from a file
  update   - a value the user later changed (the quiz asks for the latest,
             or for the superseded one explicitly)
Files are seeded noise of ~30-60 KB with the facts planted inside.
"""

import random

# ---------------------------------------------------------------- generators


def _rng(seed):
    return random.Random(seed)


def app_log(seed=1):
    r = _rng(seed)
    hosts = ["pg-east-1", "pg-west-2", "pg-central-3"]
    lines = []
    west = east = 0
    for i in range(1400):
        t = f"2026-10-04T0{2 + i // 700}:{(i // 12) % 60:02d}:{(i * 7) % 60:02d}Z"
        if i in range(420, 1400, 26) and west < 37:
            west += 1
            lines.append(f"{t} ERROR payment-gw timeout req=rq-{r.randint(10000, 99999)} upstream=pg-west-2")
        elif i in (610, 811, 1003, 1207):
            east += 1
            lines.append(f"{t} ERROR payment-gw reset req=rq-{r.randint(10000, 99999)} upstream=pg-east-1")
        else:
            lines.append(
                f"{t} INFO {r.choice(['cart', 'auth', 'search', 'payment-gw'])} ok "
                f"req=rq-{r.randint(10000, 99999)} upstream={r.choice(hosts)} {r.randint(5, 400)}ms"
            )
    first = next(i for i, line in enumerate(lines) if " ERROR " in line)
    lines[first] = "2026-10-04T03:17:42Z ERROR payment-gw timeout req=rq-88213 upstream=pg-west-2"
    assert west == 37 and east == 4
    return "\n".join(lines) + "\n"


def config_yaml(seed=2):
    r = _rng(seed)
    out = []
    services = ["search", "cart", "auth", "inventory", "pricing", "email", "ledger", "media", "geo", "fraud"]
    for s in services:
        out.append(f"{s}:")
        for k in range(30):
            out.append(f"  {r.choice(['pool', 'cache', 'queue', 'limit', 'window'])}_{k}: {r.randint(1, 9000)}")
    out.insert(len(out) // 2, "payment_gateway:\n  endpoint: https://pg.internal/v2\n  timeout_ms: 2500\n  retries: 7\n  circuit_breaker: half-open")
    return "\n".join(out) + "\n"


def deploy_history(seed=3):
    r = _rng(seed)
    rows = ["timestamp,service,version,author,status"]
    authors = ["jlee", "akim", "spark", "tnguyen", "rgarcia"]
    for _ in range(600):
        rows.append(
            f"2026-{r.randint(7, 9):02d}-{r.randint(1, 28):02d}T{r.randint(0, 23):02d}:{r.randint(0, 59):02d}Z,"
            f"{r.choice(['cart', 'search', 'auth', 'checkout'])},v3.{r.randint(1, 17)}.{r.randint(0, 9)},{r.choice(authors)},ok"
        )
    rows.append("2026-10-04T02:41:00Z,checkout,v3.18.1,akim,ok")
    rows.append("2026-10-04T03:05:00Z,checkout,v3.18.2,mkoh,ok")
    rows.append("2026-10-04T05:30:00Z,search,v3.18.3,jlee,ok")
    return "\n".join(rows) + "\n"


def runbook(seed=4):
    r = _rng(seed)
    words = "verify the dashboard check alerts confirm with the owner record the timeline restart pods drain traffic".split()
    out = ["# Checkout incident runbook", ""]
    for step in range(1, 31):
        title = "Flush the edge cache" if step == 14 else f"Procedure {step}"
        out.append(f"## Step {step}: {title}")
        for _ in range(12):
            out.append(" ".join(r.choice(words) for _ in range(16)) + ".")
        out.append("")
    out.insert(200, "Escalation phone bridge: dial +1 650 555 0100 and enter bridge code 914-220-7781.")
    return "\n".join(out) + "\n"


def table_stats(seed=5):
    r = _rng(seed)
    rows = ["schema,table,rows,size_mb,owner"]
    for i in range(500):
        rows.append(f"{r.choice(['core', 'billing', 'crm', 'audit'])},t_{i:03d},{r.randint(1000, 9_000_000)},{r.randint(1, 4000)},{r.choice(['data-eng', 'platform', 'finance'])}")
    rows.insert(233, "billing,invoice_lines,48213907,18240,finance")
    rows.insert(377, "crm,contacts_legacy,2210554,1312,platform")
    return "\n".join(rows) + "\n"


def schema_sql(seed=6):
    r = _rng(seed)
    out = []
    for i in range(160):
        out.append(f"CREATE TABLE t_{i:03d} (")
        for c in range(r.randint(5, 12)):
            out.append(f"  col_{c} {r.choice(['INT', 'BIGINT', 'TEXT', 'TIMESTAMPTZ', 'NUMERIC(12,2)', 'BOOLEAN'])},")
        out.append("  PRIMARY KEY (col_0)\n);")
    out.insert(
        700,
        "CREATE TABLE invoice_lines (\n  id BIGINT PRIMARY KEY,\n  invoice_id BIGINT NOT NULL,\n"
        "  amount_minor BIGINT NOT NULL,  -- money stored in minor units (cents)\n"
        "  currency CHAR(3) NOT NULL DEFAULT 'KRW',\n  tax_code VARCHAR(8)  -- legacy field, nullable\n);",
    )
    return "\n".join(out) + "\n"


def meeting_notes(seed=7):
    r = _rng(seed)
    chatter = [
        "Someone asked about the dashboard colors.",
        "We revisited the naming of the staging buckets.",
        "General agreement that the wiki needs cleanup.",
        "A long tangent about lunch options followed.",
        "The group discussed hiring timelines briefly.",
    ]
    out = ["# Migration sync - transcript notes", ""]
    for i in range(420):
        out.append(f"- [{i // 30 + 9:02d}:{i % 60:02d}] {r.choice(chatter)}")
    out.insert(150, "- [14:02] DECISION: cutover uses dual-write for 72 hours before switching reads.")
    out.insert(301, "- [15:37] DECISION: the legacy tax_code column is dropped, not migrated; finance confirmed (ticket FIN-2290).")
    return "\n".join(out) + "\n"


def vendor_doc(name, seed, planted):
    r = _rng(seed)
    filler = "the service provides scalable reliable secure compliant flexible managed integrated enterprise features".split()
    out = [f"# {name} - product and commercial terms", ""]
    for sec in range(40):
        out.append(f"## Section {sec + 1}")
        for _ in range(8):
            out.append(" ".join(r.choice(filler) for _ in range(18)) + ".")
        out.append("")
    for pos, line in planted:
        out.insert(pos, line)
    return "\n".join(out) + "\n"


# ----------------------------------------------------------------- scenarios

# app.log's timestamps are not in file order, so the planted line 421 (03:17:42) is
# not the earliest ERROR. The base session resolved this by timestamp: first ERROR
# 02:37:02, rq-85805, and the deploy before it cart v3.16.7 by tnguyen. The quiz asks
# for what the session established, which is what compaction has to keep.
INCIDENT = {
    "name": "incident",
    "files": {
        "app.log": app_log,
        "config.yaml": config_yaml,
        "deploy_history.csv": deploy_history,
        "runbook.md": runbook,
    },
    "turns": [
        "We're investigating the checkout outage, incident INC-4471. Our on-call lead is Priya Raman, and the RCA is due to the customer on Friday 2026-10-09 17:00 KST. Read app.log in full and tell me the first ERROR line: its timestamp, request id and upstream.",
        "Read config.yaml and tell me the payment gateway timeout and retry count.",
        "Read deploy_history.csv. Which deploy went out right before the first error? Give version, author and time.",
        "Decision for the record: we roll back checkout to v3.18.1 instead of hotfixing, because the hotfix needs a schema change. The rollback window is 04:00-04:30 KST. The feature flag fast-checkout must stay OFF until QA signs off. Acknowledge briefly.",
        "Count exactly how many ERROR lines in app.log have upstream=pg-west-2 and how many have upstream=pg-east-1.",
        "Change of plan: the RCA deadline moved to Monday 2026-10-12 12:00 KST, and Priya handed on-call to Daniel Cho. Acknowledge briefly.",
        "Read runbook.md in full. What is the escalation phone bridge code, and which step number flushes the edge cache?",
        "Draft a three-line status update for the incident channel.",
    ],
    "quiz": [
        ("What is the incident id?", [r"INC-?4471"]),
        ("Who is on call now?", [r"Daniel\s+Cho"]),
        ("Who was the on-call lead before the handover?", [r"Priya"]),
        ("What is the current RCA deadline (date and time)?", [r"10-12|Oct(ober)?\s*12|12\s*Oct", r"12:00|noon|12\s*(pm|PM)"]),
        ("What was the original RCA deadline date?", [r"10-09|Oct(ober)?\s*9|9\s*Oct"]),
        ("What is the timestamp of the first ERROR line?", [r"02:37:02"]),
        ("What request id did the first ERROR line carry?", [r"rq-?85805"]),
        ("Which upstream did the first ERROR hit?", [r"pg-west-2"]),
        ("What is the payment gateway timeout in config.yaml?", [r"2500|2\.5\s*s"]),
        ("What is the payment gateway retry count?", [r"\b7\b|seven"]),
        ("Which version was deployed right before the first error?", [r"v?3\.16\.7"]),
        ("Who authored that deploy?", [r"tnguyen"]),
        ("Which version are we rolling back to?", [r"v?3\.18\.1"]),
        ("Why roll back instead of hotfixing?", [r"schema"]),
        ("What is the rollback window?", [r"04:00", r"04:30"]),
        ("Which feature flag must stay off, and until when?", [r"fast-checkout", r"QA"]),
        ("How many ERROR lines have upstream=pg-west-2?", [r"\b37\b"]),
        ("How many ERROR lines have upstream=pg-east-1?", [r"\b4\b|four"]),
        ("What is the escalation bridge code?", [r"914-?220-?7781"]),
        ("Which runbook step flushes the edge cache?", [r"\b14\b"]),
    ],
}

MIGRATION = {
    "name": "migration",
    "files": {
        "table_stats.csv": table_stats,
        "schema_old.sql": schema_sql,
        "meeting_notes.md": meeting_notes,
    },
    "turns": [
        "We're planning the Postgres 13 to 17 migration, project code MIG-PG17, for the billing cluster. Hard constraint from the CFO: no more than 15 minutes of write downtime. The DBA owner is Mina Seo. Read table_stats.csv in full and tell me the largest billing table, its row count and size.",
        "Read schema_old.sql in full. How is money stored in invoice_lines, what is the default currency, and which column is legacy?",
        "Read meeting_notes.md in full and list every DECISION line with its time.",
        "Compute from table_stats.csv: how many tables are owned by finance, and what is the total size_mb of the crm schema? Give exact numbers.",
        "Decision: we use logical replication with pglogical, not pg_upgrade --link, because we need the 15-minute window and a rollback path. The target instance is db-billing-17a in ap-northeast-2. Acknowledge briefly.",
        "Update: the migration date moves from 2026-11-07 to 2026-11-21, and the CFO relaxed the downtime limit to 30 minutes. Acknowledge briefly.",
        "Which table in table_stats.csv is crm.contacts_legacy, how many rows does it have, and who owns it?",
        "Write a five-bullet migration checklist based on everything so far.",
    ],
    "quiz": [
        ("What is the project code?", [r"MIG-?PG17"]),
        ("Who is the DBA owner?", [r"Mina\s+Seo"]),
        ("What is the current write-downtime limit?", [r"\b30\b"]),
        ("What was the original write-downtime limit?", [r"\b15\b"]),
        ("What is the current migration date?", [r"11-21|Nov(ember)?\s*21|21\s*Nov"]),
        ("What was the original migration date?", [r"11-07|Nov(ember)?\s*0?7|0?7\s*Nov"]),
        ("What is the largest billing table?", [r"invoice_lines"]),
        ("How many rows does it have?", [r"48,?213,?907|48\.2\s*M"]),
        ("What is its size in MB?", [r"18,?240"]),
        ("How is money stored in invoice_lines?", [r"minor|cents"]),
        ("How many tables in table_stats.csv are owned by finance?", "excluded:derived:finance_tables"),
        ("Which column is legacy?", [r"tax_code"]),
        ("What happens to that legacy column, and which ticket confirms it?", [r"drop", r"FIN-?2290"]),
        ("How long is dual-write before switching reads?", [r"\b72\b"]),
        ("At what time was the dual-write decision made?", [r"14:02"]),
        ("Which replication approach was chosen?", [r"pglogical|logical replication"]),
        ("What is the total size_mb of the crm schema?", "excluded:derived:crm_size"),
        ("What is the target instance and region?", [r"db-billing-17a", r"ap-northeast-2"]),
        ("How many rows does crm.contacts_legacy have?", [r"2,?210,?554|2\.21\s*M"]),
        ("Who owns crm.contacts_legacy?", [r"platform"]),
    ],
}

VENDORS = {
    "name": "vendors",
    "files": {
        "vendor_atlas.md": lambda: vendor_doc("Atlas Cloud Search", 11, [
            (120, "Pricing: USD 0.42 per 1,000 queries; minimum commitment USD 18,000 per year."),
            (260, "SLA: 99.95% monthly uptime; service credits of 10% per 0.1% below."),
            (330, "Data residency: EU (Frankfurt) and US (Oregon) only."),
        ]),
        "vendor_borealis.md": lambda: vendor_doc("Borealis Search", 12, [
            (90, "Pricing: USD 0.35 per 1,000 queries; no minimum commitment; egress billed at USD 0.09/GB."),
            (210, "SLA: 99.9% monthly uptime."),
            (300, "Data residency: Seoul (ap-northeast-2), Tokyo and Singapore."),
            (305, "Certification: ISMS-P certified since 2025-03."),
        ]),
        "vendor_cirrus.md": lambda: vendor_doc("Cirrus Find", 13, [
            (140, "Pricing: USD 0.50 per 1,000 queries; 20% discount on a 3-year term."),
            (240, "SLA: 99.99% monthly uptime with a 15-minute P1 response time."),
            (310, "Data residency: Seoul (ap-northeast-2) via partner Hanbit IDC."),
        ]),
    },
    "turns": [
        "I'm choosing a hosted search vendor for project LUMEN. Budget ceiling is USD 25,000 per year at about 40 million queries per year. Korean customer data must stay in Korea. The final decision-maker is our CTO, Jae-won Park. Read vendor_atlas.md in full and summarize price, SLA and data residency.",
        "Read vendor_borealis.md in full and summarize price, SLA, residency and any certification.",
        "Read vendor_cirrus.md in full and summarize price, SLA and data residency.",
        "Compute the yearly query cost at 40 million queries for each vendor, ignoring minimums, discounts and egress. Give exact USD numbers.",
        "Atlas is out because of data residency. Between the other two, my preference is Borealis because of ISMS-P. Acknowledge briefly.",
        "Update: legal now requires a 99.95% or better SLA, and the budget ceiling rose to USD 30,000. Does that change which vendor fits? Answer briefly.",
        "Which vendor charges for egress, and at what rate?",
        "Write a short recommendation memo to the CTO.",
    ],
    "quiz": [
        ("What is the project name?", [r"LUMEN"]),
        ("Who makes the final decision?", [r"Jae-?won\s+Park|Park"]),
        ("What is the current budget ceiling?", [r"30,?000|30\s*k"]),
        ("What was the original budget ceiling?", [r"25,?000|25\s*k"]),
        ("What yearly query volume are we planning for?", [r"40\s*(million|M)|40,000,000"]),
        ("What is the data residency requirement?", [r"Korea|Seoul"]),
        ("What is Atlas's price per 1,000 queries?", [r"0\.42"]),
        ("What is Atlas's minimum commitment?", [r"18,?000|18\s*k"]),
        ("Why was Atlas ruled out?", [r"residen|Korea|EU|region"]),
        ("What is Borealis's price per 1,000 queries?", [r"0\.35"]),
        ("What is Borealis's SLA?", [r"99\.9\b(?!5|9)|99\.9%"]),
        ("Which certification does Borealis hold, and since when?", [r"ISMS-?P", r"2025-?03|March 2025|Mar(ch)? 2025"]),
        ("What is Cirrus's price per 1,000 queries?", [r"0\.50|0\.5\b"]),
        ("What is Cirrus's SLA and P1 response time?", [r"99\.99", r"15"]),
        ("How does Cirrus keep data in Seoul?", [r"Hanbit"]),
        ("What is Cirrus's multi-year discount?", [r"20\s*%", r"3-?year|three"]),
        ("Yearly query cost for Atlas at 40M queries?", [r"16,?800"]),
        ("Yearly query cost for Borealis at 40M queries?", [r"14,?000"]),
        ("What SLA does legal now require?", [r"99\.95"]),
        ("What is Borealis's egress rate?", [r"0\.09"]),
    ],
}



# Excluded: in the base migration session the model was denied shell access
# (headless, no approvals) and declined to compute these, so the conversation never
# established a value. They stay in the quiz the runs answered but are not scored.


def derived(key, files):
    """Expected answers computed from the generated files themselves."""
    if key in ("finance_tables", "crm_size"):
        rows = [line.split(",") for line in files["table_stats.csv"].splitlines()[1:]]
        if key == "finance_tables":
            n = sum(1 for r in rows if r[4] == "finance")
        else:
            n = sum(int(r[3]) for r in rows if r[0] == "crm")
        return [rf"{n:,}|\b{n}\b".replace(",", ",?")]
    raise KeyError(key)


SCENARIOS = [INCIDENT, MIGRATION, VENDORS]
