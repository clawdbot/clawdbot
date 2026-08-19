import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCliMcpGrantContext } from "./mcp-grant-context.js";
import type { RunCliAgentParams } from "./types.js";

function buildGrant(overrides: Partial<RunCliAgentParams> = {}) {
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
  it("stamps only trusted, message-capped subagent completion grants", () => {
    expect(buildGrant().sourceReplyOnly).toBe(true);
  });

  it("carries the prepared model vision capability into the loopback grant", () => {
    expect(buildGrant({ modelHasVision: true }).modelHasVision).toBe(true);
  });

  it("carries the prepared reply mode into loopback message tools", () => {
    expect(buildGrant({ replyToMode: "all" }).replyToMode).toBe("all");
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

  it("copies the exact CLI-native and loopback surface into the host grant", () => {
    const grant = buildGrant({
      cliToolAvailability: { native: ["Read", "Bash"], openClaw: ["message"] },
    });

    expect(grant.cliToolAvailability).toEqual({
      native: ["Read", "Bash"],
      openClaw: ["message"],
    });
  });

  it("copies trusted session handoff denies into the host grant", () => {
    const trustedSessionHandoff = {
      inheritedToolPolicy: {
        version: 1 as const,
        allow: ["write"],
        deny: ["apply_patch"],
      },
      requester: { senderId: "source-user" },
    };
    const grant = buildGrant({ trustedSessionHandoff });

    expect(grant.trustedSessionHandoff).toEqual(trustedSessionHandoff);
    expect(grant.trustedSessionHandoff).not.toBe(trustedSessionHandoff);
    expect(grant.trustedSessionHandoff?.inheritedToolPolicy).not.toBe(
      trustedSessionHandoff.inheritedToolPolicy,
    );
  });

  it("does not invent an unrestricted CLI surface when availability is unknown", () => {
    expect(buildGrant({ cliToolAvailability: undefined }).cliToolAvailability).toBeUndefined();
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
