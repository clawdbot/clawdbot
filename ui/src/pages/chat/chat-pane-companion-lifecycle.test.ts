/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-companion-lifecycle.test/"} */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { ChatSessionCompanionThreads } from "./chat-session-companion.ts";

const companionThreads = (pane: TestChatPane) =>
  (pane as TestChatPane & { sessionCompanionThreads: ChatSessionCompanionThreads })
    .sessionCompanionThreads;

describe("chat pane companion connection lifecycle", () => {
  it("preserves threads while a same-client reconnect settles a pending answer", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    let rejectAnswer!: (error: Error) => void;
    const threads = companionThreads(pane);
    await threads.hydrate(
      "agent:main:current",
      async () => ({
        exchanges: [{ question: "Earlier question", answer: "Earlier answer", ts: 1 }],
      }),
      "main",
    );
    const pending = threads.submit(
      "agent:main:current",
      "current question",
      () =>
        new Promise((_resolve, reject) => {
          rejectAnswer = reject;
        }),
      "main",
    );
    threads.setDraft("agent:main:other", "other draft", "main");

    // GatewayProtocolClient flushes pending requests before publishing the
    // reconnecting snapshot; Promise rejection settles on the next microtask.
    rejectAnswer(new Error("gateway closed"));
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });

    expect(threads.view("agent:main:current", "main").exchanges).toEqual([
      { question: "Earlier question", answer: "Earlier answer", ts: 1 },
    ]);
    expect(threads.view("agent:main:other", "main").draft).toBe("other draft");
    await pending;
    expect(threads.view("agent:main:current", "main")).toMatchObject({
      exchanges: [{ question: "Earlier question", answer: "Earlier answer", ts: 1 }],
      failedQuestion: "current question",
      pendingQuestion: null,
    });

    pane.connectedClient = client;
    pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot, phase: "connected" });
    expect(threads.view("agent:main:other", "main").draft).toBe("other draft");
    await threads.hydrate(
      "agent:main:current",
      async () => ({
        exchanges: [
          { question: "Earlier question", answer: "Earlier answer", ts: 1 },
          { question: "current question", answer: "Recovered answer", ts: 2 },
        ],
      }),
      "main",
    );
    expect(threads.view("agent:main:current", "main")).toMatchObject({
      exchanges: [
        { question: "Earlier question", answer: "Earlier answer", ts: 1 },
        { question: "current question", answer: "Recovered answer", ts: 2 },
      ],
      failedQuestion: null,
      pendingQuestion: null,
    });
  });

  it("retires every thread and late answer when the Gateway client is replaced", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const replacement = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const threads = companionThreads(pane);
    let resolveAnswer!: (value: { answer: string; ts: number }) => void;
    const pending = threads.submit(
      "agent:main:current",
      "replace this question",
      () =>
        new Promise((resolve) => {
          resolveAnswer = resolve;
        }),
      "main",
    );
    threads.setDraft("agent:main:other", "replace this draft", "main");

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: replacement,
      phase: "reconnecting",
      hello: null,
    });

    expect(threads.view("agent:main:current", "main")).toMatchObject({
      exchanges: [],
      failedQuestion: null,
      pendingQuestion: null,
    });
    expect(threads.view("agent:main:other", "main").draft).toBe("");
    resolveAnswer({ answer: "late answer", ts: 3 });
    await pending;
    expect(threads.view("agent:main:current", "main").exchanges).toEqual([]);
  });
});
