import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import type {
  ActivityRunRenderItem,
  StreamRunRenderItem,
  WorkGroupRenderItem,
} from "./chat-thread-grouping.ts";

function group(
  role: "assistant" | "tool" | "user",
  key: string,
  runId: string | undefined,
  overrides: Record<string, unknown> = {},
): MessageGroup {
  return {
    kind: "group",
    key: `group:${key}`,
    role,
    messages: [
      {
        key,
        message: {
          role: role === "tool" ? "toolResult" : role,
          content: key,
          timestamp: 1,
          ...overrides,
        },
      },
    ],
    timestamp: 1,
    isStreaming: false,
    ...(runId ? { runId } : {}),
  };
}

function userBoundary(sendId = "send-1"): MessageGroup {
  return group("user", `user:${sendId}`, undefined, {
    __openclaw: { id: `user:${sendId}`, idempotencyKey: `${sendId}:user` },
  });
}

type AgentRunFrameRenderItem = Extract<
  ReturnType<typeof coalesceAgentRunFrames>[number],
  { kind: "agent-run-frame" }
>;

function requireFrame(
  value: ReturnType<typeof coalesceAgentRunFrames>[number] | undefined,
): AgentRunFrameRenderItem {
  if (value?.kind !== "agent-run-frame") {
    throw new Error("expected an agent run frame");
  }
  return value;
}

