import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectorAccumulator } from "./event-projector.js";
import {
  buildMirrorMessages,
  idempotencyKeyFor,
  mirrorClaudeAppServerTranscript,
} from "./transcript-mirror.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

type MirrorTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

async function createMirrorTarget(sessionId = "session-1"): Promise<MirrorTarget> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-mirror-"));
  tempDirs.push(root);
  const agentId = "main";
  const sessionKey = `agent:${agentId}:${sessionId}`;
  const storePath = path.join(root, "openclaw-agent.sqlite");
  await upsertSessionEntry({
    agentId,
    sessionKey,
    storePath,
    entry: {
      sessionFile: `sqlite:${agentId}:${sessionId}:${storePath}`,
      sessionId,
      updatedAt: 1,
    },
  });
  return { agentId, sessionId, sessionKey, storePath };
}

async function readMirroredMessages(
  target: MirrorTarget,
): Promise<Array<{ message?: { idempotencyKey?: string; role?: string } }>> {
  const events = await readSessionTranscriptEvents(target);
  return events
    .map((event) => (event && typeof event === "object" ? event : undefined))
    .filter((event): event is { message: { idempotencyKey?: string; role?: string } } =>
      Boolean(event && typeof (event as { message?: unknown }).message === "object"),
    );
}

function acc(overrides: Partial<ProjectorAccumulator> = {}): ProjectorAccumulator {
  return {
    assistantTexts: [],
    toolMetas: [],
    reasoning: "",
    itemCount: 0,
    toolCalls: new Map(),
    ...overrides,
  };
}

describe("idempotencyKeyFor", () => {
  it("produces the documented threadId/turnId/role/index shape", () => {
    expect(
      idempotencyKeyFor({ threadId: "thr_a", turnId: "turn_b", role: "assistant", index: 0 }),
    ).toBe("claude/thr_a/turn_b/assistant/0");
  });

  it("distinguishes tool result keys by index", () => {
    const k1 = idempotencyKeyFor({
      threadId: "thr",
      turnId: "t",
      role: "toolResult",
      index: 0,
    });
    const k2 = idempotencyKeyFor({
      threadId: "thr",
      turnId: "t",
      role: "toolResult",
      index: 1,
    });
    expect(k1).not.toBe(k2);
  });

  it("distinguishes across threads + turns", () => {
    expect(
      idempotencyKeyFor({ threadId: "thr_a", turnId: "t", role: "assistant", index: 0 }),
    ).not.toBe(idempotencyKeyFor({ threadId: "thr_b", turnId: "t", role: "assistant", index: 0 }));
    expect(
      idempotencyKeyFor({ threadId: "thr", turnId: "t1", role: "assistant", index: 0 }),
    ).not.toBe(idempotencyKeyFor({ threadId: "thr", turnId: "t2", role: "assistant", index: 0 }));
  });
});

