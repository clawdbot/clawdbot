import { describe, expect, it } from "vitest";
import {
  buildPluginApprovalRequestMessage,
  type PluginApprovalRequest,
} from "./plugin-approvals.js";

describe("plugin external approval presentation", () => {
  it("emits the accepted text fallback without a generic allow command", () => {
    const request: PluginApprovalRequest = {
      id: "plugin:external-1",
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
      request: {
        title: "World verification",
        description: "Verify personhood before continuing.",
        pluginId: "agentkit",
        toolName: "dangerous-tool",
        agentId: "main",
        externalResolution: {
          label: "Verify with World",
          decisions: ["allow-once", "allow-always"],
        },
      },
    };

    expect(buildPluginApprovalRequestMessage(request, 1_000)).toContain(
      [
        "Verify with World",
        "Verify once: /approve plugin:external-1 external allow-once",
        "Verify and trust for session: /approve plugin:external-1 external allow-always",
        "Deny: /approve plugin:external-1 deny",
      ].join("\n"),
    );
    expect(buildPluginApprovalRequestMessage(request, 1_000)).not.toContain(
      "/approve plugin:external-1 allow-once",
    );
  });
});
