import { describe, expect, it } from "vitest";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import { resolveExecApprovalsFromFile } from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { resolveSystemRunExecArgv } from "./invoke-system-run-allowlist.js";

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

describe("resolveSystemRunExecArgv", () => {
  it.runIf(process.platform !== "win32")(
    "keeps rebuilt shell argv behind a final allowlist check",
    () => {
      const env = { PATH: "/usr/bin:/bin" };
      const analysis = analyzeShellCommand({
        command: "head -c 16",
        env,
        platform: process.platform,
      });
      expect(analysis.ok).toBe(true);
      if (!analysis.ok) {
        return;
      }

      const result = resolveSystemRunExecArgv({
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
        segments: analysis.segments,
        segmentSatisfiedBy: ["safeBins"],
        cwd: undefined,
        env,
      });

      expect(result).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns rebuilt shell argv when the final allowlist check passes",
    () => {
      const env = { PATH: "/usr/bin:/bin" };
      const analysis = analyzeShellCommand({
        command: "head -c 16",
        env,
        platform: process.platform,
      });
      expect(analysis.ok).toBe(true);
      if (!analysis.ok) {
        return;
      }
      const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
        global: { safeBins: ["head"] },
      });

      const result = resolveSystemRunExecArgv({
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
        segments: analysis.segments,
        segmentSatisfiedBy: ["safeBins"],
        cwd: undefined,
        env,
      });

      expect(result).not.toBeNull();
      expect(result?.[0]).toBe("/bin/sh");
      expect(result?.[2]).toContain("head");
      expect(result?.[2]).not.toBe("head -c 16");
    },
  );
});
