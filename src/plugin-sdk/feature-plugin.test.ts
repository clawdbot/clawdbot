import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createCapturedPluginRegistration } from "../plugins/captured-registration.js";
import type {
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
} from "../plugins/plugin-command.types.js";
import type { OpenClawPluginToolFactory } from "../plugins/tool-types.js";
import { defineFeatureContract } from "./feature-contract.js";
import { defineFeaturePlugin, type FeatureInvocationContext } from "./feature-plugin.js";
import { getToolPluginMetadata } from "./tool-plugin.js";

const contract = defineFeatureContract({
  pluginId: "feature-fixture",
  operations: {
    inspect: {
      kind: "query",
      description: "Read a fixture value.",
      input: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      output: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      tool: { name: "fixture_inspect" },
    },
  },
  events: { changed: Type.Object({ value: Type.String() }) },
});

describe("typed feature plugins", () => {
  it("shares typed handlers without losing action, tool, or command invocation context", async () => {
    const contexts: FeatureInvocationContext[] = [];
    const entry = defineFeaturePlugin({
      contract,
      name: "Feature fixture",
      description: "Fixture operations.",
      setup: () => ({
        inspect(input, context) {
          expectTypeOf(input.value).toEqualTypeOf<string>();
          contexts.push(context);
          return { value: input.value };
        },
      }),
      commands: {
        inspect: {
          name: "fixture-inspect",
          parse: (context) => ({ value: context.args ?? "" }),
          format: (output) => ({ text: output.value }),
        },
      },
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      { name: "fixture_inspect", outputSchema: contract.operations.inspect.output },
    ]);
    const captured = createCapturedPluginRegistration({ id: contract.pluginId });
    let factory: OpenClawPluginToolFactory | undefined;
    let command: OpenClawPluginCommandDefinition | undefined;
    captured.api.registerTool = (tool) => {
      if (typeof tool === "function") {
        factory = tool;
      }
    };
    captured.api.registerCommand = (value) => {
      command = value;
    };
    entry.register(captured.api);
    const action = expectDefined(captured.sessionActions[0], "registered feature action");
    const actionContext = {
      pluginId: contract.pluginId,
      actionId: "inspect",
      payload: { value: "action" },
      client: { connId: "browser", scopes: ["operator.read"] },
    };
    expect(await action.handler(actionContext)).toEqual({ ok: true, result: { value: "action" } });
    expect(action.requiredScopes).toEqual(["operator.read"]);

    const toolContext = { sessionKey: "agent:fixture:task", agentId: "fixture", sandboxed: true };
    const tool = expectDefined(factory, "registered feature tool factory")(toolContext);
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one feature tool");
    }
    const controller = new AbortController();
    const onUpdate = vi.fn();
    expect(
      (await tool.execute("call-42", { value: "tool" }, controller.signal, onUpdate)).details,
    ).toEqual({ value: "tool" });
    const commandContext = {
      args: "command",
      channel: "chat",
      isAuthorizedSender: true,
      sessionKey: "agent:fixture:chat",
    } as PluginCommandContext;
    expect(
      await expectDefined(command, "registered feature command").handler(commandContext),
    ).toEqual({ text: "command" });
    expect(contexts).toEqual([
      { source: "session-action", action: actionContext, api: captured.api },
      {
        source: "tool",
        tool: toolContext,
        toolCallId: "call-42",
        signal: controller.signal,
        onUpdate,
        api: captured.api,
      },
      { source: "command", command: commandContext, api: captured.api },
    ]);
    expect(contexts[1]?.source === "tool" && contexts[1].tool).toBe(toolContext);
  });

  it("rejects invalid inputs before execution and invalid outputs before returning success", async () => {
    const execute = vi.fn(() => ({ value: 42 }));
    const entry = defineFeaturePlugin({
      contract,
      name: "Feature fixture",
      description: "Fixture operations.",
      setup: () => ({
        inspect: execute as unknown as (input: { value: string }) => { value: string },
      }),
    });
    const captured = createCapturedPluginRegistration({ id: contract.pluginId });
    entry.register(captured.api);
    const action = expectDefined(captured.sessionActions[0], "registered feature action");
    expect(
      await action.handler({
        pluginId: contract.pluginId,
        actionId: "inspect",
        payload: { value: 4 },
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(execute).not.toHaveBeenCalled();
    expect(
      await action.handler({
        pluginId: contract.pluginId,
        actionId: "inspect",
        payload: { value: "valid" },
      }),
    ).toMatchObject({ ok: false, code: "INVALID_OUTPUT" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates tool cancellation across awaited feature handlers", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry = defineFeaturePlugin({
      contract,
      name: "Feature fixture",
      description: "Fixture operations.",
      setup: () => ({
        inspect: async (input) => {
          await pending;
          return input;
        },
      }),
    });
    const captured = createCapturedPluginRegistration({ id: contract.pluginId });
    let factory: OpenClawPluginToolFactory | undefined;
    captured.api.registerTool = (tool) => {
      if (typeof tool === "function") {
        factory = tool;
      }
    };
    entry.register(captured.api);
    const tool = expectDefined(factory, "feature tool factory")({});
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one feature tool");
    }
    const controller = new AbortController();
    const result = tool.execute("cancelled-call", { value: "pending" }, controller.signal);
    controller.abort(new Error("tool cancelled"));
    expectDefined(finish, "feature handler completion")();
    await expect(result).rejects.toThrow("tool cancelled");
  });
});
