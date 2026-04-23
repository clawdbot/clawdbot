import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectFilesystemFindings } from "./audit.js";
import { AsyncTempCaseFactory } from "./test-temp-cases.js";

const windowsAuditEnv = {
  USERNAME: "Tester",
  USERDOMAIN: "DESKTOP-TEST",
};

describe("security audit filesystem Windows findings", () => {
  const tempCases = new AsyncTempCaseFactory("openclaw-security-audit-win-");

  beforeAll(async () => {
    await tempCases.setup();
  });

  afterAll(async () => {
    await tempCases.cleanup();
  });

  it("evaluates Windows ACL-derived filesystem findings", async () => {
    await Promise.all([
      (async () => {
        const tmp = await tempCases.makeTmpDir("win");
        const stateDir = path.join(tmp, "state");
        await fs.mkdir(stateDir, { recursive: true });
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.writeFile(configPath, "{}\n", "utf-8");
        const findings = await collectFilesystemFindings({
          stateDir,
          configPath,
          platform: "win32",
          env: windowsAuditEnv,
          execIcacls: async (_cmd: string, args: string[]) => ({
            stdout: `${args[0]} NT AUTHORITY\\SYSTEM:(F)\n DESKTOP-TEST\\Tester:(F)\n`,
            stderr: "",
          }),
        });
        const forbidden = new Set([
          "fs.state_dir.perms_world_writable",
          "fs.state_dir.perms_group_writable",
          "fs.state_dir.perms_readable",
          "fs.config.perms_writable",
          "fs.config.perms_world_readable",
          "fs.config.perms_group_readable",
        ]);
        for (const id of forbidden) {
          expect(
            findings.some((finding) => finding.checkId === id),
            id,
          ).toBe(false);
        }
      })(),
      (async () => {
        const tmp = await tempCases.makeTmpDir("win-open");
        const stateDir = path.join(tmp, "state");
        await fs.mkdir(stateDir, { recursive: true });
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.writeFile(configPath, "{}\n", "utf-8");
        const findings = await collectFilesystemFindings({
          stateDir,
          configPath,
          platform: "win32",
          env: windowsAuditEnv,
          execIcacls: async (_cmd: string, args: string[]) => {
            const target = args[0];
            if (target.endsWith(`${path.sep}state`)) {
              return {
                stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Users:(RX)\n DESKTOP-TEST\\Tester:(F)\n`,
                stderr: "",
              };
            }
            return {
              stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n DESKTOP-TEST\\Tester:(F)\n`,
              stderr: "",
            };
          },
        });
        expect(
          findings.some(
            (finding) =>
              finding.checkId === "fs.state_dir.perms_readable" && finding.severity === "warn",
          ),
        ).toBe(true);
      })(),
    ]);
  });
});
