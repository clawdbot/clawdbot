// Covers platform shell argv construction.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNodeShellCommand, restoreLoginShellServicePath } from "./node-shell.js";

describe("buildNodeShellCommand", () => {
  it("uses cmd.exe for win-prefixed platform labels", () => {
    expect(buildNodeShellCommand("echo hi", "win32")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(buildNodeShellCommand("echo hi", "windows")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(buildNodeShellCommand("echo hi", " Windows 11 ")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
  });

  it("uses bindable non-login sh for macOS nodes", () => {
    expect(buildNodeShellCommand("echo hi", "darwin")).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "macOS")).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "macOS 26.5.2")).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  it("retains login sh for other posix and missing platform values", () => {
    expect(buildNodeShellCommand("echo hi", "linux")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", null)).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "   ")).toEqual(["/bin/sh", "-lc", "echo hi"]);
  });
});

describe("restoreLoginShellServicePath", () => {
  const servicePath = "/svc/bin:/usr/bin";
  const rewritten = (payload: string) =>
    `export PATH="\${OPENCLAW_PREPEND_PATH}\${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; ${payload}`;

  it("re-exports the service PATH for posix login-shell invocations", () => {
    for (const argv of [
      ["/bin/sh", "-lc", "echo hi"],
      ["/bin/sh", "-l", "-c", "echo hi"],
      ["/bin/sh", "-c", "-l", "echo hi"],
      ["/usr/bin/bash", "-cl", "echo hi"],
      ["dash", "-lc", "echo hi"],
      ["/bin/zsh", "-lc", "echo hi"],
    ]) {
      expect(restoreLoginShellServicePath(argv, { PATH: servicePath, HOME: "/home/n" })).toEqual({
        argv: [...argv.slice(0, -1), rewritten("echo hi")],
        env: { PATH: servicePath, HOME: "/home/n", OPENCLAW_PREPEND_PATH: servicePath },
      });
    }
  });

  it("leaves argv shapes that are not posix login-shell payloads unchanged", () => {
    for (const argv of [
      ["/bin/sh", "-c", "echo hi"],
      ["cmd.exe", "/d", "/s", "/c", "echo hi"],
      ["/usr/bin/git", "status"],
      ["/bin/sh", "-lc", "echo hi", "argv0", "arg1"],
      ["/bin/sh", "-lco", "pipefail", "echo hi"],
      ["/bin/sh", "-lc"],
      ["/bin/env", "-lc", "echo hi"],
    ]) {
      const env = { PATH: servicePath };
      expect(restoreLoginShellServicePath(argv, env)).toEqual({ argv, env });
    }
  });

  it("leaves the command unchanged when no PATH is handed to the child", () => {
    expect(restoreLoginShellServicePath(["/bin/sh", "-lc", "echo hi"], undefined)).toEqual({
      argv: ["/bin/sh", "-lc", "echo hi"],
      env: undefined,
    });
    expect(restoreLoginShellServicePath(["/bin/sh", "-lc", "echo hi"], { PATH: "" })).toEqual({
      argv: ["/bin/sh", "-lc", "echo hi"],
      env: { PATH: "" },
    });
  });

  it("never interpolates the PATH value into argv", () => {
    const hostile = '/svc/bin:$(touch /tmp/pwned):`id`:"quoted"';
    const result = restoreLoginShellServicePath(["/bin/sh", "-lc", "echo hi"], { PATH: hostile });
    expect(result.argv.join(" ")).not.toContain(hostile);
    expect(result.argv.at(-1)).toBe(rewritten("echo hi"));
    expect(result.env?.OPENCLAW_PREPEND_PATH).toBe(hostile);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the service PATH ahead of a profile that resets it in a real login shell",
    () => {
      // The bug is a shell-startup interaction, so drive a real login shell
      // against a profile that overwrites PATH the way Debian /etc/profile does.
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-profile-")));
      const serviceBin = path.join(home, "service-bin");
      fs.mkdirSync(serviceBin);
      fs.writeFileSync(path.join(home, ".profile"), 'PATH="/usr/local/bin:/usr/bin:/bin"\n');
      const probe = path.join(serviceBin, "openclaw-path-probe");
      fs.writeFileSync(probe, "#!/bin/sh\nprintf ok\n", { mode: 0o755 });
      try {
        const command = buildNodeShellCommand("command -v openclaw-path-probe", "linux");
        const baseEnv = { HOME: home, PATH: `${serviceBin}:/usr/bin:/bin` };
        const run = (argv: string[], env: Record<string, string>) =>
          execFileSync(argv[0] ?? "", argv.slice(1), { env, encoding: "utf8" }).trim();

        expect(() => run(command, baseEnv)).toThrow();

        const restored = restoreLoginShellServicePath(command, baseEnv);
        expect(run(restored.argv, restored.env ?? {})).toBe(probe);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("overrides a request-scoped carrier variable of the same name", () => {
    const result = restoreLoginShellServicePath(["/bin/sh", "-lc", "echo hi"], {
      PATH: servicePath,
      OPENCLAW_PREPEND_PATH: "/attacker/bin",
    });
    expect(result.env?.OPENCLAW_PREPEND_PATH).toBe(servicePath);
  });
});
