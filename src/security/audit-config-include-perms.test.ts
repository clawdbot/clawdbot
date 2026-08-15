// Covers config include-file permission audit findings.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { collectIncludeFilePermFindings } from "./audit-extra.async.js";

describe("security audit config include permissions", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("flags group/world-readable config include files", async () => {
    const tmp = tempDirs.make("openclaw-include-perms-");
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const includePath = path.join(stateDir, "extra.json5");
    fs.writeFileSync(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    fs.chmodSync(includePath, 0o644);

    const configSnapshot: ConfigFileSnapshot = {
      path: path.join(stateDir, "openclaw.json"),
      exists: true,
      raw: `{ "$include": ${JSON.stringify(includePath)} }\n`,
      parsed: { $include: includePath },
      sourceConfig: {} as ConfigFileSnapshot["sourceConfig"],
      resolved: {} as ConfigFileSnapshot["resolved"],
      valid: true,
      runtimeConfig: {} as ConfigFileSnapshot["runtimeConfig"],
      config: {} as ConfigFileSnapshot["config"],
      issues: [],
      warnings: [],
      legacyIssues: [],
    };

    const findings = await collectIncludeFilePermFindings({
      configSnapshot,
      platform: "linux",
    });

    const finding = findings.find(
      (entry) => entry.checkId === "fs.config_include.perms_world_readable",
    );
    if (!finding) {
      throw new Error("Expected world-readable include finding");
    }
    expect(finding.severity).toBe("critical");
  });

  it.runIf(process.platform !== "win32")(
    "audits include files under explicitly allowed roots",
    async () => {
      const tmp = tempDirs.make("openclaw-include-perms-allowed-");
      const configDir = path.join(tmp, "config");
      const sharedDir = path.join(tmp, "shared");
      const sharedIncludePath = path.join(sharedDir, "shared.json5");
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(sharedDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(sharedIncludePath, "{}\n", "utf-8");
      fs.chmodSync(sharedIncludePath, 0o644);

      const configSnapshot: ConfigFileSnapshot = {
        path: path.join(configDir, "openclaw.json"),
        exists: true,
        raw: `{ "$include": ${JSON.stringify(sharedIncludePath)} }\n`,
        parsed: { $include: sharedIncludePath },
        sourceConfig: {} as ConfigFileSnapshot["sourceConfig"],
        resolved: {} as ConfigFileSnapshot["resolved"],
        valid: true,
        runtimeConfig: {} as ConfigFileSnapshot["runtimeConfig"],
        config: {} as ConfigFileSnapshot["config"],
        issues: [],
        warnings: [],
        legacyIssues: [],
      };

      const findings = await collectIncludeFilePermFindings({
        configSnapshot,
        env: { OPENCLAW_INCLUDE_ROOTS: sharedDir },
        platform: "linux",
      });

      expect(findings).toEqual([
        expect.objectContaining({
          checkId: "fs.config_include.perms_world_readable",
          detail: expect.stringContaining(sharedIncludePath),
        }),
      ]);
    },
  );
});
