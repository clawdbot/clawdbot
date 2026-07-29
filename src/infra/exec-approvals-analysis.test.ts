// Covers argv analysis and Windows shell analysis.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateExecAllowlist } from "./exec-approvals-allowlist.js";
import {
  analyzeArgvCommand,
  analyzeWindowsShellCommand,
  buildEnforcedShellCommand,
  resolvePlannedSegmentArgv,
  windowsEscapeArg,
} from "./exec-approvals-analysis.js";
import { makeExecutable, makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";

describe("exec argv analysis", () => {
  it("parses argv commands", () => {
    const res = analyzeArgvCommand({ argv: ["/bin/echo", "ok"] });

    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["/bin/echo", "ok"]);
  });

  it("rejects empty argv commands", () => {
    expect(analyzeArgvCommand({ argv: ["", "   "] })).toEqual({
      ok: false,
      reason: "empty argv",
      segments: [],
    });
  });

  it("keeps shell multiplexer rebuilds as coherent execution argv", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = path.join(dir, "busybox");
    fs.writeFileSync(busybox, "");
    fs.chmodSync(busybox, 0o755);

    const analysis = analyzeArgvCommand({
      argv: [busybox, "sh", "-lc", "echo hi"],
      cwd: dir,
      env: { PATH: `/bin:/usr/bin${path.delimiter}${process.env.PATH ?? ""}` },
    });

    expect(analysis.ok).toBe(true);
    const segment = analysis.segments[0];
    if (!segment) {
      throw new Error("expected first segment");
    }

    const planned = resolvePlannedSegmentArgv(segment);
    expect(planned).toEqual([
      segment.resolution?.execution.resolvedRealPath ?? segment.resolution?.execution.resolvedPath,
      "-lc",
      "echo hi",
    ]);
    expect(planned?.[0]).not.toBe(busybox);
  });
});

describe("Windows shell analysis", () => {
  it("accepts shell metacharacters inside double-quoted arguments", () => {
    const cases = [
      'node add_lifelog.js "2026-03-28" "2026-03-28 (土) - LifeLog" --markdown',
      'node tool.js "--filter=a|b" "--label=x>y" "--name=foo & bar"',
      'node tool.js "--pattern=a^b"',
      'node tool.js "--msg=Hello!"',
    ];

    for (const command of cases) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv[0]).toBe("node");
    }
  });

  it("rejects unquoted metacharacters", () => {
    const cases: string[] = [
      "ping 127.0.0.1 -n 1 & whoami",
      "node allowed.js; unlisted.exe",
      "echo hello | clip",
      "node tool.js > output.txt",
      "for /f %i in (file.txt) do echo %i",
    ];

    for (const command of cases) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects PowerShell expansion tokens", () => {
    const cases: string[] = [
      'node tool.js "--user=%USERNAME%"',
      'node app.js "$env:USERPROFILE"',
      "node app.js ${var}",
      "node app.js $(whoami)",
      'node app.js "$?"',
      'node app.js "$$"',
    ];

    for (const command of cases) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(false);
    }
  });

  it("allows bare $ not followed by identifier", () => {
    const res = analyzeWindowsShellCommand({
      command: 'net use "\\\\host\\C$"',
      platform: "win32",
    });

    expect(res.ok).toBe(true);
  });

  it("rejects metacharacters inside single-quoted arguments for cmd compatibility", () => {
    const unsafeSingleQuoteCommands: string[] = [
      "node tool.js '--name=foo & bar'",
      "node tool.js '--filter=a|b'",
      "node tool.js '--msg=Hello!'",
      "node tool.js '--pattern=(x)'",
      "node tool.js '--label=%USERNAME%'",
    ];

    for (const command of unsafeSingleQuoteCommands) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(false);
    }
  });

  it("tokenizes PowerShell single-quoted arguments", () => {
    const res = analyzeWindowsShellCommand({
      command: "node tool.js 'O''Brien'",
      platform: "win32",
    });

    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["node", "tool.js", "O'Brien"]);
  });

  it("preserves empty quoted args", () => {
    const doubleQuoted = analyzeWindowsShellCommand({
      command: 'node tool.js ""',
      platform: "win32",
    });
    const singleQuoted = analyzeWindowsShellCommand({
      command: "node tool.js ''",
      platform: "win32",
    });

    expect(doubleQuoted.ok).toBe(true);
    expect(doubleQuoted.segments[0]?.argv).toEqual(["node", "tool.js", ""]);
    expect(singleQuoted.ok).toBe(true);
    expect(singleQuoted.segments[0]?.argv).toEqual(["node", "tool.js", ""]);
  });

  it("parses quoted executables", () => {
    const res = analyzeWindowsShellCommand({
      command: '"C:\\Program Files\\Tool\\tool.exe" --version',
      platform: "win32",
    });

    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["C:\\Program Files\\Tool\\tool.exe", "--version"]);
  });

  it("unwraps PowerShell -Command payloads", () => {
    const powershellCommandCases: Array<readonly [string, string[]]> = [
      ['powershell -Command "node a.js ""hello world"""', ["node", "a.js", "hello world"]],
      ["powershell -Command 'node a.js ''hello world'''", ["node", "a.js", "hello world"]],
      [
        'powershell -WorkingDirectory "C:\\Users\\Jane Doe\\proj" -Command "node a.js"',
        ["node", "a.js"],
      ],
      ['pwsh -NoLogo -c "node a.js"', ["node", "a.js"]],
      ["pwsh --command node a.js", ["node", "a.js"]],
    ];

    for (const [command, argv] of powershellCommandCases) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(argv);
    }
  });
});

