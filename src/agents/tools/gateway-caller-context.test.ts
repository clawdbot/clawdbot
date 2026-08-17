import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tools.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../channel-tool-metadata.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
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

  it("applies caller identity to private preparation and execution", async () => {
    const seen: unknown[] = [];
    const tool = attachInternalToolExecutionPreparer(
      {
        name: "plugin_tool",
        label: "Plugin tool",
        description: "plugin tool",
        parameters: Type.Object({}),
        execute: vi.fn(async () => ({ content: [], details: {} })),
      },
      async () => {
        seen.push(getGatewayToolCallerIdentity());
        return {
          kind: "ready",
          args: {},
          execute: async () => {
            seen.push(getGatewayToolCallerIdentity());
            return { content: [], details: {} };
          },
          dispose: vi.fn(),
        };
      },
    );
    const identity = { agentId: "agent-a", sessionKey: "agent-a:session" };
    const wrapped = wrapToolWithGatewayCallerIdentity(tool as never, identity);
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(wrapped),
      "gateway-adapted preparer",
    );

    const prepared = await preparer({ toolCallId: "gateway-call", args: {} });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready") {
      await prepared.execute();
    }

    expect(seen).toEqual([identity, identity]);
  });

  it("scopes nested approval ownership without replacing the native runtime owner", async () => {
    let nestedOwner: string | undefined;
    let restoredOwner: string | undefined;

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        approvalOwnerPluginId: "codex",
      },
      async () => {
        await withGatewayToolApprovalOwner("policy-plugin", async () => {
          nestedOwner = getGatewayToolCallerIdentity()?.approvalOwnerPluginId;
        });
        restoredOwner = getGatewayToolCallerIdentity()?.approvalOwnerPluginId;
      },
    );

    expect(nestedOwner).toBe("policy-plugin");
    expect(restoredOwner).toBe("codex");
  });

  it("preserves admitted host authority through nested built-in tool wrappers", async () => {
    const operationalRunInstance = { instanceId: "instance-1", runId: "run-1" };
    const executionIdentityToken = createExecutionIdentityAdmissionToken("run-1");
    let nestedIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance,
        executionIdentityToken,
        turnSourceChannel: "telegram",
      },
      async () => {
        await withGatewayToolCallerIdentity(
          {
            agentId: "nested",
            sessionKey: "agent:nested:session-2",
            cronSelfManagementJobId: "job-1",
            turnSourceChannel: "discord",
          },
          () => {
            nestedIdentity = getGatewayToolCallerIdentity();
          },
        );
      },
    );

    expect(nestedIdentity).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      operationalRunInstance,
      executionIdentityToken,
      cronSelfManagementJobId: "job-1",
      turnSourceChannel: "telegram",
    });
  });

  it("starts a new authority root for a nested admitted run", async () => {
    const outerRun = { instanceId: "outer-instance", runId: "outer-run" };
    const childRun = { instanceId: "child-instance", runId: "child-run" };
    const childToken = createExecutionIdentityAdmissionToken("child-run");
    let nestedIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;

    await withGatewayToolCallerIdentity(
      {
        agentId: "outer",
        sessionKey: "agent:outer:session",
        operationalRunInstance: outerRun,
        executionIdentityToken: createExecutionIdentityAdmissionToken("outer-run"),
        cronSelfManagementJobId: "outer-job",
        turnSourceChannel: "telegram",
      },
      async () => {
        await withGatewayToolCallerIdentity(
          {
            agentId: "child",
            sessionKey: "agent:child:session",
            operationalRunInstance: childRun,
            executionIdentityToken: childToken,
            turnSourceChannel: "discord",
          },
          () => {
            nestedIdentity = getGatewayToolCallerIdentity();
          },
        );
      },
    );

    expect(nestedIdentity).toMatchObject({
      agentId: "child",
      sessionKey: "agent:child:session",
      operationalRunInstance: childRun,
      executionIdentityToken: childToken,
      turnSourceChannel: "discord",
    });
    expect(nestedIdentity?.cronSelfManagementJobId).toBeUndefined();
  });
});