describe("buildMirrorMessages", () => {
  it("returns an empty list when accumulator carries nothing", () => {
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc(),
    });
    expect(msgs).toEqual([]);
  });

  it("emits a single assistant message when text is present", () => {
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["hello world"], itemCount: 1 }),
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant");
    expect((msgs[0] as { content: string }).content).toBe("hello world");
  });

  it("mirrors reasoning as a leading thinking block; text-only turns keep string content", () => {
    const withReasoning = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["the answer"], reasoning: "chain of thought" }),
    });
    const content = (
      withReasoning[0] as unknown as {
        content: Array<{ type: string; thinking?: string; text?: string }>;
      }
    ).content;
    expect(content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(content[0]?.thinking).toBe("chain of thought");
    expect(content[1]?.text).toBe("the answer");

    const textOnly = buildMirrorMessages({
      threadId: "thr",
      turnId: "t2",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["plain"], reasoning: "  " }),
    });
    // Stable bytes for turns without reasoning: content stays a plain string.
    expect((textOnly[0] as { content: string }).content).toBe("plain");
  });

  it("tags lifecycleOutcome on the assistant message meta", () => {
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "resumed",
      acc: acc({ assistantTexts: ["x"] }),
    });
    const meta = (msgs[0] as unknown as { meta: { lifecycleOutcome: string } }).meta;
    expect(meta.lifecycleOutcome).toBe("resumed");
  });

  it("emits tool results before the assistant message", () => {
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", {
      name: "Read",
      result: "file contents",
      isError: false,
      startedAt: 1000,
      isDynamic: false,
    });
    toolCalls.set("call_2", {
      name: "vestige_search",
      result: [{ type: "inputText", text: "hits" }],
      isError: false,
      startedAt: 2000,
      isDynamic: true,
    });
    const msgs = buildMirrorMessages({
      threadId: "thr_a",
      turnId: "turn_b",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls, assistantTexts: ["done"] }),
    });
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.role).toBe("toolResult");
    expect(msgs[1]?.role).toBe("toolResult");
    expect(msgs[2]?.role).toBe("assistant");
  });

  it("attaches stable idempotency keys to every message", () => {
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", { name: "Read", result: "x", isDynamic: false });
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls, assistantTexts: ["y"] }),
    });
    expect((msgs[0] as unknown as { idempotencyKey: string }).idempotencyKey).toBe(
      "claude/thr/t/toolResult/0",
    );
    expect((msgs[1] as unknown as { idempotencyKey: string }).idempotencyKey).toBe(
      "claude/thr/t/assistant/0",
    );
  });

  it("stringifies non-string tool results", () => {
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", {
      name: "vestige_search",
      result: { hits: [{ id: 1 }, { id: 2 }] },
      isDynamic: true,
    });
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls }),
    });
    expect((msgs[0] as { content: string }).content).toBe('{"hits":[{"id":1},{"id":2}]}');
  });

  it("flags errored tool results in meta", () => {
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", {
      name: "Bash",
      result: "exit 1",
      isError: true,
      isDynamic: false,
    });
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls }),
    });
    const meta = (msgs[0] as unknown as { meta: { isError: boolean } }).meta;
    expect(meta.isError).toBe(true);
  });
});

describe("mirrorClaudeAppServerTranscript", () => {
  it("appends one entry per message on a fresh session", async () => {
    const target = await createMirrorTarget();
    await mirrorClaudeAppServerTranscript({
      ...target,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["hello"] }),
    });
    const lines = await readMirroredMessages(target);
    expect(lines).toHaveLength(1);
  });

  it("is a no-op when the accumulator carries nothing to mirror", async () => {
    const target = await createMirrorTarget();
    await mirrorClaudeAppServerTranscript({
      ...target,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc(),
    });
    expect(await readMirroredMessages(target)).toHaveLength(0);
  });

  it("skips messages whose idempotencyKey already exists in the transcript (replay-safe)", async () => {
    const target = await createMirrorTarget();
    // First mirror writes the assistant entry once.
    await mirrorClaudeAppServerTranscript({
      ...target,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["first"] }),
    });
    const afterFirst = await readMirroredMessages(target);
    expect(afterFirst).toHaveLength(1);

    // Replay (e.g. crash recovery, retry) with the same threadId/turnId must
    // not produce a second entry; the idempotency key is identical.
    await mirrorClaudeAppServerTranscript({
      ...target,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["first"] }),
    });
    const afterReplay = await readMirroredMessages(target);
    expect(afterReplay).toHaveLength(1);
  });

  it("appends only the new entries when some keys already exist (partial overlap)", async () => {
    const target = await createMirrorTarget();
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", { name: "Read", result: "x", isDynamic: false });

    // Round 1: only the toolResult is in the accumulator.
    await mirrorClaudeAppServerTranscript({
      ...target,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls }),
    });
    expect(await readMirroredMessages(target)).toHaveLength(1);

    // Round 2: the same toolResult is still in the accumulator, but now the
    // assistant text has appeared too. The toolResult must dedupe; the
    // assistant text must append.
    await mirrorClaudeAppServerTranscript({
      ...target,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls, assistantTexts: ["done"] }),
    });
    const final = await readMirroredMessages(target);
    expect(final).toHaveLength(2);
    const keys = final
      .map((r) => r.message?.idempotencyKey)
      .filter((k): k is string => typeof k === "string");
    expect(keys).toEqual([
      idempotencyKeyFor({ threadId: "thr", turnId: "turn_1", role: "toolResult", index: 0 }),
      idempotencyKeyFor({ threadId: "thr", turnId: "turn_1", role: "assistant", index: 0 }),
    ]);
  });
});
