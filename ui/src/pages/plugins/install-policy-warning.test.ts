import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { readPluginInstallPolicyWarning } from "./install-policy-warning.ts";

describe("readPluginInstallPolicyWarning", () => {
  it("parses structured policy warnings", () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "Install requires approval",
      details: {
        installPolicyCode: "install_policy_warning_acknowledgement_required",
        targetName: " openclaw-kitchen-sink-fixture ",
        targetType: "plugin",
        requestMode: "install",
        reason: " ClawScan found issues to review. ",
        findings: [
          {
            ruleId: "semgrep-finding",
            severity: "warn",
            message: "Semgrep found a risky command.",
            file: "index.ts",
            line: 12,
          },
        ],
        futureField: true,
      },
    });

    expect(readPluginInstallPolicyWarning(error)).toEqual({
      installPolicyCode: "install_policy_warning_acknowledgement_required",
      targetName: "openclaw-kitchen-sink-fixture",
      targetType: "plugin",
      requestMode: "install",
      reason: "ClawScan found issues to review.",
      findings: [
        {
          ruleId: "semgrep-finding",
          severity: "warn",
          message: "Semgrep found a risky command.",
          file: "index.ts",
          line: 12,
        },
      ],
    });
  });

  it("rejects malformed policy warning details", () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "Install requires approval",
      details: {
        installPolicyCode: "install_policy_warning_acknowledgement_required",
        targetName: "fixture",
        targetType: "plugin",
        requestMode: "install",
        reason: "Review required.",
        findings: [{ ruleId: "finding", severity: "warn", message: 42 }],
      },
    });

    expect(readPluginInstallPolicyWarning(error)).toBeUndefined();
  });
});
