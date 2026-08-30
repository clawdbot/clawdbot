#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import sys


INPUT_INTERPOLATION_RE = re.compile(r"\$\{\{\s*inputs\.")
RUN_LINE_RE = re.compile(r"^(\s*)run:\s*(.*)$")
USING_COMPOSITE_RE = re.compile(r"^\s*using:\s*composite\s*$", re.MULTILINE)


def indentation(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def scan_file(path: pathlib.Path) -> list[tuple[int, str]]:
    text = path.read_text(encoding="utf-8")
    if not USING_COMPOSITE_RE.search(text):
        return []

    lines = text.splitlines()
    violations: list[tuple[int, str]] = []
    line_count = len(lines)
    index = 0

    while index < line_count:
        line = lines[index]
        match = RUN_LINE_RE.match(line)
        if not match:
            index += 1
            continue

        run_indent = len(match.group(1))
        run_value = match.group(2).strip()
        line_no = index + 1

        if run_value and run_value[0] not in ("|", ">"):
            if INPUT_INTERPOLATION_RE.search(run_value):
                violations.append((line_no, line.strip()))
            index += 1
            continue

        index += 1
        while index < line_count:
            script_line = lines[index]
            if script_line.strip() == "":
                index += 1
                continue
            if indentation(script_line) <= run_indent:
                break
            if INPUT_INTERPOLATION_RE.search(script_line):
                violations.append((index + 1, script_line.strip()))
            index += 1

    return violations


def main() -> int:
    root = pathlib.Path(".github/actions")
    files = sorted(root.rglob("action.y*ml"))
    all_violations: list[tuple[pathlib.Path, int, str]] = []

    for file_path in files:
        for line_no, line in scan_file(file_path):
            all_violations.append((file_path, line_no, line))

    if all_violations:
        print("Disallowed direct inputs interpolation in composite run blocks:")
        for file_path, line_no, line in all_violations:
            print(f"- {file_path}:{line_no}: {line}")
        print("Use env: and reference shell variables instead.")
        return 1

    print("No direct inputs interpolation found in composite run blocks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
