import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  collectExecSafeBinCoverageWarnings,
  collectExecSafeBinTrustedDirHintWarnings,
  maybeRepairExecSafeBinProfiles,
  scanExecSafeBinCoverage,
  scanExecSafeBinTrustedDirHints,
} from "./doctor/shared/exec-safe-bins.js";

describe("doctor config flow safe bins", () => {
  it("scaffolds missing custom safe-bin profiles on repair but skips interpreter bins", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["myfilter", "python3"],
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              exec: {
                safeBins: ["mytool", "node"],
              },
            },
          },
        ],
      },
    });

    const cfg = result.config as {
      tools?: {
        exec?: {
          safeBinProfiles?: Record<string, object>;
        };
      };
      agents?: {
        list?: Array<{
          id: string;
          tools?: {
            exec?: {
              safeBinProfiles?: Record<string, object>;
            };
          };
        }>;
      };
    };
    expect(cfg.tools?.exec?.safeBinProfiles?.myfilter).toStrictEqual({});
    expect(cfg.tools?.exec?.safeBinProfiles?.python3).toBeUndefined();
    const ops = cfg.agents?.list?.find((entry) => entry.id === "ops");
    expect(ops?.tools?.exec?.safeBinProfiles?.mytool).toStrictEqual({});
    expect(ops?.tools?.exec?.safeBinProfiles?.node).toBeUndefined();
  });

  it("warns when interpreter/custom safeBins entries are missing profiles in non-repair mode", () => {
    const warnings = collectExecSafeBinCoverageWarnings({
      hits: scanExecSafeBinCoverage({
        tools: {
          exec: {
            safeBins: ["python3", "myfilter"],
          },
        },
      }),
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings.join("\n")).toContain(
      "tools.exec.safeBins includes interpreter/runtime 'python3'",
    );
    expect(warnings.join("\n")).toContain("openclaw doctor --fix");
  });

  it("hints safeBinTrustedDirs when safeBins resolve outside default trusted dirs", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-safe-bins-"));
    const binPath = path.join(dir, "mydoctorbin");
    try {
      await fs.writeFile(binPath, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(binPath, 0o755);
      await withEnvAsync(
        {
          PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          const warnings = collectExecSafeBinTrustedDirHintWarnings(
            scanExecSafeBinTrustedDirHints({
              tools: {
                exec: {
                  safeBins: ["mydoctorbin"],
                  safeBinProfiles: {
                    mydoctorbin: {},
                  },
                },
              },
            }),
          );
          expect(warnings.join("\n")).toContain("outside trusted safe-bin dirs");
          expect(warnings.join("\n")).toContain("tools.exec.safeBinTrustedDirs");
        },
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
