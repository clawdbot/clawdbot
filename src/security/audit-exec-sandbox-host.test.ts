// Covers exec sandbox host audit findings.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectExecRuntimeFindings } from "./audit.js";

function hasFinding(
  checkId:
    | "tools.exec.host_sandbox_no_sandbox_defaults"
    | "tools.exec.host_sandbox_no_sandbox_agents",
  findings: ReturnType<typeof collectExecRuntimeFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === "warn");
}

describe("security audit exec sandbox host findings", () => {
  it.each([
    {
      name: "defaults host is sandbox",
      cfg: {
        tools: {
          exec: {
            host: "sandbox",
          },
        },
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
            },
          },
        },
      } satisfies OpenClawConfig,
      checkId: "tools.exec.host_sandbox_no_sandbox_defaults" as const,
    },
    {
      name: "agent override host is sandbox",
      cfg: {
        tools: {
          exec: {
            host: "gateway",
          },
        },
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
            },
          },
          list: [
            {
              id: "ops",
              tools: {
                exec: {
                  host: "sandbox",
                },
              },
            },
          ],
        },
      } satisfies OpenClawConfig,
      checkId: "tools.exec.host_sandbox_no_sandbox_agents" as const,
    },
  ])("$name", ({ cfg, checkId }) => {
    expect(hasFinding(checkId, collectExecRuntimeFindings(cfg))).toBe(true);
  });
});
