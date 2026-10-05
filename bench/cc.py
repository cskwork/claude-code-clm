"""Thin wrapper over `claude -p` for the benchmark: one call, JSON result."""

import json
import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL = os.environ.get("BENCH_MODEL", "claude-sonnet-5-5")
# User settings are left out so personal hooks, memory plugins and MCP servers
# do not leak into either arm.
BASE = ["--output-format", "json", "--setting-sources", "project,local", "--strict-mcp-config", "--model", MODEL]


def run(prompt, cwd, *, session=None, resume=None, fork=False, clm=False, tools=None, timeout=1800, extra=()):
    # The prompt goes first: --tools takes every value after it.
    args = ["claude", "-p", prompt] + BASE
    if session:
        args += ["--session-id", session]
    if resume:
        args += ["--resume", resume]
    if fork:
        args.append("--fork-session")
    if clm:
        args += ["--plugin-dir", str(ROOT)]
    if tools is not None:
        args += ["--tools", tools]
    args += list(extra)
    started = time.time()
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"claude failed ({proc.returncode}): {proc.stdout[-2000:]} {proc.stderr[-2000:]}")
    out["wall_s"] = round(time.time() - started, 1)
    return out


def context_tokens(out):
    """Input tokens of the last request: what the model held in context."""
    usage = out.get("usage") or {}
    return (
        usage.get("input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
    )
