import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  installLaunchAgent,
  isLaunchAgentListed,
  parseLaunchctlPrint,
  repairLaunchAgentBootstrap,
  resolveLaunchAgentPlistPath,
} from "./launchd.js";

async function withLaunchctlStub(
  options: { listOutput?: string },
  run: (context: { env: Record<string, string | undefined>; logPath: string }) => Promise<void>,
) {
  const originalPath = process.env.PATH;
  const originalLogPath = process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG;
  const originalListOutput = process.env.CLAWDBOT_TEST_LAUNCHCTL_LIST_OUTPUT;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-launchctl-test-"));
  try {
    const binDir = path.join(tmpDir, "bin");
    const homeDir = path.join(tmpDir, "home");
    const logPath = path.join(tmpDir, "launchctl.log");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });

    const stubJsPath = path.join(binDir, "launchctl.js");
    await fs.writeFile(
      stubJsPath,
      [
        'import fs from "node:fs";',
        "const args = process.argv.slice(2);",
        "const logPath = process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG;",
        "if (logPath) {",
        '  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n", "utf8");',
        "}",
        'if (args[0] === "list") {',
        '  const output = process.env.CLAWDBOT_TEST_LAUNCHCTL_LIST_OUTPUT || "";',
        "  process.stdout.write(output);",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf8",
    );

    if (process.platform === "win32") {
      await fs.writeFile(
        path.join(binDir, "launchctl.cmd"),
        `@echo off\r\nnode "%~dp0\\launchctl.js" %*\r\n`,
        "utf8",
      );
    } else {
      const shPath = path.join(binDir, "launchctl");
      await fs.writeFile(shPath, `#!/bin/sh\nnode "$(dirname "$0")/launchctl.js" "$@"\n`, "utf8");
      await fs.chmod(shPath, 0o755);
    }

    process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG = logPath;
    process.env.CLAWDBOT_TEST_LAUNCHCTL_LIST_OUTPUT = options.listOutput ?? "";
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    await run({
      env: {
        HOME: homeDir,
        CLAWDBOT_PROFILE: "default",
      },
      logPath,
    });
  } finally {
    process.env.PATH = originalPath;
    if (originalLogPath === undefined) {
      delete process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG;
    } else {
      process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG = originalLogPath;
    }
    if (originalListOutput === undefined) {
      delete process.env.CLAWDBOT_TEST_LAUNCHCTL_LIST_OUTPUT;
    } else {
      process.env.CLAWDBOT_TEST_LAUNCHCTL_LIST_OUTPUT = originalListOutput;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

describe("launchd runtime parsing", () => {
  it("parses state, pid, and exit status", () => {
    const output = [
      "state = running",
      "pid = 4242",
      "last exit status = 1",
      "last exit reason = exited",
    ].join("\n");
    expect(parseLaunchctlPrint(output)).toEqual({
      state: "running",
      pid: 4242,
      lastExitStatus: 1,
      lastExitReason: "exited",
    });
  });
});

describe("launchctl list detection", () => {
  it("detects the resolved label in launchctl list", async () => {
    await withLaunchctlStub({ listOutput: "123 0 bot.molt.gateway\n" }, async ({ env }) => {
      const listed = await isLaunchAgentListed({ env });
      expect(listed).toBe(true);
    });
  });

  it("returns false when the label is missing", async () => {
    await withLaunchctlStub({ listOutput: "123 0 com.other.service\n" }, async ({ env }) => {
      const listed = await isLaunchAgentListed({ env });
      expect(listed).toBe(false);
    });
  });
});

describe("launchd bootstrap repair", () => {
  it("bootstraps and kickstarts the resolved label", async () => {
    await withLaunchctlStub({}, async ({ env, logPath }) => {
      const repair = await repairLaunchAgentBootstrap({ env });
      expect(repair.ok).toBe(true);

      const calls = (await fs.readFile(logPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);

      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      const label = "bot.molt.gateway";
      const plistPath = resolveLaunchAgentPlistPath(env);

      expect(calls).toContainEqual(["bootstrap", domain, plistPath]);
      expect(calls).toContainEqual(["kickstart", "-k", `${domain}/${label}`]);
    });
  });
});

describe("launchd install", () => {
  it("enables service before bootstrap (clears persisted disabled state)", async () => {
    const originalPath = process.env.PATH;
    const originalLogPath = process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-launchctl-test-"));
    try {
      const binDir = path.join(tmpDir, "bin");
      const homeDir = path.join(tmpDir, "home");
      const logPath = path.join(tmpDir, "launchctl.log");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(homeDir, { recursive: true });

      const stubJsPath = path.join(binDir, "launchctl.js");
      await fs.writeFile(
        stubJsPath,
        [
          'import fs from "node:fs";',
          "const logPath = process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG;",
          "if (logPath) {",
          '  fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");',
          "}",
          "process.exit(0);",
          "",
        ].join("\n"),
        "utf8",
      );

      if (process.platform === "win32") {
        await fs.writeFile(
          path.join(binDir, "launchctl.cmd"),
          `@echo off\r\nnode "%~dp0\\launchctl.js" %*\r\n`,
          "utf8",
        );
      } else {
        const shPath = path.join(binDir, "launchctl");
        await fs.writeFile(shPath, `#!/bin/sh\nnode "$(dirname "$0")/launchctl.js" "$@"\n`, "utf8");
        await fs.chmod(shPath, 0o755);
      }

      process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG = logPath;
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

      const env: Record<string, string | undefined> = {
        HOME: homeDir,
        CLAWDBOT_PROFILE: "default",
      };
      await installLaunchAgent({
        env,
        stdout: new PassThrough(),
        programArguments: ["node", "-e", "process.exit(0)"],
      });

      const calls = (await fs.readFile(logPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);

      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      const label = "bot.molt.gateway";
      const plistPath = resolveLaunchAgentPlistPath(env);
      const serviceId = `${domain}/${label}`;

      const enableCalls = calls.filter((c) => c[0] === "enable" && c[1] === serviceId);
      expect(enableCalls).toHaveLength(1);

      const enableIndex = calls.findIndex((c) => c[0] === "enable" && c[1] === serviceId);
      const bootstrapIndex = calls.findIndex(
        (c) => c[0] === "bootstrap" && c[1] === domain && c[2] === plistPath,
      );
      expect(enableIndex).toBeGreaterThanOrEqual(0);
      expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
      expect(enableIndex).toBeLessThan(bootstrapIndex);
    } finally {
      process.env.PATH = originalPath;
      if (originalLogPath === undefined) {
        delete process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG;
      } else {
        process.env.CLAWDBOT_TEST_LAUNCHCTL_LOG = originalLogPath;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveLaunchAgentPlistPath", () => {
  it("uses default label when CLAWDBOT_PROFILE is default", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_PROFILE: "default" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/bot.molt.gateway.plist",
    );
  });

  it("uses default label when CLAWDBOT_PROFILE is unset", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/bot.molt.gateway.plist",
    );
  });

  it("uses profile-specific label when CLAWDBOT_PROFILE is set to a custom value", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_PROFILE: "jbphoenix" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/bot.molt.jbphoenix.plist",
    );
  });

  it("prefers CLAWDBOT_LAUNCHD_LABEL over CLAWDBOT_PROFILE", () => {
    const env = {
      HOME: "/Users/test",
      CLAWDBOT_PROFILE: "jbphoenix",
      CLAWDBOT_LAUNCHD_LABEL: "com.custom.label",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    );
  });

  it("trims whitespace from CLAWDBOT_LAUNCHD_LABEL", () => {
    const env = {
      HOME: "/Users/test",
      CLAWDBOT_LAUNCHD_LABEL: "  com.custom.label  ",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/com.custom.label.plist",
    );
  });

  it("ignores empty CLAWDBOT_LAUNCHD_LABEL and falls back to profile", () => {
    const env = {
      HOME: "/Users/test",
      CLAWDBOT_PROFILE: "myprofile",
      CLAWDBOT_LAUNCHD_LABEL: "   ",
    };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/bot.molt.myprofile.plist",
    );
  });

  it("handles case-insensitive 'Default' profile", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_PROFILE: "Default" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/bot.molt.gateway.plist",
    );
  });

  it("handles case-insensitive 'DEFAULT' profile", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_PROFILE: "DEFAULT" };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/bot.molt.gateway.plist",
    );
  });

  it("trims whitespace from CLAWDBOT_PROFILE", () => {
    const env = { HOME: "/Users/test", CLAWDBOT_PROFILE: "  myprofile  " };
    expect(resolveLaunchAgentPlistPath(env)).toBe(
      "/Users/test/Library/LaunchAgents/bot.molt.myprofile.plist",
    );
  });
});
