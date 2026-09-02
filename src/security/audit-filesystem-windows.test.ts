// Covers Windows filesystem security audit behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectSecurityAuditFindings } from "./audit.test-support.js";
import { AsyncTempCaseFactory } from "./test-temp-cases.js";

const windowsAuditEnv = {
  USERNAME: "Tester",
  USERDOMAIN: "DESKTOP-TEST",
};

function isStateDirectoryTarget(target: string): boolean {
  return /(?:^|[\\/])state$/u.test(target);
}

function windowsOwnerQueryResult(command: string): { stdout: string; stderr: string } | undefined {
  if (!command.toLowerCase().endsWith("powershell.exe")) {
    return undefined;
  }
  const currentUserSid = "S-1-5-21-1-2-3-1001";
  return {
    stdout: JSON.stringify({
      ownerSid: currentUserSid,
      currentUserSid,
      principalSids: [
        { name: "NT AUTHORITY\\SYSTEM", sid: "S-1-5-18" },
        { name: "BUILTIN\\Users", sid: "S-1-5-32-545" },
        { name: "DESKTOP-TEST\\Tester", sid: currentUserSid },
      ],
      principalTranslationFailed: false,
      remote: false,
    }),
    stderr: "",
  };
}

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
        const findings = await collectSecurityAuditFindings(
          { agents: { list: [{ id: "main", default: true }] } },
          {
            stateDir,
            configPath,
            includeFilesystem: true,
            configSnapshot: null,
            platform: "win32",
            env: windowsAuditEnv,
            execIcacls: async (cmd: string, args: string[]) =>
              windowsOwnerQueryResult(cmd) ?? {
                stdout: `${args[0]} NT AUTHORITY\\SYSTEM:(F)\n DESKTOP-TEST\\Tester:(F)\n`,
                stderr: "",
              },
          },
        );
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
        const findings = await collectSecurityAuditFindings(
          { agents: { list: [{ id: "main", default: true }] } },
          {
            stateDir,
            configPath,
            includeFilesystem: true,
            configSnapshot: null,
            platform: "win32",
            env: windowsAuditEnv,
            execIcacls: async (cmd: string, args: string[]) => {
              const ownerResult = windowsOwnerQueryResult(cmd);
              if (ownerResult) {
                return ownerResult;
              }
              const target = expectDefined(args[0], "args[0] test invariant");
              if (isStateDirectoryTarget(target)) {
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
          },
        );
        expect(
          findings.some(
            (finding) =>
              finding.checkId === "fs.state_dir.perms_readable" && finding.severity === "warn",
          ),
        ).toBe(true);
      })(),
      (async () => {
        const tmp = await tempCases.makeTmpDir("win-anon-world");
        const stateDir = path.join(tmp, "state");
        await fs.mkdir(stateDir, { recursive: true });
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.writeFile(configPath, "{}\n", "utf-8");
        const findings = await collectSecurityAuditFindings(
          { agents: { list: [{ id: "main", default: true }] } },
          {
            stateDir,
            configPath,
            includeFilesystem: true,
            configSnapshot: null,
            platform: "win32",
            env: windowsAuditEnv,
            execIcacls: async (cmd: string, args: string[]) => {
              const ownerResult = windowsOwnerQueryResult(cmd);
              if (ownerResult) {
                return ownerResult;
              }
              const target = expectDefined(args[0], "args[0] test invariant");
              if (isStateDirectoryTarget(target)) {
                return {
                  stdout: `${target} *S-1-5-18:(F)\n *S-1-5-7:(F)\n`,
                  stderr: "",
                };
              }
              return {
                stdout: `${target} *S-1-5-18:(F)\n DESKTOP-TEST\\Tester:(F)\n`,
                stderr: "",
              };
            },
          },
        );
        expect(
          findings.some(
            (finding) =>
              finding.checkId === "fs.state_dir.perms_world_writable" &&
              finding.severity === "critical",
          ),
        ).toBe(true);
        expect(
          findings.some((finding) => finding.checkId === "fs.state_dir.perms_group_writable"),
        ).toBe(false);
      })(),
    ]);
  });
});
