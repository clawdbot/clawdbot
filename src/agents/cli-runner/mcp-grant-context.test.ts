import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildCliMcpDelegationCapabilityBinding,
  buildCliMcpGrantContext,
} from "./mcp-grant-context.js";
import type { RunCliAgentParams } from "./types.js";

function buildGrant(
  overrides: Partial<RunCliAgentParams> = {},
  delegationCapability?: "full" | "report_only",
) {
  const run = {
    sessionKey: "agent:main:telegram:group:chat123",
    workspaceDir: "/workspace",
    inputProvenance: {
      kind: "inter_session",
      sourceTool: "subagent_announce",
    },
    sourceReplyDeliveryMode: "message_tool_only",
    messageProvider: "telegram",
    currentChannelId: "telegram:chat123",
    cliToolAvailability: { native: [], openClaw: ["message"] },
    ...overrides,
    ...(delegationCapability ? buildCliMcpDelegationCapabilityBinding(delegationCapability) : {}),
  } as RunCliAgentParams;

  return buildCliMcpGrantContext({
    run,
    config: {} as OpenClawConfig,
    requireExplicitMessageTarget: false,
    agentId: "main",
    modelProvider: "openai",
    modelId: "gpt-5.6-luna",
  });
}

describe("buildCliMcpGrantContext source-reply authority", () => {
  it.each(["heartbeat", "cron-event", "exec-event"])(
    "keeps the reply channel separate from the %s turn source",
    (messageProvider) => {
      expect(buildGrant({ messageProvider, messageChannel: "telegram" }).messageProvider).toBe(
        "telegram",
      );
      expect(buildGrant({ messageProvider }).messageProvider).toBeUndefined();
    },
  );

  it("stamps only trusted, message-capped subagent completion grants", () => {
    expect(buildGrant().sourceReplyOnly).toBe(true);
  });

  it("carries the prepared model vision capability into the loopback grant", () => {
    expect(buildGrant({ modelHasVision: true }).modelHasVision).toBe(true);
  });

  it("carries the prepared reply mode into loopback message tools", () => {
    expect(buildGrant({ replyToMode: "all" }).replyToMode).toBe("all");
  });

  it.each(["read-only", "guarded", "workspace", "full"] as const)(
    "carries the exact %s session permission into the loopback grant",
    (permissionMode) => {
      const grant = buildGrant({
        sessionEntry: {
          sessionId: "cli-session",
          updatedAt: 1,
          permissionMode,
          execHost: "gateway",
        },
      });

      expect(grant.execSession).toMatchObject({ permissionMode, execHost: "gateway" });
    },
  );

  it.each([
    { execMode: "deny", permissionMode: "read-only" },
    { execMode: "allowlist", permissionMode: "guarded" },
    { execMode: "ask", permissionMode: "guarded" },
    { execMode: "auto", permissionMode: "workspace" },
    { execMode: "full", permissionMode: "full" },
  ] as const)(
    "preserves effective $execMode execution authority in the granted session",
    ({ execMode, permissionMode }) => {
      const grant = buildGrant({
        sessionEntry: {
          sessionId: "cli-session",
          updatedAt: 1,
          permissionMode: "workspace",
        },
        execOverrides: { mode: execMode },
      });

      expect(grant.execSession?.permissionMode).toBe(permissionMode);
      expect(grant.execOverrides?.mode).toBe(execMode);
    },
  );

  it("narrows a persisted full session to guarded approval for an allowlist override", () => {
    const grant = buildGrant({
      sessionEntry: {
        sessionId: "cli-session",
        updatedAt: 1,
        permissionMode: "full",
      },
      execOverrides: { mode: "allowlist" },
    });

    expect(grant.execSession?.permissionMode).toBe("guarded");
    expect(grant.execOverrides?.mode).toBe("allowlist");
  });

  it("carries the exact Skill Workshop revision into the loopback grant", () => {
    const proposalRevision = {
      agentId: "proposal-owner",
      workspaceDir: "/proposal-workspace",
      proposalId: "proposal-h1",
      expectedRevisionHash: "1".repeat(64),
    };

    expect(buildGrant({ skillWorkshopProposalRevision: proposalRevision }).skillWorkshop).toEqual({
      proposalRevision,
    });
  });

  it("carries both the native channel id and the routable messaging target", () => {
    const grant = buildGrant({
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
    });
    expect(grant.currentChannelId).toBe("D123");
    expect(grant.currentMessagingTarget).toBe("user:U123");
  });

  it.each([
    { label: "the provider", overrides: { messageProvider: undefined } },
    { label: "the destination", overrides: { currentChannelId: undefined } },
  ])("keeps completion authority restricted when $label is missing", ({ overrides }) => {
    expect(buildGrant(overrides).sourceReplyOnly).toBe(true);
  });

  it.each([
    {
      label: "ordinary user provenance",
      overrides: { inputProvenance: { kind: "external_user" } },
    },
    {
      label: "another inter-session source",
      overrides: {
        inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
      },
    },
    {
      label: "automatic source delivery",
      overrides: { sourceReplyDeliveryMode: "automatic" },
    },
    {
      label: "an unrestricted tool grant",
      overrides: { cliToolAvailability: undefined },
    },
    {
      label: "additional granted tools",
      overrides: { cliToolAvailability: { native: [], openClaw: ["message", "read"] } },
    },
  ])("does not stamp source-only authority for $label", ({ overrides }) => {
    expect(buildGrant(overrides as Partial<RunCliAgentParams>).sourceReplyOnly).toBeUndefined();
  });
});

describe("buildCliMcpGrantContext delegationCapability", () => {
  it("stamps a report-only capability into the minted grant", () => {
    expect(buildGrant({}, "report_only")).toMatchObject({
      delegationCapability: "report_only",
    });
  });

  it("leaves the grant shape untouched for ordinary runs", () => {
    // Primary attempts must produce byte-identical grant contexts, so the key
    // is absent rather than explicitly "full".
    expect(buildGrant()).not.toHaveProperty("delegationCapability");
    expect(buildGrant({}, "full")).not.toHaveProperty("delegationCapability");
  });
});
