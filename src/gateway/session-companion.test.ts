import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
} from "../agents/tools/sessions-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SessionCompanionAskError } from "./session-companion-ask.js";
import {
  buildSessionCompanionRunConfig,
  SESSION_COMPANION_TOOLS,
} from "./session-companion-policy.js";
import { trimSessionCompanionExchanges } from "./session-companion-state.js";
import { createSessionCompanion } from "./session-companion.js";
import type { SessionObserverCompanionSnapshot } from "./session-observer-contract.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createHarness(overrides?: {
  now?: () => number;
  readSeedMessages?: () => Promise<Array<{ role: "user" | "assistant"; text: string; ts: number }>>;
  run?: (params: {
    messages: Array<{ role: "user" | "assistant"; content: string; ts: number }>;
    systemPrompt: string;
  }) => Promise<string>;
  snapshot?: () => SessionObserverCompanionSnapshot;
}) {
  const cfg: OpenClawConfig = {};
  const readSeedMessages = vi.fn(
    overrides?.readSeedMessages ??
      (async () => [{ role: "user" as const, text: "seed question", ts: 1 }]),
  );
  const run = vi.fn(overrides?.run ?? (async () => "Evidence says the build is green."));
  const getCompanionSnapshot = vi.fn(
    overrides?.snapshot ??
      (() => ({
        agentId: "main",
        digest: {
          sessionKey: "agent:main:main",
          revision: 2,
          updatedAt: 10,
          headline: "Running tests",
          health: "on-track" as const,
        },
        notes: [{ sequence: 1, text: "Tool: read package.json" }],
      })),
  );
  const service = createSessionCompanion({
    getConfig: () => cfg,
    sessionObserver: { getCompanionSnapshot },
    resolveUtilityModelRef: () => "openai/gpt-5.6-luna",
    readSeedMessages,
    run,
    now: overrides?.now ?? (() => 100),
  });
  return { getCompanionSnapshot, readSeedMessages, run, service };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session companion asks", () => {
  it("answers with the frozen seed, observer delta, utility model, and read-only prompt", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await expect(
      harness.service.ask({
        sessionKey: "agent:main:main",
        question: "Why is it reading that file?",
        connId: "conn-1",
      }),
    ).resolves.toEqual({ answer: "Evidence says the build is green.", ts: 100 });

    expect(harness.run).toHaveBeenCalledOnce();
    const call = harness.run.mock.calls[0]?.[0];
    expect(call?.systemPrompt).toContain("read-only companion observing session agent:main:main");
    expect(call?.systemPrompt).toContain("must not attempt any mutation");
    expect(call?.messages).toHaveLength(2);
    expect(JSON.parse(call?.messages[0]?.content ?? "{}")).toEqual({
      inheritedSessionMessages: [{ role: "user", text: "seed question", ts: 1 }],
      observerDigestJson: JSON.stringify({
        sessionKey: "agent:main:main",
        revision: 2,
        updatedAt: 10,
        headline: "Running tests",
        health: "on-track",
      }),
    });
    expect(JSON.parse(call?.messages[1]?.content ?? "{}")).toEqual({
      observerNotes: [{ sequence: 1, text: "Tool: read package.json" }],
      question: "Why is it reading that file?",
    });
    expect(harness.service.state("agent:main:main").exchanges).toEqual([
      {
        question: "Why is it reading that file?",
        answer: "Evidence says the build is green.",
        ts: 100,
      },
    ]);
    harness.service.dispose();
  });

  it("serializes asks per session with a typed busy error", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const harness = createHarness({ run: async () => await pending.promise });
    const first = harness.service.ask({
      sessionKey: "agent:main:main",
      question: "First?",
      connId: "conn-1",
    });
    await vi.waitFor(() => expect(harness.run).toHaveBeenCalledOnce());

    await expect(
      harness.service.ask({
        sessionKey: "agent:main:main",
        question: "Second?",
        connId: "conn-2",
      }),
    ).rejects.toMatchObject({ reason: "busy" } satisfies Partial<SessionCompanionAskError>);

    pending.resolve("first answer");
    await expect(first).resolves.toMatchObject({ answer: "first answer" });
    harness.service.dispose();
  });

  it("enforces the per-connection rate window", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    for (let index = 0; index < 4; index += 1) {
      await harness.service.ask({
        sessionKey: `agent:main:session-${index}`,
        question: `Question ${index}?`,
        connId: "conn-1",
      });
    }
    await expect(
      harness.service.ask({
        sessionKey: "agent:main:session-5",
        question: "One too many?",
        connId: "conn-1",
      }),
    ).rejects.toMatchObject({
      reason: "rate-limited",
      retryAfterMs: 60_000,
    } satisfies Partial<SessionCompanionAskError>);
    expect(harness.run).toHaveBeenCalledTimes(4);
    harness.service.dispose();
  });

  it("enforces the global rate window across connections", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    for (let index = 0; index < 12; index += 1) {
      await harness.service.ask({
        sessionKey: `agent:main:global-${index}`,
        question: `Question ${index}?`,
        connId: `conn-${index}`,
      });
    }
    await expect(
      harness.service.ask({
        sessionKey: "agent:main:global-overflow",
        question: "One too many globally?",
        connId: "conn-overflow",
      }),
    ).rejects.toMatchObject({
      reason: "rate-limited",
    } satisfies Partial<SessionCompanionAskError>);
    expect(harness.run).toHaveBeenCalledTimes(12);
    harness.service.dispose();
  });

  it("builds the seed once and advances observer note deltas across asks", async () => {
    vi.useFakeTimers();
    let notes = [{ sequence: 1, text: "first note" }];
    const harness = createHarness({
      snapshot: () => ({ agentId: "main", notes }),
    });
    await harness.service.ask({
      sessionKey: "agent:main:main",
      question: "First?",
      connId: "conn-1",
    });
    notes = [
      { sequence: 1, text: "first note" },
      { sequence: 2, text: "second note" },
      { sequence: 3, text: "third note" },
    ];
    await harness.service.ask({
      sessionKey: "agent:main:main",
      question: "Second?",
      connId: "conn-2",
    });

    expect(harness.readSeedMessages).toHaveBeenCalledOnce();
    const secondMessages = harness.run.mock.calls[1]?.[0].messages ?? [];
    expect(secondMessages.slice(0, 3).map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(JSON.parse(secondMessages.at(-1)?.content ?? "{}").observerNotes).toEqual([
      { sequence: 2, text: "second note" },
      { sequence: 3, text: "third note" },
    ]);
    harness.service.dispose();
  });

  it("caps replay by exchange count and UTF-8 bytes", () => {
    const exchanges = Array.from({ length: 30 }, (_, index) => ({
      question: `${index}:${"🦞".repeat(400)}`,
      answer: "🦀".repeat(1200),
      ts: index,
    }));
    trimSessionCompanionExchanges(exchanges);
    expect(exchanges.length).toBeLessThanOrEqual(24);
    expect(exchanges.at(-1)?.ts).toBe(29);
    expect(
      exchanges.reduce(
        (bytes, exchange) =>
          bytes +
          Buffer.byteLength(exchange.question, "utf8") +
          Buffer.byteLength(exchange.answer, "utf8"),
        0,
      ),
    ).toBeLessThanOrEqual(48 * 1024);
  });

  it("truncates answers without splitting a UTF-16 surrogate pair", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ run: async () => "🦞".repeat(601) });
    const result = await harness.service.ask({
      sessionKey: "agent:main:main",
      question: "Long answer?",
      connId: "conn-1",
    });
    expect(result.answer).toBe("🦞".repeat(600));
    harness.service.dispose();
  });

  it("sweeps idle threads after two hours", async () => {
    vi.useFakeTimers();
    let now = 0;
    const harness = createHarness({ now: () => now });
    await harness.service.ask({
      sessionKey: "agent:main:main",
      question: "Before idle?",
      connId: "conn-1",
    });
    now = 2 * 60 * 60_000;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.service.state("agent:main:main")).toEqual({ exchanges: [] });
    harness.service.dispose();
  });

  it("reset clears state and cancels an active ask", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const harness = createHarness({ run: async () => await pending.promise });
    const active = harness.service.ask({
      sessionKey: "agent:main:main",
      question: "Still there?",
      connId: "conn-1",
    });
    await vi.waitFor(() => expect(harness.run).toHaveBeenCalledOnce());
    harness.service.reset("agent:main:main");
    await expect(active).rejects.toMatchObject({
      reason: "unavailable",
    } satisfies Partial<SessionCompanionAskError>);
    expect(harness.service.state("agent:main:main")).toEqual({ exchanges: [] });
    harness.service.dispose();
  });

  it("clears a thread when the committed gateway reset path notifies", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await harness.service.ask({
      sessionKey: "agent:main:main",
      question: "Before reset?",
      connId: "conn-1",
    });
    expect(harness.service.state("agent:main:main").exchanges).toHaveLength(1);

    notifyGatewaySessionReset("agent:main:main");

    expect(harness.service.state("agent:main:main")).toEqual({ exchanges: [] });
    harness.service.dispose();
  });
});

describe("session companion tool scope", () => {
  it("pins session tools to the target session and read to its workspace", async () => {
    const cfg = buildSessionCompanionRunConfig({
      tools: { toolSearch: true, codeMode: true },
    });
    expect(SESSION_COMPANION_TOOLS).toEqual(["read", "sessions_history", "sessions_search"]);
    expect(cfg.tools?.fs?.workspaceOnly).toBe(true);
    expect(cfg.tools?.sessions?.visibility).toBe("self");
    expect(cfg.tools?.toolSearch).toMatchObject({ enabled: false });
    expect(cfg.tools?.codeMode).toMatchObject({ enabled: false });

    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:target",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy(cfg),
    });
    expect(guard.check("agent:main:target")).toMatchObject({ allowed: true });
    expect(guard.check("agent:main:different")).toMatchObject({
      allowed: false,
      status: "forbidden",
    });
  });
});