describe("Windows enforced shell command rendering", () => {
  it("builds enforced command for simple Windows command", () => {
    // Resolve from a fixture PATH: host python3 locations (e.g. Homebrew's
    // python@3.x Cellar path) contain characters that trigger quoting and make
    // the rendered command host-dependent.
    const dir = makeTempDir();
    const python3 = makeExecutable(dir, "python3");
    const analysis = analyzeWindowsShellCommand({
      command: "python3 a.py",
      platform: "win32",
      env: makePathEnv(dir),
    });

    expect(analysis.ok).toBe(true);
    const result = buildEnforcedShellCommand({
      command: "python3 a.py",
      segments: analysis.segments,
      platform: "win32",
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe(`& ${python3} a.py`);
  });

  it("rejects Windows commands with unsafe tokens", () => {
    const result = buildEnforcedShellCommand({
      command: "echo ok & del file",
      segments: [],
      platform: "win32",
    });

    expect(result.ok).toBe(false);
  });
});

describe("windowsEscapeArg", () => {
  it("quotes empty strings", () => {
    expect(windowsEscapeArg("")).toEqual({ ok: true, escaped: '""' });
  });

  it("returns safe values as-is", () => {
    expect(windowsEscapeArg("foo.exe")).toEqual({ ok: true, escaped: "foo.exe" });
    expect(windowsEscapeArg("C:/Program/bin")).toEqual({ ok: true, escaped: "C:/Program/bin" });
  });

  it("double-quotes values with spaces and escapes embedded quotes", () => {
    expect(windowsEscapeArg("hello world")).toEqual({ ok: true, escaped: '"hello world"' });
    expect(windowsEscapeArg('say "hi"')).toEqual({ ok: true, escaped: '"say ""hi"""' });
  });

  it("rejects expansion tokens", () => {
    expect(windowsEscapeArg("%PATH%")).toEqual({ ok: false });
    expect(windowsEscapeArg("$env:SECRET")).toEqual({ ok: false });
    expect(windowsEscapeArg("$var")).toEqual({ ok: false });
    expect(windowsEscapeArg("${var}")).toEqual({ ok: false });
    expect(windowsEscapeArg("$(whoami)")).toEqual({ ok: false });
    expect(windowsEscapeArg("$?")).toEqual({ ok: false });
    expect(windowsEscapeArg("$$")).toEqual({ ok: false });
  });

  it("allows $ not followed by identifier", () => {
    expect(windowsEscapeArg("\\\\host\\C$")).toEqual({ ok: true, escaped: '"\\\\host\\C$"' });
    expect(windowsEscapeArg("trailing$")).toEqual({ ok: true, escaped: '"trailing$"' });
  });
});

describe("Windows inline allowlist analysis", () => {
  it("evaluates inline cmd payloads against the inner executable", () => {
    const dir = makeTempDir();
    const cmdPath = path.join(dir, "cmd.exe");
    const nodePath = path.join(dir, "node.exe");
    for (const file of [cmdPath, nodePath]) {
      fs.writeFileSync(file, "");
      fs.chmodSync(file, 0o755);
    }
    try {
      const env = makePathEnv(dir);
      const analysis = analyzeArgvCommand({
        argv: ["cmd.exe", "/c", "node.exe", "app.js"],
        cwd: dir,
        env,
      });

      expect(analysis.ok).toBe(true);
      const result = evaluateExecAllowlist({
        analysis,
        allowlist: [{ pattern: nodePath }],
        safeBins: new Set(),
        cwd: dir,
        env,
        platform: "win32",
      });
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual([nodePath]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
