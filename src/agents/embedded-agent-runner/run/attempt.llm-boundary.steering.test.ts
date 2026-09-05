import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  installRuntimeContextMessageForPrompt,
  installModelPromptTransform,
  normalizeMessagesForLlmBoundary,
} from "./attempt-llm-boundary.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

describe("active prompt steering context", () => {
  it.each([
    ["replacement", true],
    ["context", true],
    ["replacement", false],
    ["context", false],
  ] as const)(
    "keeps %s attached to the original keyed user with same-time steering (carrier: %s)",
    async (mode, withCarrier) => {
      const original = {
        role: "user" as const,
        content: "original",
        timestamp: 1,
        idempotencyKey: "original-user",
      };
      const steering = {
        role: "user" as const,
        content: "steering",
        timestamp: 1,
        idempotencyKey: "steering-user",
      };
      const session = {
        get messages() {
          return this.agent.state.messages;
        },
        agent: {
          state: { messages: [] as AgentMessage[] },
          continue: async () => undefined,
          transformContext: async (messages: AgentMessage[]) => messages,
        },
      };
      const originalTransform = session.agent.transformContext;
      const originalContinue = session.agent.continue;
      const cleanupPrompt = installModelPromptTransform({
        session,
        transcriptPrompt: "original",
        ...(mode === "replacement"
          ? { modelPrompt: "private model prompt" }
          : { prependContext: "before", appendContext: "after" }),
        shouldCapturePrompt: () => true,
      });
      const cleanupCarrier = installRuntimeContextMessageForPrompt({
        session,
        message: withCarrier ? buildRuntimeContextCustomMessage("original context") : undefined,
      });
      session.agent.state.messages.push(original);
      const prefix = await session.agent.transformContext(session.messages);
      session.agent.state.messages.push(steering);
      const steered = await session.agent.transformContext(session.messages);
      cleanupCarrier();
      cleanupPrompt();
      expect(steered.slice(0, prefix.length)).toEqual(prefix);
      expect(steered.at(-1)).toBe(steering);
      expect(session.agent.transformContext).toBe(originalTransform);
      expect(session.agent.continue).toBe(originalContinue);
    },
  );
  it.each(["keyless", "keyed", "rewritten key"])(
    "restores the original %s transcript user after actual compaction rebuild",
    async (mode) => {
      const original = { role: "user" as const, content: "original", timestamp: 1 };
      const steering = { role: "user" as const, content: "steering", timestamp: 1 };
      const manager = SessionManager.inMemory();
      const contexts = createUserTranscriptContextRegistry();
      const session = {
        get messages() {
          return this.agent.state.messages;
        },
        agent: {
          state: { messages: [] as AgentMessage[] },
          continue: async () => undefined,
          transformContext: async (messages: AgentMessage[]) => messages,
        },
      };
      const message = buildRuntimeContextCustomMessage("original context");
      const cleanupPrompt = installModelPromptTransform({
        session,
        transcriptPrompt: "original",
        prependContext: "before",
        shouldCapturePrompt: () => true,
      });
      const cleanup = installRuntimeContextMessageForPrompt({
        session,
        message,
        ...(mode === "rewritten key" ? { persistedUserIdempotencyKey: "before-hook-key" } : {}),
      });
      session.agent.state.messages.push(original);
      const persisted = manager.appendMessageWithTranscriptAnchor({
        ...original,
        ...(mode === "keyless" ? {} : { idempotencyKey: "canonical-key" }),
      });
      contexts.record(original, persisted.message);
      normalizeMessagesForLlmBoundary(await session.agent.transformContext(session.messages), {
        userTranscriptContexts: contexts.list(),
      });
      const persistedSteering = manager.appendMessageWithTranscriptAnchor(steering);
      manager.appendCompaction("Earlier context was summarized.", persisted.entryId, 100);
      session.agent.state.messages = manager.buildSessionContext().messages;
      await session.agent.continue();
      const retry = session.messages;
      const projected = await session.agent.transformContext(retry);
      cleanup();
      cleanupPrompt();
      expect(persisted.message).not.toBe(original);
      expect(retry.slice(-3)).toEqual([message, persisted.message, persistedSteering.message]);
      expect(projected.at(-2)).toMatchObject({ content: "before\n\noriginal" });
      expect(projected.at(-1)).toBe(persistedSteering.message);
      expect(session.messages).not.toContain(message);
    },
  );

  it.each([false, true])(
    "replays a carrierless keyless prompt only with an unambiguous canonical timestamp (%s)",
    async (ambiguous) => {
      const original: AgentMessage = { role: "user", content: "original", timestamp: 1 };
      const manager = SessionManager.inMemory();
      const session = { agent: { transformContext: async (messages: AgentMessage[]) => messages } };
      const cleanup = installModelPromptTransform({
        session,
        transcriptPrompt: "original",
        prependContext: "before",
        shouldCapturePrompt: () => true,
      });
      await session.agent.transformContext([original]);
      const persisted = manager.appendMessageWithTranscriptAnchor(original);
      if (ambiguous) {
        manager.appendMessage({ role: "user", content: "steering", timestamp: 1 });
      }
      manager.appendCompaction("Earlier context was summarized.", persisted.entryId, 100);
      const canonical = manager.buildSessionContext().messages;
      const projected = await session.agent.transformContext(canonical);
      cleanup();
      if (ambiguous) {
        expect(projected).toEqual(canonical);
      } else {
        expect(projected.at(-1)).toMatchObject({ content: "before\n\noriginal" });
      }
    },
  );

  it("does not adopt same-time steering after compaction removes the owned prompt", async () => {
    const original: AgentMessage = { role: "user", content: "original", timestamp: 1 };
    const steering: AgentMessage = { role: "user", content: "steering", timestamp: 1 };
    const session = {
      get messages() {
        return this.agent.state.messages;
      },
      agent: {
        state: { messages: [] as AgentMessage[] },
        continue: async () => undefined,
        transformContext: async (messages: AgentMessage[]) => messages,
      },
    };
    const cleanupPrompt = installModelPromptTransform({
      session,
      transcriptPrompt: "original",
      prependContext: "before",
      shouldCapturePrompt: () => true,
    });
    const cleanupCarrier = installRuntimeContextMessageForPrompt({
      session,
      message: buildRuntimeContextCustomMessage("original context"),
    });
    session.agent.state.messages.push(original);
    await session.agent.transformContext(session.messages);
    const manager = SessionManager.inMemory();
    manager.appendMessage(original);
    const kept = manager.appendMessageWithTranscriptAnchor(steering);
    manager.appendCompaction("Original request was summarized.", kept.entryId, 100);
    session.agent.state.messages = manager.buildSessionContext().messages;
    await session.agent.continue();
    const projected = await session.agent.transformContext(session.messages);
    cleanupCarrier();
    cleanupPrompt();
    expect(projected.at(-1)).toBe(kept.message);
  });
  it("preserves the active prompt prefix through steering and retires it on cleanup", () => {
    const messages: AgentMessage[] = [];
    const session = {
      get messages() {
        return this.agent.state.messages;
      },
      agent: { state: { messages } },
    };
    const message = expectDefined(
      buildRuntimeContextCustomMessage("inbound channel context"),
      "runtime context fixture",
    );
    const cleanup = installRuntimeContextMessageForPrompt({ session, message });
    const promptText =
      'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"channel":"discord"}\n```\n\nOriginal ask';
    const prompt: AgentMessage = {
      role: "user",
      content: promptText,
      timestamp: 1717574460000,
    };
    session.agent.state.messages.push(prompt);
    const options = {
      timezone: "UTC",
      currentUserTimestampOverride: { timestamp: 1717570800000, text: promptText },
    };
    const project = () =>
      relocateCurrentRuntimeContextCarrierToTail(
        normalizeMessagesForLlmBoundary(session.messages, options),
      );
    const prefix = project();
    session.agent.state.messages.push({
      role: "user",
      content: "new requirement",
      timestamp: 1717570860000,
    });
    const steered = project();
    cleanup();

    expect(steered.slice(0, prefix.length)).toEqual(prefix);
    expect(steered.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("new requirement"),
    });
    expect(session.messages).not.toContain(message);
    expect(project()[0]).toMatchObject({
      content: expect.not.stringContaining("Conversation info:"),
    });
    // A retained reference must not confer active-prompt ownership after cleanup.
    session.agent.state.messages.unshift(message);
    expect(project()).not.toContain(message);
  });

  it("reinstalls retry context before its keyed original user after steering", async () => {
    const original = {
      role: "user",
      content: "original",
      timestamp: 1,
      idempotencyKey: "original-turn",
    } as AgentMessage;
    const steering = { role: "user", content: "steering", timestamp: 2 } as AgentMessage;
    const session = {
      get messages() {
        return this.agent.state.messages;
      },
      agent: { state: { messages: [original] }, continue: async () => undefined },
    };
    const message = buildRuntimeContextCustomMessage("original context");
    const originalContinue = session.agent.continue;
    const cleanup = installRuntimeContextMessageForPrompt({
      session,
      message,
      persistedUserIdempotencyKey: "original-turn",
    });
    session.agent.state.messages = [structuredClone(original), steering];
    await session.agent.continue();
    const retry = session.messages;
    cleanup();
    expect(retry).toEqual([message, original, steering]);
    expect(session.agent.continue).toBe(originalContinue);
    expect(session.messages).toEqual([original, steering]);
  });

  it.each(["model prompt", "existing context hook"])(
    "restores the unkeyed source user after a %s transform",
    async (mode) => {
      const original: AgentMessage = { role: "user", content: "original", timestamp: 1 };
      const steering: AgentMessage = { role: "user", content: "steering", timestamp: 2 };
      const session = {
        get messages() {
          return this.agent.state.messages;
        },
        agent: {
          state: { messages: [] as AgentMessage[] },
          continue: async () => undefined,
          transformContext: async (messages: AgentMessage[]) =>
            mode === "existing context hook"
              ? messages.map((message) =>
                  message.role === "user" ? { ...message, content: "projected" } : message,
                )
              : messages,
        },
      };
      const originalTransform = session.agent.transformContext;
      const cleanupPrompt = installModelPromptTransform({
        session,
        transcriptPrompt: "original",
        modelPrompt: mode === "model prompt" ? "projected" : undefined,
        shouldCapturePrompt: () => true,
      });
      const message = buildRuntimeContextCustomMessage("original context");
      const cleanup = installRuntimeContextMessageForPrompt({ session, message });
      session.agent.state.messages.push(original);
      normalizeMessagesForLlmBoundary(await session.agent.transformContext(session.messages));
      session.agent.state.messages = [original, steering];
      await session.agent.continue();
      const retry = session.messages;
      cleanup();
      cleanupPrompt();
      expect(retry).toEqual([message, original, steering]);
      expect(session.agent.transformContext).toBe(originalTransform);
      expect(session.messages).toEqual([original, steering]);
    },
  );
});
