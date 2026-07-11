/** Tests system.run allowlist planning, output truncation, and argv resolution. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecApprovalsFromFile, type ExecCommandSegment } from "../infra/exec-approvals.js";
import { planShellAuthorization } from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  evaluateSystemRunAllowlist,
  resolveSystemRunExecArgv,
} from "./invoke-system-run-allowlist.js";

function resolveAllowlistApprovals() {
  return resolveExecApprovalsFromFile({
    file: {
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
      },
    },
  });
}

function resolveWindowsShellExecArgv(segment: ExecCommandSegment) {
  return resolveSystemRunExecArgv({
    plannedAllowlistArgv: undefined,
    argv: ["powershell.exe", "-Command", "safe --version"],
    security: "allowlist",
    approvals: resolveAllowlistApprovals(),
    safeBins: new Set(),
    safeBinProfiles: {},
    trustedSafeBinDirs: new Set(),
    skillBins: [],
    autoAllowSkills: false,
    isWindows: true,
    policy: {
      approvedByAsk: false,
      analysisOk: true,
      allowlistSatisfied: true,
    },
    shellCommand: "safe --version",
    segments: [segment],
    segmentSatisfiedBy: ["allowlist"],
    authorizationPlan: undefined,
    cwd: "C:\\workspace",
    env: undefined,
  });
}

function runExecutable(params: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.argv[0], params.argv.slice(1), {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

describe("resolveSystemRunExecArgv", () => {
  it("pins Windows shell execution to the resolved allowlisted executable", async () => {
    const trustedExecutable = "C:\\trusted-bin\\safe.exe";
    const result = await resolveWindowsShellExecArgv({
      raw: "safe --version",
      argv: ["safe", "--version"],
      resolution: {
        execution: {
          rawExecutable: "safe",
          resolvedPath: trustedExecutable,
          executableName: "safe.exe",
        },
        policy: {
          rawExecutable: "safe",
          resolvedPath: trustedExecutable,
          executableName: "safe.exe",
        },
      },
    });

    expect(result).toEqual([trustedExecutable, "--version"]);
  });

  it("preserves unresolved Windows shell argv authorized by a bare wildcard", async () => {
    const result = await resolveWindowsShellExecArgv({
      raw: "safe --version",
      argv: ["safe", "--version"],
      resolution: null,
    });

    expect(result).toEqual(["safe", "--version"]);
  });

  it("fails closed when the Windows shell execution plan is blocked", async () => {
    const result = await resolveWindowsShellExecArgv({
      raw: "safe --version",
      argv: ["safe", "--version"],
      resolution: {
        policyBlocked: true,
        execution: {
          rawExecutable: "safe",
          executableName: "safe",
        },
        policy: {
          rawExecutable: "safe",
          executableName: "safe",
        },
      },
    });

    expect(result).toBeNull();
  });

  it.runIf(process.platform === "win32")(
    "executes the allowlisted path instead of a workspace shadow executable",
    async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-windows-shadow-"));
      const trustedBin = path.join(fixtureRoot, "trusted-bin");
      const workspace = path.join(fixtureRoot, "workspace");
      fs.mkdirSync(trustedBin);
      fs.mkdirSync(workspace);
      const trustedExecutable = path.join(trustedBin, "safe.exe");
      const shadowExecutable = path.join(workspace, "safe.exe");
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      fs.copyFileSync(path.join(systemRoot, "System32", "cmd.exe"), trustedExecutable);
      fs.copyFileSync(path.join(systemRoot, "System32", "where.exe"), shadowExecutable);
      const env = {
        ...process.env,
        PATH: `${trustedBin}${path.delimiter}${process.env.PATH ?? ""}`,
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      };
      const shellCommand = "safe /d /s /c echo TRUSTED_EXECUTABLE";
      const commandTail = ["/d", "/s", "/c", "echo", "TRUSTED_EXECUTABLE"];

      try {
        const bareResult = await runExecutable({
          argv: ["safe", ...commandTail],
          cwd: workspace,
          env,
        });
        expect(bareResult.exitCode).not.toBe(0);
        expect(bareResult.stdout).not.toContain("TRUSTED_EXECUTABLE");

        const approvals = resolveExecApprovalsFromFile({
          file: {
            version: 1,
            defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
            agents: { main: { allowlist: [{ pattern: trustedExecutable }] } },
          },
        });
        const analysis = await evaluateSystemRunAllowlist({
          shellCommand,
          argv: ["powershell.exe", "-Command", shellCommand],
          approvals,
          security: "allowlist",
          safeBins: new Set(),
          safeBinProfiles: {},
          trustedSafeBinDirs: new Set(),
          cwd: workspace,
          env,
          skillBins: [],
          autoAllowSkills: false,
        });
        expect(analysis.analysisOk).toBe(true);
        expect(analysis.allowlistSatisfied).toBe(true);

        const execArgv = await resolveSystemRunExecArgv({
          plannedAllowlistArgv: undefined,
          argv: ["powershell.exe", "-Command", shellCommand],
          security: "allowlist",
          approvals,
          safeBins: new Set(),
          safeBinProfiles: {},
          trustedSafeBinDirs: new Set(),
          skillBins: [],
          autoAllowSkills: false,
          isWindows: true,
          policy: {
            approvedByAsk: false,
            analysisOk: analysis.analysisOk,
            allowlistSatisfied: analysis.allowlistSatisfied,
          },
          shellCommand,
          segments: analysis.segments,
          segmentSatisfiedBy: analysis.segmentSatisfiedBy,
          authorizationPlan: analysis.authorizationPlan,
          cwd: workspace,
          env,
        });
        expect(execArgv?.[0]).toBe(fs.realpathSync(trustedExecutable));

        const fixedResult = await runExecutable({ argv: execArgv ?? [], cwd: workspace, env });
        expect(fixedResult.exitCode).toBe(0);
        expect(fixedResult.stdout).toContain("TRUSTED_EXECUTABLE");
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed when shell rewriting has no authorization plan",
    async () => {
      const env = { PATH: "/usr/bin:/bin" };

      const result = await resolveSystemRunExecArgv({
        plannedAllowlistArgv: undefined,
        argv: ["/bin/sh", "-lc", "head -c 16"],
        security: "allowlist",
        approvals: resolveAllowlistApprovals(),
        safeBins: new Set(),
        safeBinProfiles: {},
        trustedSafeBinDirs: new Set(),
        skillBins: [],
        autoAllowSkills: false,
        isWindows: false,
        policy: {
          approvedByAsk: false,
          analysisOk: true,
          allowlistSatisfied: true,
        },
        shellCommand: "head -c 16",
        segments: [],
        segmentSatisfiedBy: ["safeBins"],
        authorizationPlan: undefined,
        cwd: undefined,
        env,
      });

      expect(result).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns rebuilt shell argv when the authorization plan supports rewriting",
    async () => {
      const env = { PATH: "/usr/bin:/bin" };
      const authorizationPlan = await planShellAuthorization({
        command: "head -c 16",
        env,
        platform: process.platform,
      });
      expect(authorizationPlan.ok).toBe(true);
      if (!authorizationPlan.ok) {
        throw new Error(authorizationPlan.reason);
      }
      const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
        global: { safeBins: ["head"] },
      });
      const segmentSatisfiedBy: ["safeBins"] = ["safeBins"];
      const expectedCommand = buildAuthorizedShellCommandFromPlan({
        plan: authorizationPlan,
        mode: "safeBins",
        segmentSatisfiedBy,
      });
      expect(expectedCommand.ok).toBe(true);
      if (!expectedCommand.ok) {
        throw new Error(expectedCommand.reason);
      }

      const result = await resolveSystemRunExecArgv({
        plannedAllowlistArgv: undefined,
        argv: ["/bin/sh", "-lc", "head -c 16"],
        security: "allowlist",
        approvals: resolveAllowlistApprovals(),
        safeBins: safeBinPolicy.safeBins,
        safeBinProfiles: safeBinPolicy.safeBinProfiles,
        trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
        skillBins: [],
        autoAllowSkills: false,
        isWindows: false,
        policy: {
          approvedByAsk: false,
          analysisOk: true,
          allowlistSatisfied: true,
        },
        shellCommand: "head -c 16",
        segments: authorizationPlan.groups.flatMap((group) =>
          group.candidates.map((candidate) => candidate.sourceSegment),
        ),
        segmentSatisfiedBy,
        authorizationPlan,
        cwd: undefined,
        env,
      });

      expect(result).not.toBeNull();
      expect(result?.[0]).toBe("/bin/sh");
      expect(result?.[2]).toBe(expectedCommand.command);
    },
  );
});
