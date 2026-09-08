import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import { appendAttemptCacheTtlIfNeeded } from "./run/attempt-thread-helpers.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  getEmbeddedSessionPromptState,
  serializeCacheTtlToolResultProjections,
  type ToolResultPromptProjectionState,
} from "./session-prompt-state.js";
import {
  pruneExpiredCacheTtlToolResults,
  reconcileToolResultPromptProjectionState,
  resolveCacheTtlPruningSettings,
  restoreCacheTtlToolResultProjections,
  truncateOversizedToolResultsInMessages,
} from "./tool-result-truncation.js";

const NOW = 1_000_000;

function assistant(content: unknown = [{ type: "text", text: "assistant" }]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    timestamp: 1,
  } as AgentMessage;
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function tool(params: {
  id: string;
  text?: unknown;
  toolName?: string;
  image?: boolean;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.id,
    toolName: params.toolName ?? "read",
    content: [
      ...(params.image ? [{ type: "image", data: "AA==", mimeType: "image/png" }] : []),
      { type: "text", text: params.text ?? "result" },
    ],
    details: { source: params.id },
    isError: params.id === "error",
    timestamp: 42,
  } as AgentMessage;
}

function prunableHistory(oldTools: AgentMessage[], tail: AgentMessage[] = []): AgentMessage[] {
  return [
    user("first"),
    assistant(),
    ...oldTools,
    user("second"),
    assistant(),
    ...tail,
    user("third"),
    assistant(),
    user("fourth"),
    assistant(),
  ];
}

function settings(config: AgentContextPruningConfig = { mode: "cache-ttl" }) {
  const resolved = resolveCacheTtlPruningSettings(config);
  if (!resolved) {
    throw new Error("expected cache-TTL settings");
  }
  return resolved;
}

function project(
  messages: AgentMessage[],
  options: {
    config?: AgentContextPruningConfig;
    contextWindowTokens?: number;
    dropThinkingBlocksForEstimate?: boolean;
    lastCacheTouchAt?: number | null;
    now?: number;
    projectionState?: ToolResultPromptProjectionState;
    pruneNewRounds?: boolean;
    onPruned?: () => void;
  } = {},
): AgentMessage[] {
  return pruneExpiredCacheTtlToolResults({
    messages,
    settings: settings(options.config),
    contextWindowTokens: options.contextWindowTokens ?? 1_000,
    lastCacheTouchAt:
      options.lastCacheTouchAt === undefined ? NOW - 300_000 : options.lastCacheTouchAt,
    dropThinkingBlocksForEstimate: options.dropThinkingBlocksForEstimate ?? false,
    now: options.now ?? NOW,
    projectionState: options.projectionState ?? createToolResultPromptProjectionState(),
    pruneNewRounds: options.pruneNewRounds ?? true,
    onPruned: options.onPruned,
  });
}

