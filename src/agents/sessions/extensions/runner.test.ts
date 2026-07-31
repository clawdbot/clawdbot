// Focused tests for emitContext clone gating: the per-turn deep clone of the
// session history must be skipped when no extension registered a "context"
// handler, while handler runs keep receiving an isolated clone.
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { ModelRegistry } from "../model-registry.js";
import type { SessionManager } from "../session-manager.js";
import { ExtensionRunner } from "./runner.js";
import type { Extension, ExtensionRuntime } from "./types.js";

type TestHandler = (...args: unknown[]) => Promise<unknown>;

function buildExtension(handlers?: Record<string, TestHandler[]>): Extension {
  return {
    path: "/tmp/test-extension.ts",
    resolvedPath: "/tmp/test-extension.ts",
    sourceInfo: {
      path: "/tmp/test-extension.ts",
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
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
    {} as ExtensionRuntime,
    "/tmp",
    {} as SessionManager,
    {} as ModelRegistry,
  );
}

function buildMessages(): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ] as AgentMessage[];
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

  it("applies replacement messages returned by a context handler", async () => {
    const replacement = [
      { role: "user", content: [{ type: "text", text: "replaced" }] },
    ] as AgentMessage[];
    const handler: TestHandler = async () => ({ messages: replacement });
    const runner = buildRunner([buildExtension({ context: [handler] })]);

    expect(await runner.emitContext(buildMessages())).toBe(replacement);
  });
});
