import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { McpToolCatalogDiagnostic } from "../../agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "../effective-tool-policy.js";
import { filterMcpDiagnosticsByToolPolicy } from "./attempt-bundle-mcp-diagnostics.js";

const memos: McpToolCatalogDiagnostic = {
  serverName: "memos",
  safeServerName: "memos",
  launchSummary: "memos",
  message: "connect ECONNREFUSED 127.0.0.1:5230",
};

/** Runs the probes through the real final policy, as the attempt does for bundle tools. */
function admitWith(config: OpenClawConfig) {
  return (probes: Parameters<typeof applyFinalEffectiveToolPolicy>[0]["bundledTools"]) =>
    applyFinalEffectiveToolPolicy({
      bundledTools: probes,
      config,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({ config }),
      warn: () => {},
    });
}

describe("filterMcpDiagnosticsByToolPolicy", () => {
  it("keeps a failed server whose tools the policy would admit", () => {
    const kept = filterMcpDiagnosticsByToolPolicy(
      [memos],
      admitWith({ tools: { profile: "coding" } }),
    );

    expect(kept).toEqual([memos]);
  });

  it.each([
    {
      label: "tools.deny: ['bundle-mcp']",
      config: { tools: { profile: "coding", deny: ["bundle-mcp"] } },
    },
    { label: "tools.profile: minimal", config: { tools: { profile: "minimal" } } },
  ] satisfies Array<{ label: string; config: OpenClawConfig }>)(
    "drops a failed server hidden by $label",
    ({ config }) => {
      expect(filterMcpDiagnosticsByToolPolicy([memos], admitWith(config))).toBeUndefined();
    },
  );

  it("passes an absent or empty diagnostic list through untouched", () => {
    const admit = () => {
      throw new Error("policy must not run without diagnostics");
    };
    expect(filterMcpDiagnosticsByToolPolicy(undefined, admit)).toBeUndefined();
    expect(filterMcpDiagnosticsByToolPolicy([], admit)).toEqual([]);
  });
});
