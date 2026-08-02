import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tools.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../channel-tool-metadata.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  resolveGatewayToolCallerMessageActionCapability,
  runWithGatewayToolCallerRequestContext,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";

describe("gateway caller context wrapper", () => {
  it("preserves tool metadata used by policy and presentation layers", () => {
    const tool: AnyAgentTool = {
      name: "plugin_tool",
      label: "Plugin tool",
      description: "plugin tool",
      parameters: Type.Object({}),
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    };
    setPluginToolMeta(tool, { pluginId: "plugin-a", optional: false });
    setChannelAgentToolMeta(tool as never, { channelId: "telegram" });
    setToolTerminalPresentation(tool, () => ({ text: "done" }));

    const beforeWrapped = wrapToolWithBeforeToolCallHook(tool);
    const wrapped = wrapToolWithGatewayCallerIdentity(beforeWrapped, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
    });

    expect(getPluginToolMeta(wrapped)).toEqual({ pluginId: "plugin-a", optional: false });
    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
    expect(getToolTerminalPresentation(wrapped)).toBe(getToolTerminalPresentation(tool));
    expect(isToolWrappedWithBeforeToolCallHook(wrapped)).toBe(true);
  });

  it("supplies attempt authority to a pre-materialized same-identity tool", async () => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability(undefined);
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
    });

    await runWithGatewayToolCallerRequestContext(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        messageActionTurnCapability: "attempt-token",
      },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: true, token: "attempt-token" });
    expect(resolveGatewayToolCallerMessageActionCapability(undefined)).toEqual({ ok: true });
  });

  it("fails closed on conflicting constructor authority", async () => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability("constructor-token");
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
      messageActionTurnCapability: "constructor-token",
    });

    await runWithGatewayToolCallerRequestContext(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        messageActionTurnCapability: "attempt-token",
      },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: false, reason: "token_conflict" });
  });

  it("clears inherited authority at an untokened nested attempt boundary", async () => {
    const observed = await runWithGatewayToolCallerRequestContext(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        messageActionTurnCapability: "outer-token",
      },
      () =>
        runWithGatewayToolCallerRequestContext(
          { agentId: "agent-a", sessionKey: "agent-a:session" },
          () => resolveGatewayToolCallerMessageActionCapability(undefined),
        ),
    );

    expect(observed).toEqual({ ok: true });
    expect(resolveGatewayToolCallerMessageActionCapability(undefined)).toEqual({ ok: true });
  });

  it("prevents a wrapped tool from reviving constructor authority in an untokened request", async () => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability(undefined);
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
      messageActionTurnCapability: "stale-constructor-token",
    });

    await runWithGatewayToolCallerRequestContext(
      { agentId: "agent-a", sessionKey: "agent-a:session" },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: false, reason: "token_conflict" });
    expect(resolveGatewayToolCallerMessageActionCapability(undefined)).toEqual({ ok: true });
  });

  it.each([
    {
      name: "another session",
      wrappedIdentity: { agentId: "agent-a", sessionKey: "agent-a:other-session" },
    },
    {
      name: "another agent",
      wrappedIdentity: { agentId: "agent-b", sessionKey: "agent-b:session" },
    },
  ])("rejects wrapped authority from $name inside a request boundary", async (testCase) => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability(undefined);
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      ...testCase.wrappedIdentity,
      messageActionTurnCapability: "other-live-token",
    });

    await runWithGatewayToolCallerRequestContext(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        messageActionTurnCapability: "current-request-token",
      },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: false, reason: "token_conflict" });
  });

  it("rejects wrapped authority from another session when the current request has no authority", async () => {
    let observed: unknown;
    const tool: AnyAgentTool = {
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: Type.Object({}),
      execute: async () => {
        observed = resolveGatewayToolCallerMessageActionCapability(undefined);
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    };
    const materialized = wrapToolWithGatewayCallerIdentity(tool, {
      agentId: "agent-a",
      sessionKey: "agent-a:other-session",
      messageActionTurnCapability: "other-live-token",
    });

    await runWithGatewayToolCallerRequestContext(
      { agentId: "agent-a", sessionKey: "agent-a:session" },
      () => materialized.execute?.("call-1", {}),
    );

    expect(observed).toEqual({ ok: false, reason: "token_conflict" });
  });
});
