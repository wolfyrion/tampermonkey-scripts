#!/usr/bin/env python3
"""Regenerate the script table in README.md.

Each script lives in its own repo. scripts.json lists them as {"repo": "owner/name", "file": "x.user.js"}.
For every entry this reads the ==UserScript== header from the repo's main branch and writes one table row
(name -> repo, version, description, install link) between the BEGIN/END markers in README.md.

    python3 tools/build_readme.py            # fetch headers from GitHub
    python3 tools/build_readme.py --check    # exit 1 if README.md is out of date
To add a script: add a line to scripts.json and push. GitHub Actions also re-runs this daily so versions stay current.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BEGIN, END = "<!-- BEGIN SCRIPTS -->", "<!-- END SCRIPTS -->"


def raw_url(repo: str, file: str, branch: str = "main") -> str:
    return f"https://raw.githubusercontent.com/{repo}/{branch}/{file}"


def header(text: str) -> dict:
    m = re.search(r"==UserScript==(.*?)==/UserScript==", text, re.S)
    meta: dict = {}
    for line in (m.group(1) if m else "").splitlines():
        km = re.match(r"\s*//\s*@(\S+)\s+(.*\S)", line)
        if km:
            meta.setdefault(km.group(1), km.group(2))
    return meta


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "tampermonkey-scripts-index"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def cell(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ").strip()


def build_table() -> str:
    entries = json.loads((ROOT / "scripts.json").read_text(encoding="utf-8"))
    rows = []
    for e in entries:
        url = raw_url(e["repo"], e["file"], e.get("branch", "main"))
        try:
            meta = header(fetch(url))
        except Exception as exc:  # keep the row even if a repo is briefly unreachable
            print(f"warning: {e['repo']}: {exc}", file=sys.stderr)
            meta = {}
        name = meta.get("name", e["repo"].split("/")[1])
        rows.append((name.lower(),
                     f"| [{cell(name)}](https://github.com/{e['repo']}) | {cell(meta.get('version', '?'))} "
                     f"| {cell(meta.get('description', ''))} | [Install]({url}) |"))
    rows.sort()
    n = len(rows)
    return "\n".join([f"{n} script{'s' if n != 1 else ''}.", "",
                      "| Script | Version | Description | |", "|---|---|---|---|"] + [r for _, r in rows])


def main() -> int:
    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    if BEGIN not in text or END not in text:
        sys.exit(f"README.md is missing the {BEGIN} / {END} markers")
    new = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END),
                 lambda _: f"{BEGIN}\n{build_table()}\n{END}", text, flags=re.S)
    if "--check" in sys.argv:
        return 0 if new == text else 1
    if new != text:
        readme.write_text(new, encoding="utf-8")
        print("README.md updated")
    else:
        print("README.md already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