describe("coalesceAgentRunFrames", () => {
  it("keeps one lifecycle-stable frame key while preserving semantic part keys", () => {
    const runId = "run-1";
    const stream: StreamRunRenderItem = {
      kind: "stream-run",
      key: "stream-run:run-1",
      runId,
      boundaryId: "send:send-1",
      parts: [
        {
          kind: "stream",
          key: "stream:run-1",
          text: "Working on it.",
          startedAt: 1,
          isStreaming: true,
          runId,
          boundaryId: "send:send-1",
        },
      ],
    };
    const tool = group("tool", "tool:run-1", runId);
    const activity: ActivityRunRenderItem = {
      kind: "activity-run",
      key: "activity:tool:run-1",
      groups: [tool],
    };
    const final = group("assistant", "assistant:run-1", runId);
    const work: WorkGroupRenderItem = {
      kind: "work-group",
      key: "work:assistant:run-1",
      groups: [tool],
      durationMs: 1,
    };
    const boundary = userBoundary();

    const streaming = requireFrame(coalesceAgentRunFrames([boundary, stream])[1]);
    const tooling = requireFrame(coalesceAgentRunFrames([boundary, stream, activity])[1]);
    const history = requireFrame(coalesceAgentRunFrames([boundary, work, final])[1]);

    expect(streaming.key).toBe(tooling.key);
    expect(tooling.key).toBe(history.key);
    expect(history.key).toContain(JSON.stringify([runId, "send:send-1"]));
    expect(tooling.parts.map((part) => part.key)).toEqual([stream.key, activity.key]);
    expect(history.parts.map((part) => part.key)).toEqual([work.key, final.key]);
  });

  it("keeps the live send frame identity when a hidden boundary materializes in history", () => {
    const runId = "run-heartbeat-handoff";
    const stream: StreamRunRenderItem = {
      kind: "stream-run",
      key: "stream-run:heartbeat-handoff",
      runId,
      boundaryId: `send:${runId}`,
      parts: [
        {
          kind: "reading-indicator",
          key: "reading:heartbeat-handoff",
          startedAt: 1,
          runId,
          boundaryId: `send:${runId}`,
        },
      ],
    };
    const live = requireFrame(coalesceAgentRunFrames([userBoundary(runId), stream])[1]);
    const persistedBoundary = group("assistant", "persisted-after-heartbeat", runId, {
      api: "cli",
      idempotencyKey: `cli-assistant:${runId}`,
      __openclaw: {
        id: "persisted-after-heartbeat",
        turnBoundary: true,
      },
    });
    const history = requireFrame(coalesceAgentRunFrames([persistedBoundary])[0]);

    expect(history.boundaryId).toBe(`send:${runId}`);
    expect(history.key).toBe(live.key);
  });

  it("keeps different and missing run identities outside the same frame", () => {
    const first = group("assistant", "first", "run-1");
    const second = group("assistant", "second", "run-2");
    const unowned = group("assistant", "unowned", undefined);
    const items = coalesceAgentRunFrames([userBoundary(), first, second, unowned]);

    expect(items.map((item) => item.kind)).toEqual([
      "group",
      "agent-run-frame",
      "agent-run-frame",
      "group",
    ]);
    expect(requireFrame(items[1]).runId).toBe("run-1");
    expect(requireFrame(items[2]).runId).toBe("run-2");
  });

  it.each([
    {
      name: "forwarded sessions_send input",
      boundary: group("assistant", "forwarded", "run-1", {
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
    },
    {
      name: "error",
      boundary: group("assistant", "error", "run-1", { stopReason: "error" }),
    },
  ])("does not compose across $name", ({ boundary }) => {
    const items = coalesceAgentRunFrames([
      userBoundary(),
      group("assistant", "before", "run-1"),
      boundary,
      group("assistant", "after", "run-1"),
    ]);

    expect(items.filter((item) => item.kind === "agent-run-frame")).toHaveLength(1);
    expect(items).toContain(boundary);
    expect(items.at(-1)).toMatchObject({ kind: "group", key: "group:after" });
  });

  it("starts a new frame at an authoritative projected turn boundary", () => {
    const projected = group("assistant", "steer-output", "run-1", {
      __openclaw: { id: "steer-entry", turnBoundary: true },
    });
    const items = coalesceAgentRunFrames([
      userBoundary(),
      group("assistant", "before", "run-1"),
      projected,
    ]);
    const frames = items.filter(
      (item): item is AgentRunFrameRenderItem => item.kind === "agent-run-frame",
    );

    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.boundaryId)).toEqual(["send:send-1", "entry:steer-entry"]);
  });

  it("treats notices and dividers as hard boundaries", () => {
    const notice = { kind: "notice" as const, key: "notice", text: "Notice", timestamp: 2 };
    const divider = { kind: "divider" as const, key: "divider", label: "Reset", timestamp: 3 };
    const items = coalesceAgentRunFrames([
      userBoundary(),
      group("assistant", "before", "run-1"),
      notice,
      group("assistant", "between", "run-1"),
      divider,
      group("assistant", "after", "run-1"),
    ]);

    expect(items.filter((item) => item.kind === "agent-run-frame")).toHaveLength(1);
    expect(items).toContain(notice);
    expect(items).toContain(divider);
  });

  it("gives a restored run segment a unique key after a hard boundary", () => {
    const runId = "run-1";
    const notice = { kind: "notice" as const, key: "notice", text: "Notice", timestamp: 2 };
    const restoredStream: StreamRunRenderItem = {
      kind: "stream-run",
      key: "stream-run:restored",
      runId,
      boundaryId: "send:send-1",
      parts: [
        {
          kind: "reading-indicator",
          key: "reading:restored",
          startedAt: 3,
          runId,
          boundaryId: "send:send-1",
        },
      ],
    };
    const items = coalesceAgentRunFrames([
      userBoundary(),
      group("assistant", "before", runId),
      notice,
      restoredStream,
    ]);
    const frames = items.filter(
      (item): item is AgentRunFrameRenderItem => item.kind === "agent-run-frame",
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]?.key).not.toBe(frames[1]?.key);
    expect(frames[1]?.key).toContain("notice");
  });

  it("marks active frames active and tool-only terminal frames terminal", () => {
    const runId = "run-1";
    const activeStream: StreamRunRenderItem = {
      kind: "stream-run",
      key: "stream-run:active",
      runId,
      boundaryId: "send:send-1",
      parts: [
        {
          kind: "reading-indicator",
          key: "reading",
          startedAt: 1,
          runId,
          boundaryId: "send:send-1",
        },
      ],
    };
    const active = requireFrame(coalesceAgentRunFrames([userBoundary(), activeStream])[1]);
    const toolOnly = requireFrame(
      coalesceAgentRunFrames([userBoundary(), group("tool", "tool-only", runId)])[1],
    );

    expect(active.state).toBe("active");
    expect(toolOnly.state).toBe("terminal");
    expect(toolOnly.parts.at(-1)).toMatchObject({ role: "tool" });
  });

  it("leaves active search projections uncomposed", () => {
    const input = [userBoundary(), group("assistant", "match", "run-1")];

    expect(coalesceAgentRunFrames(input, { searchActive: true })).toBe(input);
  });
});
