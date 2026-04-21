import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { collectFeishuSecurityAuditFindings } from "./security-audit.js";

describe("Feishu security audit findings", () => {
  it.each([
    {
      name: "warns when doc tool is enabled because create can grant requester access",
      cfg: {
        channels: {
          feishu: {
            appId: "cli_test",
            appSecret: "secret_test",
          },
        },
      } satisfies OpenClawConfig,
      expectedFinding: "channels.feishu.doc_owner_open_id",
    },
    {
      name: "treats SecretRef appSecret as configured for doc tool risk detection",
      cfg: {
        channels: {
          feishu: {
            appId: "cli_test",
            appSecret: {
              source: "env",
              provider: "default",
              id: "FEISHU_APP_SECRET",
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedFinding: "channels.feishu.doc_owner_open_id",
    },
    {
      name: "does not warn for doc grant risk when doc tools are disabled",
      cfg: {
        channels: {
          feishu: {
            appId: "cli_test",
            appSecret: "secret_test",
            tools: { doc: false },
          },
        },
      } satisfies OpenClawConfig,
      expectedNoFinding: "channels.feishu.doc_owner_open_id",
    },
  ])("$name", ({ cfg, expectedFinding, expectedNoFinding }) => {
    const findings = collectFeishuSecurityAuditFindings({ cfg });
    if (expectedFinding) {
      expect(
        findings.some(
          (finding) => finding.checkId === expectedFinding && finding.severity === "warn",
        ),
      ).toBe(true);
    }
    if (expectedNoFinding) {
      expect(findings.some((finding) => finding.checkId === expectedNoFinding)).toBe(false);
    }
  });
});
