import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectExecRuntimeFindings } from "./audit.js";

function hasFinding(
  checkId:
    | "tools.exec.safe_bins_interpreter_unprofiled"
    | "tools.exec.safe_bins_broad_behavior"
    | "tools.exec.safe_bin_trusted_dirs_risky",
  findings: ReturnType<typeof collectExecRuntimeFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === "warn");
}

function requireFinding(
  checkId: "tools.exec.safe_bin_trusted_dirs_risky",
  findings: ReturnType<typeof collectExecRuntimeFindings>,
) {
  const finding = findings.find((entry) => entry.checkId === checkId);
  if (!finding) {
    throw new Error(`Expected ${checkId} finding`);
  }
  return finding;
}

describe("security audit exec safe-bin findings", () => {
  it.each([
    {
      name: "missing profiles",
      cfg: {
        tools: {
          exec: {
            safeBins: ["python3"],
          },
        },
        agents: {
          list: [
            {
              id: "ops",
              tools: {
                exec: {
                  safeBins: ["node"],
                },
              },
            },
          ],
        },
      } satisfies OpenClawConfig,
      expected: true,
    },
    {
      name: "profiles configured",
      cfg: {
        tools: {
          exec: {
            safeBins: ["python3"],
            safeBinProfiles: {
              python3: {
                maxPositional: 0,
              },
            },
          },
        },
        agents: {
          list: [
            {
              id: "ops",
              tools: {
                exec: {
                  safeBins: ["node"],
                  safeBinProfiles: {
                    node: {
                      maxPositional: 0,
                    },
                  },
                },
              },
            },
          ],
        },
      } satisfies OpenClawConfig,
      expected: false,
    },
  ])(
    "warns for interpreter safeBins only when explicit profiles are missing: $name",
    ({ cfg, expected }) => {
      expect(
        hasFinding("tools.exec.safe_bins_interpreter_unprofiled", collectExecRuntimeFindings(cfg)),
      ).toBe(expected);
    },
  );

  it.each([
    {
      name: "jq configured globally",
      cfg: {
        tools: {
          exec: {
            safeBins: ["jq"],
          },
        },
      } satisfies OpenClawConfig,
      expected: true,
    },
    {
      name: "jq not configured",
      cfg: {
        tools: {
          exec: {
            safeBins: ["cut"],
          },
        },
      } satisfies OpenClawConfig,
      expected: false,
    },
  ])(
    "warns when risky broad-behavior bins are explicitly added to safeBins: $name",
    ({ cfg, expected }) => {
      expect(
        hasFinding("tools.exec.safe_bins_broad_behavior", collectExecRuntimeFindings(cfg)),
      ).toBe(expected);
    },
  );

  it("evaluates safeBinTrustedDirs risk findings", () => {
    const riskyGlobalTrustedDirs =
      process.platform === "win32"
        ? [String.raw`C:\Users\ci-user\bin`, String.raw`C:\Users\ci-user\.local\bin`]
        : ["/usr/local/bin", "/tmp/openclaw-safe-bins"];
    const findings = collectExecRuntimeFindings({
      tools: {
        exec: {
          safeBinTrustedDirs: riskyGlobalTrustedDirs,
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              exec: {
                safeBinTrustedDirs: ["./relative-bin-dir"],
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig);

    const riskyFinding = requireFinding("tools.exec.safe_bin_trusted_dirs_risky", findings);
    expect(riskyFinding.severity).toBe("warn");
    expect(riskyFinding.detail).toContain(riskyGlobalTrustedDirs[0]);
    expect(riskyFinding.detail).toContain(riskyGlobalTrustedDirs[1]);
    expect(riskyFinding.detail).toContain("agents.list.ops.tools.exec");
  });

  it("ignores non-risky absolute dirs", () => {
    expect(
      hasFinding(
        "tools.exec.safe_bin_trusted_dirs_risky",
        collectExecRuntimeFindings({
          tools: {
            exec: {
              safeBinTrustedDirs: ["/usr/libexec"],
            },
          },
        } satisfies OpenClawConfig),
      ),
    ).toBe(false);
  });
});
