#!/usr/bin/env python3
"""Regenerate the script table in README.md from each script's ==UserScript== header.

Layout expected:  <folder>/<folder>.user.js   (optionally <folder>/README.md for details)
The table is written between the BEGIN/END markers in README.md; everything else is left alone.
Run from anywhere:  python3 tools/build_readme.py   (add --check to fail if README is out of date)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OWNER_REPO = "wolfyrion/tampermonkey-scripts"
BRANCH = "main"
RAW = f"https://raw.githubusercontent.com/{OWNER_REPO}/{BRANCH}"
BEGIN, END = "<!-- BEGIN SCRIPTS -->", "<!-- END SCRIPTS -->"


def header(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"==UserScript==(.*?)==/UserScript==", text, re.S)
    meta: dict = {}
    for line in (m.group(1) if m else "").splitlines():
        km = re.match(r"\s*//\s*@(\S+)\s+(.*\S)", line)
        if km:
            meta.setdefault(km.group(1), km.group(2))
    return meta


def cell(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ").strip()


def build_table() -> str:
    rows = []
    for js in sorted(ROOT.glob("*/*.user.js"), key=lambda p: header(p).get("name", p.stem).lower()):
        folder = js.parent.name
        meta = header(js)
        name = meta.get("name", folder)
        has_page = (js.parent / "README.md").exists()
        title = f"[{cell(name)}]({folder}/)" if has_page else cell(name)
        install = f"[Install]({RAW}/{folder}/{js.name})"
        rows.append(f"| {title} | {cell(meta.get('version', '?'))} | {cell(meta.get('description', ''))} | {install} |")
    head = [f"{len(rows)} script{'s' if len(rows) != 1 else ''}. Click **Install** with Tampermonkey enabled; updates arrive automatically.",
            "",
            "| Script | Version | Description | |",
            "|---|---|---|---|"]
    return "\n".join(head + rows)


def main() -> int:
    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    if BEGIN not in text or END not in text:
        sys.exit(f"README.md is missing the {BEGIN} / {END} markers")
    new = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END),
                 lambda _: f"{BEGIN}\n{build_table()}\n{END}", text, flags=re.S)
    if "--check" in sys.argv:
        if new != text:
            print("README.md is out of date: run python3 tools/build_readme.py")
            return 1
        return 0
    if new != text:
        readme.write_text(new, encoding="utf-8")
        print("README.md updated")
    else:
        print("README.md already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
