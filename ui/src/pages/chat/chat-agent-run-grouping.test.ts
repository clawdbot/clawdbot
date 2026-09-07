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
    visibleContent: "text",
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

  it("keeps a restart-recovered tool-only run in one stable frame", () => {
    const runId = "run-recovered";
    const boundaryId = `send:${runId}`;
    const recoveryNotice = {
      kind: "notice" as const,
      key: "notice:restart-recovery",
      text: "Turn interrupted by a gateway restart.",
      timestamp: 1,
      startsTurn: true as const,
      boundaryId,
    };
    const first = group("tool", "recovered-tool-1", runId);
    const second = group("tool", "recovered-tool-2", runId);
    const historyActivity: ActivityRunRenderItem = {
      kind: "activity-run",
      key: "activity:recovered-tools",
      groups: [first, second],
    };

    const live = requireFrame(coalesceAgentRunFrames([recoveryNotice, first, second])[1]);
    const history = requireFrame(coalesceAgentRunFrames([recoveryNotice, historyActivity])[1]);

    expect(live.parts).toEqual([first, second]);
    expect(history.parts).toEqual([historyActivity]);
    expect(live.boundaryId).toBe(boundaryId);
    expect(history.key).toBe(live.key);
  });

  it("remounts a large live stream after steer without destabilizing ordinary frames", () => {
    const runId = "run-steered";
    const boundaryId = "send:steer-run";
    const working: StreamRunRenderItem = {
      kind: "stream-run",
      key: "stream-run:working",
      runId,
      boundaryId,
      parts: [{ kind: "reading-indicator", key: "working", startedAt: 1, runId, boundaryId }],
    };
    const streamed: StreamRunRenderItem = {
      kind: "stream-run",
      key: "stream-run:stream-after-steer",
      runId,
      boundaryId,
      parts: [
        {
          kind: "stream",
          key: "working:after:steer-run",
          text: "Large terminal response",
          startedAt: 2,
          isStreaming: true,
          runId,
          boundaryId,
        },
      ],
    };

    expect(
      requireFrame(coalesceAgentRunFrames([userBoundary("steer-run"), working])[1]).key,
    ).not.toBe(requireFrame(coalesceAgentRunFrames([userBoundary("steer-run"), streamed])[1]).key);
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

  it("does not compose across forwarded sessions_send input", () => {
    const boundary = group("assistant", "forwarded", "run-1", {
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
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

    expect(active.outcome).toEqual({ kind: "active" });
    expect(toolOnly.outcome).toEqual({ kind: "completed", actionOwner: null });
    expect(toolOnly.parts.at(-1)).toMatchObject({ role: "tool" });
  });

  it.each([
    {
      name: "tool-only completion",
      parts: [group("tool", "tool-only", "run-1")],
      outcome: { kind: "completed", actionOwner: null },
    },
    {
      name: "tool-use commentary",
      parts: [
        group("assistant", "commentary-tool", "run-1", {
          stopReason: "toolUse",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "tool_call", id: "call-1", name: "read", args: {} },
            { type: "tool_result", id: "call-1", name: "read", text: "done" },
          ],
        }),
      ],
      outcome: { kind: "completed", actionOwner: null },
    },
    {
      name: "persisted keyed commentary",
      parts: [
        group("assistant", "commentary-stop", "run-1", {
          stopReason: "stop",
          openclawStreamFallback: {
            replacementText: "I will inspect it.",
            source: "segment",
            itemId: "commentary-1",
          },
        }),
        group("tool", "commentary-tool", "run-1"),
      ],
      outcome: { kind: "completed", actionOwner: null },
    },
    {
      name: "Codex reasoning mirror",
      parts: [
        group("assistant", "reasoning", "run-1", {
          stopReason: "stop",
          __openclaw: { mirrorOrigin: "codex-app-server", runId: "run-1" },
        }),
        group("tool", "reasoning-tool", "run-1"),
      ],
      outcome: { kind: "completed", actionOwner: null },
    },
    {
      name: "attachment-only final followed by work",
      parts: [
        group("assistant", "final-document", "run-1", {
          phase: "final_answer",
          content: [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                url: "https://files.example.test/report.pdf",
                label: "report.pdf",
                mimeType: "application/pdf",
              },
            },
          ],
        }),
        group("tool", "trailing-tool", "run-1"),
      ],
      outcome: { kind: "completed", actionOwner: { key: "final-document" } },
    },
    {
      name: "image-only final",
      parts: [
        group("assistant", "final-image", "run-1", {
          stopReason: "stop",
          content: [{ type: "image", url: "https://files.example.test/banner.png" }],
        }),
      ],
      outcome: { kind: "completed", actionOwner: { key: "final-image" } },
    },
    {
      name: "omitted-image-only final",
      parts: [
        group("assistant", "final-omitted-image", "run-1", {
          stopReason: "stop",
          content: [{ type: "image", omitted: true, bytes: 12 * 1024 }],
        }),
      ],
      outcome: { kind: "completed", actionOwner: { key: "final-omitted-image" } },
    },
    {
      name: "empty final",
      parts: [group("assistant", "empty", "run-1", { stopReason: "stop", content: [] })],
      outcome: { kind: "completed", actionOwner: null },
    },
    {
      name: "reasoning-only final",
      parts: [
        group("assistant", "thinking", "run-1", {
          stopReason: "stop",
          content: [{ type: "thinking", thinking: "I am considering the request." }],
        }),
      ],
      outcome: { kind: "completed", actionOwner: null },
    },
    {
      name: "explicit final followed by work",
      parts: [
        group("assistant", "final", "run-1", {
          phase: "final_answer",
          content: "Finished.",
        }),
        group("tool", "trailing-tool", "run-1"),
      ],
      outcome: { kind: "completed", actionOwner: { key: "final" } },
    },
  ])("records $name without deriving completion from the last part", ({ parts, outcome }) => {
    const frame = requireFrame(coalesceAgentRunFrames([userBoundary(), ...parts])[1]);

    expect(frame).toMatchObject({ outcome });
  });

  it("marks preceding commentary failed when an error closes the run", () => {
    const error = group("assistant", "error", "run-1", { stopReason: "error" });
    const items = coalesceAgentRunFrames([
      userBoundary(),
      group("assistant", "commentary", "run-1", { phase: "commentary" }),
      error,
    ]);

    expect(requireFrame(items[1])).toMatchObject({
      outcome: { kind: "failed" },
      parts: [{ key: "group:commentary" }, { key: "group:error" }],
    });
  });

  it.each([
    { name: "placement abort", terminal: { stopReason: "stop", openclawAbort: { aborted: true } } },
    { name: "timeout", terminal: { stopReason: "timeout" } },
  ])("marks an interrupted partial failed for $name", ({ terminal }) => {
    const frame = requireFrame(
      coalesceAgentRunFrames([
        userBoundary(),
        group("assistant", "partial", "run-1", { content: "Partial answer", ...terminal }),
      ])[1],
    );

    expect(frame.outcome).toEqual({ kind: "failed" });
  });

  it("leaves active search projections uncomposed", () => {
    const input = [userBoundary(), group("assistant", "match", "run-1")];

    expect(coalesceAgentRunFrames(input, { searchActive: true })).toBe(input);
  });
});
