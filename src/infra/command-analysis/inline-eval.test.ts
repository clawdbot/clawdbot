import { describe, expect, it } from "vitest";
import type { InterpreterInlineEvalHit } from "./inline-eval.js";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
  isInterpreterLikeAllowlistPattern,
} from "./inline-eval.js";

function expectInlineEvalDescription(hit: InterpreterInlineEvalHit | null, expected: string) {
  if (hit === null) {
    throw new Error(`Expected inline eval hit for ${expected}`);
  }
  expect(describeInterpreterInlineEval(hit)).toBe(expected);
}

describe("exec inline eval detection", () => {
  it.each([
    { argv: ["python3", "-c", "print('hi')"], expected: "python3 -c" },
    { argv: ["/usr/bin/node", "--eval", "console.log('hi')"], expected: "node --eval" },
    { argv: ["perl", "-E", "say 1"], expected: "perl -e" },
    { argv: ["osascript", "-e", "beep"], expected: "osascript -e" },
    { argv: ["awk", "BEGIN { print 1 }"], expected: "awk inline program" },
    { argv: ["gawk", "-F", ",", "{print $1}", "data.csv"], expected: "gawk inline program" },
  ] as const)("detects interpreter eval flags for %j", ({ argv, expected }) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expectInlineEvalDescription(hit, expected);
  });

  it.each([
    { argv: ["awk", 'BEGIN{system("id")}', "/dev/null"], expected: "awk inline program" },
    {
      argv: ["awk", "-F", ",", 'BEGIN{system("id")}', "/dev/null"],
      expected: "awk inline program",
    },
    { argv: ["gawk", "-e", 'BEGIN{system("id")}', "/dev/null"], expected: "gawk -e" },
    {
      argv: ["gawk", "-f", "library.awk", '--source=BEGIN{system("id")}', "/dev/null"],
      expected: "gawk --source",
    },
    { argv: ["find", ".", "-exec", "id", "{}", ";"], expected: "find -exec" },
    { argv: ["find", "--", ".", "-exec", "id", "{}", ";"], expected: "find -exec" },
    { argv: ["find", ".", "-ok", "id", "{}", ";"], expected: "find -ok" },
    { argv: ["find", ".", "-okdir", "id", "{}", ";"], expected: "find -okdir" },
    { argv: ["xargs", "id"], expected: "xargs inline command" },
    { argv: ["xargs", "-I", "{}", "sh", "-c", "id"], expected: "xargs inline command" },
    { argv: ["xargs", "--replace", "id"], expected: "xargs inline command" },
    { argv: ["make", "-f", "evil.mk"], expected: "make -f" },
    { argv: ["make", "-E", "$(shell id)"], expected: "make -E" },
    { argv: ["make", "-E$(shell id)"], expected: "make -E" },
    { argv: ["make", "--eval=$(shell id)"], expected: "make --eval" },
    { argv: ["sed", "s/.*/id/e", "/dev/null"], expected: "sed inline program" },
    { argv: ["gsed", "-e", "s/.*/id/e", "/dev/null"], expected: "gsed -e" },
    { argv: ["sed", "-es/.*/id/e", "/dev/null"], expected: "sed -e" },
  ] as const)("detects command carriers for %j", ({ argv, expected }) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expectInlineEvalDescription(hit, expected);
  });

  it("ignores normal script execution", () => {
    expect(detectInterpreterInlineEvalArgv(["python3", "script.py"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["node", "script.js"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["awk", "-f", "script.awk", "data.csv"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["find", ".", "-name", "*.ts"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["xargs", "-0"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["make", "test"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["sed", "-f", "script.sed", "input.txt"])).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["sed", "-i", "-f", "script.sed", "input.txt"]),
    ).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["sed", "-E", "-f", "script.sed", "input.txt"]),
    ).toBeNull();
  });

  it("matches interpreter-like allowlist patterns", () => {
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/python3")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/node")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/awk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/gawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/mawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("nawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/find")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("xargs.exe")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/gmake")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/gsed")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/rg")).toBe(false);
  });
});
