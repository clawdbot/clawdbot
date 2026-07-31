import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionUpstreamProbe } from "openclaw/plugin-sdk/session-catalog";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { checkClaudeUpstreamActivity, linkContinued } from "./session-upstream-activity.js";

const tempDirs: string[] = [];
const CLAUDE_UPSTREAM_SCAN_BYTES = 1024 * 1024;

async function checkActivity(probe: SessionUpstreamProbe) {
  return (await checkClaudeUpstreamActivity([probe]))[0];
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function row(params: {
  type: "user" | "assistant";
  content: unknown;
  timestamp: string;
  extra?: Record<string, unknown>;
}) {
  return JSON.stringify({
    type: params.type,
    timestamp: params.timestamp,
    message: { role: params.type, content: params.content },
    ...params.extra,
  });
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Claude upstream activity", () => {
  it("counts only external user rows after the byte marker", async () => {
    const dir = await makeTempDir("openclaw-claude-upstream-");
    const filePath = path.join(dir, "thread-1.jsonl");
    const baseline = `${row({
      type: "user",
      content: "already imported",
      timestamp: "2026-07-13T10:00:00.000Z",
    })}\n`;
    await fs.writeFile(filePath, baseline);
    await fs.appendFile(
      filePath,
      [
        row({
          type: "assistant",
          content: "reply",
          timestamp: "2026-07-13T10:01:00.000Z",
        }),
        row({
          type: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
          timestamp: "2026-07-13T10:02:00.000Z",
        }),
        row({
          type: "user",
          content: "[Inter-session message] synthetic",
          timestamp: "2026-07-13T10:03:00.000Z",
        }),
        row({
          type: "user",
          content:
            "Continue this conversation using the OpenClaw transcript below as prior session history.\nTreat it as authoritative context for this fresh CLI session.\n\n<conversation_history>\nold\n</conversation_history>\n\n<next_user_message>\nnew\n</next_user_message>",
          timestamp: "2026-07-13T10:04:00.000Z",
        }),
        row({
          type: "user",
          content: "real upstream prompt",
          timestamp: "2026-07-13T10:05:00.000Z",
        }),
        "",
      ].join("\n"),
    );
    const probe: SessionUpstreamProbe = {
      sessionKey: "agent:main:adopted:claude",
      agentId: "main",
      threadId: "thread-1",
      hostId: "gateway:local",
      upstreamKind: "claude-cli",
      upstreamRef: { filePath },
      marker: { size: Buffer.byteLength(baseline) },
      ownRecentUserTexts: [],
    };

    const activity = await checkActivity(probe);

    expect(activity).toEqual({
      kind: "activity",
      sessionKey: probe.sessionKey,
      occurredAt: Date.parse("2026-07-13T10:05:00.000Z"),
      humanTurns: 1,
      nextMarker: { offset: (await fs.stat(filePath)).size },
      dedupeId: String((await fs.stat(filePath)).size),
    });
  });

  it("stats without reading when the file did not grow", async () => {
    const dir = await makeTempDir("openclaw-claude-upstream-static-");
    const filePath = path.join(dir, "thread-2.jsonl");
    await fs.writeFile(filePath, "{}\n");
    await expect(
      checkActivity({
        sessionKey: "agent:main:adopted:claude-static",
        agentId: "main",
        threadId: "thread-2",
        hostId: "gateway:local",
        upstreamKind: "claude-cli",
        upstreamRef: { filePath },
        marker: { size: 3 },
        ownRecentUserTexts: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("filters OpenClaw-authored rows by normalized transcript text", async () => {
    const dir = await makeTempDir("openclaw-claude-upstream-provenance-");
    const filePath = path.join(dir, "thread-provenance.jsonl");
    await fs.writeFile(
      filePath,
      `${row({
        type: "user",
        content: " same   prompt ",
        timestamp: "2026-07-13T10:05:30.000Z",
      })}\n`,
    );

    await expect(
      checkActivity({
        sessionKey: "agent:main:adopted:claude-provenance",
        agentId: "main",
        threadId: "thread-provenance",
        hostId: "gateway:local",
        upstreamKind: "claude-cli",
        upstreamRef: { filePath },
        marker: { offset: 0 },
        ownRecentUserTexts: ["same prompt"],
      }),
    ).resolves.toEqual({
      kind: "activity",
      sessionKey: "agent:main:adopted:claude-provenance",
      humanTurns: 0,
      nextMarker: { offset: (await fs.stat(filePath)).size },
    });
  });

  it("returns missing for an absent local transcript", async () => {
    const filePath = path.join(
      await makeTempDir("openclaw-claude-upstream-missing-"),
      "gone.jsonl",
    );

    await expect(
      checkActivity({
        sessionKey: "agent:main:adopted:claude-missing",
        agentId: "main",
        threadId: "thread-missing",
        hostId: "gateway:local",
        upstreamKind: "claude-cli",
        upstreamRef: { filePath },
        marker: { offset: 3 },
        ownRecentUserTexts: [],
      }),
    ).resolves.toEqual({
      kind: "missing",
      sessionKey: "agent:main:adopted:claude-missing",
    });
  });

  it("swallows non-missing local transcript errors", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "open").mockRejectedValueOnce(error);

    await expect(
      checkActivity({
        sessionKey: "agent:main:adopted:claude-permission",
        agentId: "main",
        threadId: "thread-permission",
        hostId: "gateway:local",
        upstreamKind: "claude-cli",
        upstreamRef: { filePath: "/unreadable/thread.jsonl" },
        marker: { offset: 3 },
        ownRecentUserTexts: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("isolates a missing transcript from healthy probes", async () => {
    const dir = await makeTempDir("openclaw-claude-upstream-batch-");
    const filePath = path.join(dir, "thread-good.jsonl");
    await fs.writeFile(
      filePath,
      `${row({
        type: "user",
        content: "new prompt",
        timestamp: "2026-07-13T10:06:00.000Z",
      })}\n`,
    );
    const baseProbe: SessionUpstreamProbe = {
      sessionKey: "healthy",
      agentId: "main",
      threadId: "thread-good",
      hostId: "gateway:local",
      upstreamKind: "claude-cli",
      upstreamRef: { filePath },
      marker: { size: 0 },
      ownRecentUserTexts: [],
    };

    await expect(
      checkClaudeUpstreamActivity([
        { ...baseProbe, sessionKey: "stale", upstreamRef: { filePath: `${filePath}.missing` } },
        baseProbe,
      ]),
    ).resolves.toEqual([
      { kind: "missing", sessionKey: "stale" },
      expect.objectContaining({ kind: "activity", sessionKey: "healthy", humanTurns: 1 }),
    ]);
  });

  it("keeps continuation successful when baseline enumeration fails", async () => {
    await expect(
      linkContinued({
        sessionKey: "session-key",
        hostId: "gateway:local",
        threadId: "thread-1",
        listLocalSessions: async () => {
          throw new Error("catalog unavailable");
        },
        readRemote: async () => [],
      }),
    ).resolves.toEqual({ sessionKey: "session-key" });
  });

  it("classifies bounded paired-node transcript pages past the UUID marker", async () => {
    const remoteProbe: SessionUpstreamProbe = {
      sessionKey: "remote",
      agentId: "main",
      threadId: "thread-remote",
      hostId: "node:node-a",
      upstreamKind: "claude-cli",
      upstreamRef: { nodeId: "node-a", threadId: "thread-remote" },
      marker: { uuid: "item-1" },
      ownRecentUserTexts: [],
    };

    await expect(
      checkClaudeUpstreamActivity([remoteProbe], async () => [
        { type: "agentMessage", text: "reply", uuid: "item-3" },
        {
          type: "userMessage",
          content: "native prompt",
          timestamp: "2026-07-13T10:07:00.000Z",
          uuid: "item-2",
        },
        { type: "userMessage", text: "old", uuid: "item-1" },
      ]),
    ).resolves.toEqual([
      {
        kind: "activity",
        sessionKey: "remote",
        occurredAt: Date.parse("2026-07-13T10:07:00.000Z"),
        humanTurns: 1,
        nextMarker: { uuid: "item-3" },
        dedupeId: "item-3",
      },
    ]);
  });

  it("scans forward across bounded ticks without skipping a middle user row", async () => {
    const dir = await makeTempDir("openclaw-claude-upstream-chunks-");
    const filePath = path.join(dir, "thread-chunks.jsonl");
    const firstRow = `${row({
      type: "assistant",
      content: "x".repeat(CLAUDE_UPSTREAM_SCAN_BYTES - 200),
      timestamp: "2026-07-13T10:08:00.000Z",
    })}\n`;
    const userRow = `${row({
      type: "user",
      content: "middle prompt",
      timestamp: "2026-07-13T10:09:00.000Z",
    })}\n`;
    const finalRow = `${row({
      type: "assistant",
      content: "y".repeat(512 * 1024),
      timestamp: "2026-07-13T10:10:00.000Z",
    })}\n`;
    await fs.writeFile(filePath, firstRow + userRow + finalRow);
    const baseProbe: SessionUpstreamProbe = {
      sessionKey: "agent:main:adopted:claude-chunks",
      agentId: "main",
      threadId: "thread-chunks",
      hostId: "gateway:local",
      upstreamKind: "claude-cli",
      upstreamRef: { filePath },
      marker: { offset: 0 },
      ownRecentUserTexts: [],
    };

    const first = await checkActivity(baseProbe);
    expect(first).toEqual({
      kind: "activity",
      sessionKey: baseProbe.sessionKey,
      humanTurns: 0,
      nextMarker: { offset: Buffer.byteLength(firstRow) },
    });
    if (first?.kind !== "activity") {
      throw new Error("expected activity marker");
    }
    await expect(checkActivity({ ...baseProbe, marker: first.nextMarker })).resolves.toEqual(
      expect.objectContaining({
        kind: "activity",
        humanTurns: 1,
        nextMarker: { offset: Buffer.byteLength(firstRow + userRow + finalRow) },
      }),
    );
  });

  it("treats legacy size and current offset markers as the same scan cursor", async () => {
    const dir = await makeTempDir("openclaw-claude-upstream-marker-");
    const filePath = path.join(dir, "thread-marker.jsonl");
    const baseline = "{}\n";
    await fs.writeFile(
      filePath,
      `${baseline}${row({
        type: "user",
        content: "new prompt",
        timestamp: "2026-07-13T10:11:00.000Z",
      })}\n`,
    );
    const baseProbe: SessionUpstreamProbe = {
      sessionKey: "agent:main:adopted:claude-marker",
      agentId: "main",
      threadId: "thread-marker",
      hostId: "gateway:local",
      upstreamKind: "claude-cli",
      upstreamRef: { filePath },
      marker: { offset: Buffer.byteLength(baseline) },
      ownRecentUserTexts: [],
    };

    const offsetResult = await checkActivity(baseProbe);
    const sizeResult = await checkActivity({
      ...baseProbe,
      marker: { size: Buffer.byteLength(baseline) },
    });
    expect(sizeResult).toEqual(offsetResult);
    expect(offsetResult?.kind).toBe("activity");
    if (offsetResult?.kind === "activity") {
      expect(offsetResult.nextMarker).toEqual({ offset: (await fs.stat(filePath)).size });
    }
  });
  it("declines a remote link when the newest history item lacks a UUID", async () => {
    const readRemote = async () => [{ type: "userMessage", text: "hi" }] as never;
    const declined = await linkContinued({
      sessionKey: "agent:main:adopted",
      hostId: "node:devbox",
      threadId: "thread-1",
      listLocalSessions: async () => [],
      readRemote,
    });
    // UUID-less newest item cannot baseline safely; no upstream link is seeded.
    expect(declined).toEqual({ sessionKey: "agent:main:adopted" });

    const linked = await linkContinued({
      sessionKey: "agent:main:adopted",
      hostId: "node:devbox",
      threadId: "thread-1",
      listLocalSessions: async () => [],
      readRemote: async () => [{ type: "userMessage", text: "hi", uuid: "u-9" }] as never,
    });
    expect(linked.upstream?.marker).toEqual({ uuid: "u-9" });
  });
});
