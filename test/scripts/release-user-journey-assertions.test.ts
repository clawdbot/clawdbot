import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/release-user-journey/assertions.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(home: string, args: string[]) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
    },
  });
}

describe("release user journey assertions", () => {
  it("fails when uninstall leaves the managed plugin directory behind", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const pluginId = "journey-plugin-a";
    const installPath = path.join(home, ".openclaw", "extensions", pluginId);
    const installPathFile = path.join(root, "install-path.txt");

    try {
      writeJson(path.join(home, ".openclaw", "openclaw.json"), {
        plugins: {
          entries: {},
          allow: [],
          deny: [],
        },
      });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {},
      });
      mkdirSync(installPath, { recursive: true });
      writeFileSync(installPathFile, installPath, "utf8");

      const result = runAssertion(home, [
        "assert-plugin-uninstalled",
        pluginId,
        installPathFile,
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("managed plugin directory still present");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("passes after uninstall clears config, records, and managed files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const installPathFile = path.join(root, "install-path.txt");

    try {
      writeJson(path.join(home, ".openclaw", "openclaw.json"), {
        plugins: {
          entries: {},
          allow: [],
          deny: [],
        },
      });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {},
      });
      writeFileSync(
        installPathFile,
        path.join(home, ".openclaw", "extensions", "journey-plugin-a"),
        "utf8",
      );

      const result = runAssertion(home, [
        "assert-plugin-uninstalled",
        "journey-plugin-a",
        installPathFile,
      ]);

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("remembers the installed plugin path from the install record", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-release-user-assertions-"));
    const home = path.join(root, "home");
    const pluginId = "journey-plugin-a";
    const sourcePath = path.join(root, "source", pluginId);
    const installPath = path.join(home, ".openclaw", "extensions", pluginId);
    const installPathFile = path.join(root, "install-path.txt");
    const sourcePathFile = path.join(root, "source-path.txt");

    try {
      mkdirSync(sourcePath, { recursive: true });
      mkdirSync(installPath, { recursive: true });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {
          [pluginId]: {
            source: "path",
            sourcePath,
            installPath,
          },
        },
      });

      const result = runAssertion(home, [
        "remember-plugin-install-path",
        pluginId,
        installPathFile,
        sourcePathFile,
        sourcePath,
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
