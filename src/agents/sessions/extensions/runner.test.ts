import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { ModelRegistry } from "../model-registry.js";
import type { SessionManager } from "../session-manager.js";
import { createExtensionRuntime } from "./loader.js";
import { ExtensionRunner } from "./runner.js";
import type {
  Extension,
  ExtensionActions,
  ExtensionContext,
  ExtensionContextActions,
} from "./types.js";

type TestHandler = (...args: unknown[]) => Promise<unknown>;
type TestHandlers = Record<string, TestHandler[]>;

async function reject(error: Error): Promise<never> {
  throw error;
}

function buildExtension(handlers?: TestHandlers, path = "/tmp/test-extension.ts"): Extension {
  return {
    path,
    resolvedPath: path,
    sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level" },
    handlers: new Map(Object.entries(handlers ?? {})),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
}

function buildRunner(extensions: Extension[]): ExtensionRunner {
  return new ExtensionRunner(
    extensions,
    createExtensionRuntime(),
    "/tmp",
    {} as SessionManager,
    {} as ModelRegistry,
  );
}

function buildMessages(): [AgentMessage, AgentMessage] {
  return [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ] as [AgentMessage, AgentMessage];
}

describe("ExtensionRunner.emitContext", () => {
  it("returns the original array without cloning when no context handlers are registered", async () => {
    const messages = buildMessages();

    const noExtensions = buildRunner([]);
    expect(await noExtensions.emitContext(messages)).toBe(messages);

    const otherHandlersOnly = buildRunner([buildExtension({ user_bash: [async () => undefined] })]);
    expect(await otherHandlersOnly.emitContext(messages)).toBe(messages);
  });

  it("keeps handler mutations isolated from the caller's messages", async () => {
    const messages = buildMessages();
    const handler: TestHandler = async (event) => {
      const contextEvent = event as { messages: AgentMessage[] };
      contextEvent.messages.push({
        role: "user",
        content: [{ type: "text", text: "injected" }],
      } as AgentMessage);
      return undefined;
    };
    const runner = buildRunner([buildExtension({ context: [handler] })]);

    const result = await runner.emitContext(messages);

    expect(result).not.toBe(messages);
    expect(result).toHaveLength(3);
    expect(messages).toHaveLength(2);
  });

  it("chains replacement messages through later context handlers", async () => {
    const [user, assistant] = buildMessages();
    const replacement = [user];
    const final = [assistant];
    const runner = buildRunner([
      buildExtension({
        context: [
          async () => ({ messages: replacement }),
          async (event) => {
            expect((event as { messages: AgentMessage[] }).messages).toBe(replacement);
            return { messages: final };
          },
        ],
      }),
    ]);

    expect(await runner.emitContext(buildMessages())).toBe(final);
  });
});

const catchAndContinueCases: Array<
  [event: string, invoke: (runner: ExtensionRunner) => Promise<unknown>]
> = [
  [
    "session_before_switch",
    (runner) => runner.emit({ type: "session_before_switch", reason: "new" }),
  ],
  [
    "message_end",
    (runner) => runner.emitMessageEnd({ type: "message_end", message: buildMessages()[0] }),
  ],
  [
    "tool_result",
    (runner) =>
      runner.emitToolResult({
        type: "tool_result",
        toolName: "custom",
        toolCallId: "call-1",
        input: {},
        content: [],
        details: undefined,
        isError: false,
      }),
  ],
  [
    "user_bash",
    (runner) =>
      runner.emitUserBash({
        type: "user_bash",
        command: "pwd",
        cwd: "/tmp",
        excludeFromContext: false,
      }),
  ],
  ["context", (runner) => runner.emitContext(buildMessages())],
  ["before_provider_request", (runner) => runner.emitBeforeProviderRequest({})],
  [
    "before_agent_start",
    (runner) => runner.emitBeforeAgentStart("hello", undefined, "system", { cwd: "/tmp" }),
  ],
  ["resources_discover", (runner) => runner.emitResourcesDiscover("/tmp", "startup")],
  ["input", (runner) => runner.emitInput("hello", undefined, "interactive")],
];

describe("ExtensionRunner handler dispatch", () => {
  it.each(catchAndContinueCases)(
    "isolates %s handler failures and reports their extension",
    async (event, invoke) => {
      const failure = new Error(`${event} failed`);
      const continued: string[] = [];
      const continueHandler = async () => {
        continued.push(event);
        if (event === "session_before_switch") {
          return { cancel: true };
        }
        if (event === "input") {
          return { action: "transform", text: "transformed" };
        }
        if (event === "message_end") {
          return { message: buildMessages()[1] };
        }
        return undefined;
      };
      const nextHandlers: TestHandler[] = [continueHandler];
      if (event === "input") {
        nextHandlers.push(
          async (input) => {
            continued.push((input as { text: string }).text);
            return { action: "handled" };
          },
          async () => void continued.push("unreachable"),
        );
      } else if (event === "message_end") {
        nextHandlers.push(
          async (input) => void continued.push((input as { message: AgentMessage }).message.role),
        );
      } else if (event === "session_before_switch") {
        nextHandlers.push(async () => void continued.push("unreachable"));
      }
      const runner = buildRunner([
        buildExtension({ [event]: [() => reject(failure)] }, "/tmp/failing.ts"),
        buildExtension({ [event]: nextHandlers }, "/tmp/next.ts"),
      ]);
      const errors: unknown[] = [];
      runner.onError((error) => errors.push(error));

      await invoke(runner);

      expect(continued).toEqual(
        event === "input"
          ? [event, "transformed"]
          : event === "message_end"
            ? [event, "user"]
            : [event],
      );
      const expectedErrors: unknown[] = [
        {
          extensionPath: "/tmp/failing.ts",
          event,
          error: failure.message,
          stack: failure.stack,
        },
      ];
      if (event === "message_end") {
        expectedErrors.push({
          extensionPath: "/tmp/next.ts",
          event,
          error: "message_end handlers must return a message with the same role",
        });
      }
      expect(errors).toEqual(expectedErrors);
    },
  );

  it("lets tool_call handler failures escape and blocks later handlers", async () => {
    const failure = new Error("block tool execution");
    const laterHandler = vi.fn(async () => undefined);
    const runner = buildRunner([
      buildExtension({
        tool_call: [() => reject(failure), laterHandler],
      }),
    ]);

    await expect(
      runner.emitToolCall({
        type: "tool_call",
        toolName: "custom",
        toolCallId: "call-1",
        input: {},
      }),
    ).rejects.toBe(failure);
    expect(laterHandler).not.toHaveBeenCalled();
  });
});

describe("ExtensionRunner context construction", () => {
  function messageUpdateEvent() {
    return {
      type: "message_update",
      message: buildMessages()[1],
      assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0 },
    } as Parameters<ExtensionRunner["emit"]>[0];
  }

  it.each([
    { name: "no extensions", extensions: [] },
    {
      name: "unrelated handlers",
      extensions: [buildExtension({ user_bash: [async () => undefined] })],
    },
  ])("skips streaming contexts with $name", async ({ extensions }) => {
    const runner = buildRunner(extensions);
    const createContext = vi.spyOn(runner, "createContext");

    await runner.emit(messageUpdateEvent());
    await runner.emit({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "custom",
      args: {},
      partialResult: {},
    });

    expect(createContext).not.toHaveBeenCalled();
  });

  it("shares one context across matching streaming handlers", async () => {
    const contexts: unknown[] = [];
    const record: TestHandler = async (_event, context) => void contexts.push(context);
    const runner = buildRunner([
      buildExtension({ message_update: [record] }, "/tmp/first.ts"),
      buildExtension({ message_update: [record] }, "/tmp/second.ts"),
    ]);
    const createContext = vi.spyOn(runner, "createContext");

    await runner.emit(messageUpdateEvent());

    expect(createContext).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
  });

  it("propagates context construction failures outside extension handler isolation", async () => {
    const failure = new Error("context construction failed");
    const runner = buildRunner([buildExtension({ message_update: [async () => undefined] })]);
    vi.spyOn(runner, "createContext").mockImplementation(() => {
      throw failure;
    });
    const errors: unknown[] = [];
    runner.onError((error) => errors.push(error));

    await expect(runner.emit(messageUpdateEvent())).rejects.toBe(failure);
    expect(errors).toEqual([]);
  });

  it("skips tool-call context construction without a matching handler", async () => {
    const runner = buildRunner([buildExtension({ user_bash: [async () => undefined] })]);
    const createContext = vi.spyOn(runner, "createContext");

    await runner.emitToolCall({
      type: "tool_call",
      toolName: "custom",
      toolCallId: "call-1",
      input: {},
    });

    expect(createContext).not.toHaveBeenCalled();
  });

  it("preserves supplied context identity and its evolving system prompt", async () => {
    const contexts: ExtensionContext[] = [];
    const prompts: string[] = [];
    const runner = buildRunner([
      buildExtension({
        before_agent_start: [
          async (_event, value) => {
            const context = value as ExtensionContext;
            contexts.push(context);
            prompts.push(context.getSystemPrompt());
            return { systemPrompt: "updated" };
          },
          async (_event, value) => {
            const context = value as ExtensionContext;
            contexts.push(context);
            prompts.push(context.getSystemPrompt());
          },
        ],
      }),
    ]);
    const createContext = vi.spyOn(runner, "createContext");

    await expect(
      runner.emitBeforeAgentStart("hello", undefined, "original", { cwd: "/tmp" }),
    ).resolves.toMatchObject({ systemPrompt: "updated" });

    expect(createContext).toHaveBeenCalledOnce();
    expect(contexts[0]).toBe(contexts[1]);
    expect(prompts).toEqual(["original", "updated"]);
  });

  it("keeps lazy live context guards while retaining its captured model getter", () => {
    const runner = buildRunner([]);
    const firstGetModel = vi.fn(() => undefined);
    const secondGetModel = vi.fn(() => undefined);
    const buildActions = (
      getModel: ExtensionContextActions["getModel"],
      idle: boolean,
    ): ExtensionContextActions => ({
      getModel,
      isIdle: () => idle,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "system",
    });

    runner.bindCore({} as ExtensionActions, buildActions(firstGetModel, true));
    const context = runner.createContext();
    const commandContext = runner.createCommandContext();
    expect(typeof Object.getOwnPropertyDescriptor(context, "ui")?.get).toBe("function");
    expect(typeof Object.getOwnPropertyDescriptor(commandContext, "ui")?.get).toBe("function");

    const updatedUi = { ...runner.getUIContext() };
    runner.setUIContext(updatedUi);
    runner.bindCore({} as ExtensionActions, buildActions(secondGetModel, false));

    expect(context.ui).toBe(updatedUi);
    expect(context.hasUI).toBe(true);
    expect(context.isIdle()).toBe(false);
    expect(context.model).toBeUndefined();
    expect(firstGetModel).toHaveBeenCalledOnce();
    expect(secondGetModel).not.toHaveBeenCalled();

    runner.invalidate("session replaced");
    expect(() => context.ui).toThrow("session replaced");
    expect(() => context.isIdle()).toThrow("session replaced");
    expect(() => commandContext.cwd).toThrow("session replaced");
  });
});
