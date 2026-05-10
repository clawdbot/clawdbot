import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { collectIncludeFilePermFindings } from "./audit-extra.async.js";

const inspectPathPermissionsMock = vi.hoisted(() => vi.fn());

vi.mock("./audit-fs.js", () => ({
  inspectPathPermissions: inspectPathPermissionsMock,
  formatPermissionDetail: (targetPath: string) => `${targetPath} mocked-perms`,
  formatPermissionRemediation: ({ targetPath }: { targetPath: string }) =>
    `chmod 600 ${targetPath}`,
}));

describe("security audit config include permissions", () => {
  beforeEach(() => {
    inspectPathPermissionsMock.mockReset();
  });

  it("flags group/world-readable config include files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-include-perms-"));
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const includePath = path.join(stateDir, "extra.json5");
    fs.writeFileSync(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    inspectPathPermissionsMock.mockResolvedValue({
      ok: true,
      isSymlink: false,
      isDir: false,
      mode: 0o644,
      bits: 0o644,
      source: "posix",
      worldWritable: false,
      groupWritable: false,
      worldReadable: true,
      groupReadable: true,
    });

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
    });

    expect(inspectPathPermissionsMock).toHaveBeenCalledWith(includePath, {
      env: undefined,
      exec: undefined,
      platform: undefined,
    });
    const finding = findings.find(
      (entry) => entry.checkId === "fs.config_include.perms_world_readable",
    );
    if (!finding) {
      throw new Error("Expected world-readable include finding");
    }
    expect(finding.severity).toBe("critical");
  });
});
