import { describe, expect, it } from "vitest";
import { canResolveScheduledConfiguredMcpCreatorAuthority } from "./scheduled-configured-mcp-authority.js";

const eligible = {
  trigger: "user",
  connectionClass: "local-loopback",
  bindingKind: "session",
  bindingSessionKey: "agent:main:main",
  sessionKey: "agent:main:main",
  usesSupervisionConnection: false,
  preservesNativeModel: false,
  senderIsOwner: true,
  hasStaticConfiguredMcp: true,
} as const;

describe("canResolveScheduledConfiguredMcpCreatorAuthority", () => {
  it("admits only the positive local durable operator case", () => {
    expect(canResolveScheduledConfiguredMcpCreatorAuthority(eligible)).toBe(true);
  });

  it.each([
    ["non-user trigger", { trigger: "cron" }],
    ["non-loopback connection", { connectionClass: "remote" }],
    ["non-session binding", { bindingKind: "supervision" }],
    ["missing durable binding key", { bindingSessionKey: undefined }],
    ["incognito session", { sessionKey: "agent:main:dashboard:incognito-test" }],
    ["supervision", { usesSupervisionConnection: true }],
    ["preserved native model", { preservesNativeModel: true }],
    ["non-owner", { senderIsOwner: false }],
    ["external sender", { senderId: "sender-1" }],
    ["input provenance", { inputProvenance: { kind: "external_user" } }],
    ["trusted handoff", { trustedInternalHandoff: { kind: "completion" } }],
    ["spawn lineage", { spawnedBy: "agent:main:parent" }],
    ["scheduled policy", { scheduledToolPolicy: { version: 1 } }],
    ["no static configured MCP", { hasStaticConfiguredMcp: false }],
  ])("rejects %s", (_label, override) => {
    expect(canResolveScheduledConfiguredMcpCreatorAuthority({ ...eligible, ...override })).toBe(
      false,
    );
  });
});
