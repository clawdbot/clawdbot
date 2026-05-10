import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectFilesystemFindings } from "./audit.js";
import { AsyncTempCaseFactory } from "./test-temp-cases.js";

const isWindows = process.platform === "win32";

describe("security audit config symlink findings", () => {
  const tempCases = new AsyncTempCaseFactory("openclaw-security-audit-config-");

  beforeAll(async () => {
    await tempCases.setup();
  });

  afterAll(async () => {
    await tempCases.cleanup();
  });

  it("uses symlink target permissions for config checks", async () => {
    if (isWindows) {
      return;
    }

    const tmp = await tempCases.makeTmpDir("config-symlink");
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });

    const targetConfigPath = path.join(tmp, "managed-openclaw.json");
    await fs.writeFile(targetConfigPath, "{}\n", "utf-8");
    await fs.chmod(targetConfigPath, 0o444);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.symlink(targetConfigPath, configPath);

    const findings = await collectFilesystemFindings({
      stateDir,
      configPath,
    });

    const checkIds = findings.map((finding) => finding.checkId);
    expect(checkIds).toContain("fs.config.symlink");
    expect(checkIds).not.toContain("fs.config.perms_writable");
    expect(checkIds).not.toContain("fs.config.perms_world_readable");
    expect(checkIds).not.toContain("fs.config.perms_group_readable");
  });
});
