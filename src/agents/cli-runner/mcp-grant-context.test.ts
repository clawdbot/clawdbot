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

  it("retains trusted sessions_send requester facts in the loopback grant", () => {
    expect(
      buildGrant({
        inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
        trustedSessionHandoff: true,
        sessionHandoffRequester: { messageProvider: "discord", senderId: "alice" },
      }),
    ).toMatchObject({
      trustedSessionHandoff: true,
      sessionHandoffRequester: { messageProvider: "discord", senderId: "alice" },
      cliToolAvailability: { native: [], openClaw: ["message"] },
    });
  });

  it("marks an unrestricted CLI capability universe explicitly", () => {
    expect(buildGrant({ cliToolAvailability: undefined })).toMatchObject({
      cliToolAvailabilityUnrestricted: true,
    });
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