function toolText(messages: AgentMessage[], id: string): string {
  const message = messages.find(
    (candidate) => candidate.role === "toolResult" && candidate.toolCallId === id,
  );
  if (!message || message.role !== "toolResult") {
    throw new Error(`missing tool result ${id}`);
  }
  return message.content
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

describe("cache-TTL tool-result projection", () => {
  it.each([
    { reset: "restart", maxChars: 4_000 },
    { reset: "restart", maxChars: 8_000 },
    { reset: "eviction", maxChars: 4_000 },
    { reset: "eviction", maxChars: 8_000 },
  ])(
    "preserves ordinary projected bytes after $reset with a $maxChars character cap",
    ({ reset, maxChars }) => {
      const sessionId = `ordinary-${reset}`;
      const sessionIds = [sessionId];
      try {
        const state = getEmbeddedSessionPromptState(sessionId).toolResults;
        const history: AgentMessage[] = [user("start")];
        let sent: AgentMessage[] = [];
        for (let batch = 0; batch < 3; batch++) {
          history.push(
            assistant(),
            tool({ id: `batch-${batch}`, text: `${batch}`.repeat(6_000), image: true }),
          );
          sent = truncateOversizedToolResultsInMessages(
            history,
            128_000,
            maxChars,
            8_000,
            state,
          ).messages;
        }
        expect(sent.filter((message) => message.role === "toolResult")).toHaveLength(3);
        expect(toolText(sent, "batch-0").includes("truncated")).toBe(maxChars === 4_000);
        expect(
          [0, 1, 2].reduce((sum, batch) => sum + toolText(sent, `batch-${batch}`).length, 0),
        ).toBeGreaterThan(8_000);
        const markerData = JSON.stringify(serializeCacheTtlToolResultProjections(state));
        const entries = [
          {
            type: "custom",
            customType: "openclaw.cache-ttl",
            data: JSON.parse(markerData),
          },
        ];
        if (reset === "restart") {
          clearEmbeddedSessionPromptStates([sessionId]);
        } else {
          for (let index = 0; index < 65; index++) {
            const otherId = `${sessionId}-${index}`;
            sessionIds.push(otherId);
            getEmbeddedSessionPromptState(otherId);
          }
        }
        const restored = getEmbeddedSessionPromptState(sessionId).toolResults;
        expect(restored).not.toBe(state);
        restoreCacheTtlToolResultProjections(restored, entries);
        expect(
          JSON.stringify(
            truncateOversizedToolResultsInMessages(history, 128_000, maxChars, 8_000, restored)
              .messages,
          ) === JSON.stringify(sent),
        ).toBe(true);
        const compacted = [user("summary"), ...history.slice(-2)];
        reconcileToolResultPromptProjectionState(compacted, restored);
        expect(restored.frozen.size).toBe(1);
        expect(restored.replacements.size).toBe(maxChars === 4_000 ? 1 : 0);
        const compactedSnapshot = serializeCacheTtlToolResultProjections(restored);
        expect(JSON.stringify(compactedSnapshot)).not.toContain("batch-0");
        const reopened = createToolResultPromptProjectionState();
        restoreCacheTtlToolResultProjections(reopened, [
          { ...entries[0], data: compactedSnapshot },
        ]);
        expect(
          truncateOversizedToolResultsInMessages(compacted, 128_000, maxChars, 8_000, reopened)
            .messages,
        ).toEqual([user("summary"), ...sent.slice(-2)]);
      } finally {
        clearEmbeddedSessionPromptStates(sessionIds);
      }
    },
  );

  it.each(["soft", "hard"] as const)(
    "replays %s pruning after TTL refresh and restart, until compaction/reset",
    (mode) => {
      const sessionId = `cache-ttl-${mode}`;
      clearEmbeddedSessionPromptStates([sessionId]);
      try {
        const messages = prunableHistory(
          Array.from({ length: mode === "hard" ? 18 : 1 }, (_, index) =>
            tool({ id: `tool-${index}`, text: `${index}:` + "x".repeat(6_000), image: true }),
          ),
        );
        const state = getEmbeddedSessionPromptState(sessionId).toolResults;
        truncateOversizedToolResultsInMessages(messages, 1_000, 5_500, 100_000, state);
        let pruningRounds = 0;
        const options = { projectionState: state, onPruned: () => pruningRounds++ };
        const first = project(messages, options);
        expect(toolText(first, "tool-0")).toContain(
          mode === "hard" ? "content cleared" : "Tool result trimmed",
        );
        const second = project(messages, { ...options, lastCacheTouchAt: NOW });
        expect(second).toEqual(first);
        expect(pruningRounds).toBe(1);
        const sent = truncateOversizedToolResultsInMessages(
          second,
          1_000,
          2_500,
          100_000,
          state,
        ).messages;
        expect(
          truncateOversizedToolResultsInMessages(messages, 1_000, 2_500, 100_000, state).messages,
        ).toEqual(sent);
        const entries: { type: string; customType: string; data: unknown }[] = [];
        const sessionManager = {
          getEntries: () => entries,
          appendCustomEntry: (customType: string, data: unknown) => {
            const serialized = JSON.stringify(data);
            entries.push({ type: "custom", customType, data: JSON.parse(serialized) });
          },
        };
        appendAttemptCacheTtlIfNeeded({
          sessionManager,
          config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          timedOutDuringCompaction: false,
          compactionOccurredThisAttempt: false,
          isCacheTtlEligibleProvider: () => true,
          toolResultPromptProjectionState: state,
          now: NOW,
        });
        expect(entries.at(-1)?.data).toMatchObject({
          timestamp: NOW,
          prunedToolResults: expect.arrayContaining([
            expect.objectContaining({ key: expect.stringContaining("tool-0"), mode }),
          ]),
        });
        // The marker carries keys only; pruned bytes never enter the transcript.
        expect(JSON.stringify(entries.at(-1)?.data)).not.toContain("x".repeat(20));
        clearEmbeddedSessionPromptStates([sessionId]);
        const restarted = getEmbeddedSessionPromptState(sessionId).toolResults;
        restoreCacheTtlToolResultProjections(restarted, entries);
        const restored = project(messages, {
          projectionState: restarted,
          lastCacheTouchAt: NOW,
          onPruned: () => pruningRounds++,
        });
        expect(restored).toEqual(first);
        expect(pruningRounds).toBe(1);
        expect(
          truncateOversizedToolResultsInMessages(restored, 1_000, 2_500, 100_000, restarted)
            .messages,
        ).toEqual(sent);
        const compacted = [user("summary"), ...messages.slice(-4)];
        reconcileToolResultPromptProjectionState(compacted, restarted);
        expect(restarted.replacements.size).toBe(0);
        restoreCacheTtlToolResultProjections(restarted, entries);
        project(compacted, { projectionState: restarted, lastCacheTouchAt: NOW });
        expect(restarted.replacements.size).toBe(0);
        expect(restarted.restoredCacheTtl.size).toBe(0);
        clearEmbeddedSessionPromptStates([sessionId]);
        expect(getEmbeddedSessionPromptState(sessionId).toolResults.replacements.size).toBe(0);
      } finally {
        clearEmbeddedSessionPromptStates([sessionId]);
      }
    },
  );

  it("keeps ambiguous tool identities stable when pruning composes with oversized projection", () => {
    const messages = prunableHistory([
      tool({ id: "duplicate", text: "a".repeat(5_000) }),
      tool({ id: "duplicate", text: "b".repeat(5_000) }),
    ]);
    const state = createToolResultPromptProjectionState();
    const first = project(messages, { projectionState: state });
    const sent = truncateOversizedToolResultsInMessages(
      first,
      1_000,
      2_000,
      100_000,
      state,
    ).messages;
    const replay = project(messages, { projectionState: state, lastCacheTouchAt: NOW });
    expect(
      truncateOversizedToolResultsInMessages(replay, 1_000, 2_000, 100_000, state).messages,
    ).toEqual(sent);
    expect(state.replacements.size).toBe(2);
  });

  it("keeps pruned bytes when a later result makes a tool identity ambiguous", () => {
    const messages = prunableHistory([tool({ id: "reused", text: "a".repeat(5_000) })]);
    const state = createToolResultPromptProjectionState();
    const sent = project(messages, { projectionState: state });
    const entries = [
      {
        type: "custom",
        customType: "openclaw.cache-ttl",
        data: serializeCacheTtlToolResultProjections(state),
      },
    ];
    const expanded = [...messages, tool({ id: "reused", text: "b".repeat(5_000) })];
    const continued = project(expanded, {
      projectionState: state,
      lastCacheTouchAt: NOW,
    });
    expect(JSON.stringify(continued.slice(0, messages.length))).toBe(JSON.stringify(sent));
    const restarted = createToolResultPromptProjectionState();
    restoreCacheTtlToolResultProjections(restarted, entries);
    const restored = project(expanded, { projectionState: restarted, lastCacheTouchAt: NOW });
    expect(JSON.stringify(restored)).toBe(JSON.stringify(continued));
  });

  it("replays restored projections through the history transform when pruning is off", () => {
    const state = createToolResultPromptProjectionState();
    const history = prunableHistory(
      Array.from({ length: 18 }, (_, index) =>
        tool({ id: `tool-${index}`, text: `${index}:` + "x".repeat(6_000) }),
      ),
    );
    const first = project(history, { projectionState: state });
    const sent = truncateOversizedToolResultsInMessages(
      first,
      1_000,
      2_500,
      100_000,
      state,
    ).messages;
    expect(toolText(sent, "tool-0")).toContain("content cleared");
    const entries = [
      {
        type: "custom",
        customType: "openclaw.cache-ttl",
        data: structuredClone(serializeCacheTtlToolResultProjections(state)),
      },
    ];
    expect(JSON.stringify(entries[0]?.data)).not.toContain("x".repeat(20));
    // Pruning is off after the restart: no prune pass runs, only the per-request history transform.
    const restarted = createToolResultPromptProjectionState();
    restoreCacheTtlToolResultProjections(restarted, entries);
    expect(
      truncateOversizedToolResultsInMessages(history, 1_000, 2_500, 100_000, restarted).messages,
    ).toEqual(sent);
    expect(restarted.restoredCacheTtl.size).toBe(0);
  });

  it("preserves a restored soft projection with non-array content on later replay", () => {
    const state = createToolResultPromptProjectionState();
    restoreCacheTtlToolResultProjections(state, [
      {
        type: "custom",
        customType: "openclaw.cache-ttl",
        data: { prunedToolResults: [{ key: "tool:old:42", mode: "soft" }] },
      },
    ]);
    // SAFETY: older malformed plugin content is handled by the existing replay guard.
    const original = { ...tool({ id: "old" }), content: null } as unknown as AgentMessage;
    truncateOversizedToolResultsInMessages([original], 128_000, 5_000, 20_000, state);
    const result = truncateOversizedToolResultsInMessages(
      [{ ...original, content: [] } as AgentMessage],
      128_000,
      5_000,
      20_000,
      state,
    );
    expect(result.messages[0]).toMatchObject({ role: "toolResult", content: null });
  });

  it("replays existing and restored projections when another owner prunes new rounds", () => {
    const state = createToolResultPromptProjectionState();
    const history = prunableHistory([tool({ id: "old", text: "a".repeat(5_000) })]);
    const first = project(history, { projectionState: state });
    const entries = [
      {
        type: "custom",
        customType: "openclaw.cache-ttl",
        data: serializeCacheTtlToolResultProjections(state),
      },
    ];
    const expanded = [
      ...history,
      assistant(),
      tool({ id: "new", text: "b".repeat(5_000) }),
      assistant(),
      assistant(),
      assistant(),
    ];
    // Live state: the earlier projection replays, the new result is left to the server.
    const live = project(expanded, { projectionState: state, pruneNewRounds: false });
    expect(toolText(live, "old")).toBe(toolText(first, "old"));
    expect(toolText(live, "new")).toBe("b".repeat(5_000));
    // Restarted state: marker keys re-derive the same bytes without opening a new round.
    const restarted = createToolResultPromptProjectionState();
    restoreCacheTtlToolResultProjections(restarted, entries);
    const restored = project(expanded, { projectionState: restarted, pruneNewRounds: false });
    expect(toolText(restored, "old")).toBe(toolText(first, "old"));
    expect(toolText(restored, "new")).toBe("b".repeat(5_000));
  });

  it("gates new pruning rounds without undoing earlier projections", () => {
    const state = createToolResultPromptProjectionState();
    const history = prunableHistory([tool({ id: "old", text: "a".repeat(5_000) })]);
    const first = project(history, { projectionState: state });
    const expanded = [
      ...history,
      assistant(),
      tool({ id: "new", text: "b".repeat(5_000) }),
      assistant(),
      assistant(),
      assistant(),
    ];
    const retained = project(expanded, { projectionState: state, lastCacheTouchAt: NOW });
    expect(toolText(retained, "old")).toBe(toolText(first, "old"));
    expect(toolText(retained, "new")).toBe("b".repeat(5_000));
    const expired = project(expanded, {
      projectionState: state,
      lastCacheTouchAt: NOW,
      now: NOW + 300_000,
    });
    expect(toolText(expired, "old")).toBe(toolText(first, "old"));
    expect(toolText(expired, "new")).toContain("[Tool result trimmed:");
  });

  it("normalizes TTL, hard-clear, and deny-first tool matching once", () => {
    expect(resolveCacheTtlPruningSettings(undefined)).toBeUndefined();
    expect(resolveCacheTtlPruningSettings({ mode: "off" })).toBeUndefined();
    expect(settings({ mode: "cache-ttl", ttl: "invalid" }).ttlMs).toBe(300_000);
    expect(settings({ mode: "cache-ttl", ttl: "1h" }).ttlMs).toBe(3_600_000);

    const configured = settings({
      mode: "cache-ttl",
      tools: { allow: ["READ*"], deny: ["read_secret"] },
      hardClear: { enabled: false, placeholder: "  custom  " },
    });
    expect(configured.hardClear).toBe(false);
    expect(configured.placeholder).toBe("custom");
    expect(configured.isToolPrunable("read_file")).toBe(true);
    expect(configured.isToolPrunable("READ_SECRET")).toBe(false);
    expect(configured.isToolPrunable("exec")).toBe(false);
    expect(settings().isToolPrunable("anything")).toBe(true);
  });

  it("requires an expired positive TTL and treats equality as expired", () => {
    const messages = prunableHistory([tool({ id: "old", text: "x".repeat(5_000) })]);
    expect(project(messages, { lastCacheTouchAt: null })).toBe(messages);
    expect(project(messages, { lastCacheTouchAt: NOW - 299_999 })).toBe(messages);
    expect(project(messages, { config: { mode: "cache-ttl", ttl: "0m" } })).toBe(messages);
    expect(project(messages, { lastCacheTouchAt: NOW - 300_000 })).not.toBe(messages);
  });

  it("protects bootstrap history and the last three assistant turns", () => {
    const bootstrap = tool({ id: "bootstrap", text: "b".repeat(5_000) });
    const old = tool({ id: "old", text: "o".repeat(5_000) });
    const recent = tool({ id: "recent", text: "r".repeat(5_000) });
    const messages = [assistant(), bootstrap, ...prunableHistory([old], [recent])];
    const result = project(messages);

    expect(toolText(result, "bootstrap")).toBe("b".repeat(5_000));
    expect(toolText(result, "old")).toContain("[Tool result trimmed:");
    expect(toolText(result, "recent")).toBe("r".repeat(5_000));
  });

  it("soft-trims joined blocks with UTF-16-safe exact head and tail", () => {
    const text = `${"h".repeat(1_499)}😀${"m".repeat(1_001)}😀${"t".repeat(1_499)}`;
    const result = project(prunableHistory([tool({ id: "utf16", text })]));
    expect(toolText(result, "utf16")).toBe(
      `${"h".repeat(1_499)}\n...\n${"t".repeat(1_499)}\n\n` +
        "[Tool result trimmed: kept first 1500 chars and last 1500 chars of 4003 chars.]",
    );
  });

  it("replaces images and serializes malformed text before hard eligibility", () => {
    const malformed = { payload: "m".repeat(5_000) };
    const result = project(prunableHistory([tool({ id: "image", text: malformed, image: true })]), {
      contextWindowTokens: 4_000,
    });
    const text = toolText(result, "image");
    expect(text).toContain("[image removed during context pruning]");
    expect(text).toContain("[Tool result trimmed:");
  });

  it("uses CJK weighting when deciding whether to enter the soft pass", () => {
    const messages = prunableHistory([tool({ id: "cjk", text: "x".repeat(4_001) })]);
    messages[0] = user("𠀀".repeat(50));
    const result = project(messages, { contextWindowTokens: 3_500 });
    expect(toolText(result, "cjk")).toContain("[Tool result trimmed:");
  });

  it("drops old thinking only for pressure estimation", () => {
    const messages = prunableHistory([tool({ id: "thinking", text: "x".repeat(4_001) })]);
    messages[1] = assistant([
      { type: "thinking", thinking: "hidden", thinkingSignature: "s".repeat(40_000) },
      { type: "text", text: { malformed: "m".repeat(40_000) } },
      { type: "text", text: "done" },
    ]);
    expect(toolText(project(messages, { contextWindowTokens: 20_000 }), "thinking")).toContain(
      "[Tool result trimmed:",
    );
    expect(
      project(messages, {
        contextWindowTokens: 20_000,
        dropThinkingBlocksForEstimate: true,
      }),
    ).toBe(messages);
  });

  it("hard-clears oldest eligible results with a custom placeholder and preserves metadata", () => {
    const oldTools = Array.from({ length: 18 }, (_, index) =>
      tool({ id: `tool-${index}`, text: String(index).repeat(5_000) }),
    );
    const result = project(prunableHistory(oldTools), {
      config: {
        mode: "cache-ttl",
        hardClear: { placeholder: "[cleared by test]" },
      },
    });
    const first = result.find(
      (message) => message.role === "toolResult" && message.toolCallId === "tool-0",
    );
    expect(first).toMatchObject({
      toolCallId: "tool-0",
      toolName: "read",
      details: { source: "tool-0" },
      isError: false,
      timestamp: 42,
    });
    expect(toolText(result, "tool-0")).toBe("[cleared by test]");
  });
});
