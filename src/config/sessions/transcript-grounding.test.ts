import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptEvent,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  type SessionTranscriptTurnPersistOptions,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { readRecentUserAssistantTextForSession } from "./transcript.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realpath = vi.fn(actual.realpath);
  const stat = vi.fn(actual.stat);
  return {
    ...actual,
    default: { ...actual, realpath, stat },
    realpath,
    stat,
  };
});

const REDACTED = "[unverified media reference removed]";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("readRecentUserAssistantTextForSession grounding", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  async function createSession(
    name: string,
    messages: SessionTranscriptTurnPersistOptions["messages"],
    stateDir = tempDirs.make(`${name}-`),
  ) {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const sessionKey = `agent:main:${name}`;
    const sessionId = `${name}-session`;
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId, chatType: "direct", updatedAt: 1 },
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      { updateMode: "none", messages },
    );
    return { sessionId, sessionKey, stateDir, storePath };
  }

  it("grounds trusted same-turn media without mutating persisted or user-authored text", async () => {
    const stateDir = tempDirs.make("grounding-replay-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const real = path.join(stateDir, "media", "inbound", "real.jpg");
    const fake = path.join(stateDir, "media", "fabricated.jpg");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "image");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const sessionKey = "agent:main:grounding-replay";
    const sessionId = "grounding-replay-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId, chatType: "direct", updatedAt: 1 },
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        updateMode: "none",
        messages: [
          { message: { role: "user", timestamp: 1, content: `user repeats ${fake}` } },
          {
            message: {
              role: "toolResult",
              toolCallId: "image-1",
              // Stable transcripts persisted the core image tool under this name.
              toolName: "image",
              isError: false,
              timestamp: 2,
              content: [{ type: "text", text: "Loaded image." }],
              details: { media: { mediaUrls: [real] } },
            },
          },
          {
            message: {
              role: "assistant",
              timestamp: 3,
              content: [{ type: "text", text: `Fabricated ${fake}; verified ${real}.` }],
            },
          },
        ],
      },
    );
    const before = await loadTranscriptEvents({ agentId: "main", sessionId, storePath });

    const replay = await readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath,
      limit: 10,
    });

    expect(replay.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: `user repeats ${fake}` },
      { role: "assistant", text: `Fabricated ${REDACTED}/fabricated.jpg; verified ${real}.` },
    ]);
    expect(await loadTranscriptEvents({ agentId: "main", sessionId, storePath })).toStrictEqual(
      before,
    );
  });

  it("rejects MCP, later-result, and prior-user-turn provenance", async () => {
    const stateDir = tempDirs.make("grounding-turn-order-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const real = path.join(stateDir, "media", "generated", "real.jpg");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "image");
    const { sessionKey, storePath } = await createSession(
      "turn-order",
      [
        { message: { role: "user", timestamp: 1, content: "first user" } },
        { message: { role: "assistant", timestamp: 2, content: `before ${real}` } },
        {
          message: {
            role: "toolResult",
            toolCallId: "mcp-image",
            toolName: "view_image",
            isError: false,
            timestamp: 3,
            content: "MCP image",
            details: { mcpServer: "untrusted", media: { mediaUrls: [real] } },
          },
        },
        { message: { role: "assistant", timestamp: 4, content: `after mcp ${real}` } },
        {
          message: {
            role: "toolResult",
            toolCallId: "trusted-image",
            toolName: "view_image",
            isError: false,
            timestamp: 5,
            content: "Trusted image",
            details: { media: { mediaUrls: [real] } },
          },
        },
        { message: { role: "assistant", timestamp: 6, content: `after trusted ${real}` } },
        { message: { role: "user", timestamp: 7, content: "second user" } },
        { message: { role: "assistant", timestamp: 8, content: `next turn ${real}` } },
      ],
      stateDir,
    );

    const assistants = await readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath,
      limit: 10,
      role: "assistant",
    });
    expect(assistants.map((entry) => entry.text)).toEqual([
      `before ${REDACTED}/generated/real.jpg`,
      `after mcp ${REDACTED}/generated/real.jpg`,
      `after trusted ${real}`,
      `next turn ${REDACTED}/generated/real.jpg`,
    ]);
  });

  it("does not let persisted Bash or Web_Search collisions authorize local media", async () => {
    const stateDir = tempDirs.make("grounding-tool-collisions-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const real = path.join(stateDir, "media", "generated", "real.jpg");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "image");
    const { sessionKey, storePath } = await createSession(
      "tool-collisions",
      [
        { message: { role: "user", content: "inspect" } },
        ...["Bash", "Web_Search"].map((toolName, index) => ({
          message: {
            role: "toolResult" as const,
            toolCallId: `collision-${index}`,
            toolName,
            isError: false,
            content: "done",
            details: {
              media: { mediaUrls: [real], localMediaReplayAuthorized: false },
            },
          },
        })),
        { message: { role: "assistant", content: `claim ${real}` } },
      ],
      stateDir,
    );

    const replay = await readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath,
      limit: 1,
      role: "assistant",
    });
    expect(replay.map((entry) => entry.text)).toEqual([`claim ${REDACTED}/generated/real.jpg`]);
  });

  it("bounds very large persisted structured media arrays before grounding", async () => {
    const stateDir = tempDirs.make("grounding-large-media-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const real = path.join(stateDir, "media", "generated", "real.jpg");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "image");
    const mediaUrls = [
      real,
      ...Array.from({ length: 99_999 }, (_, index) =>
        path.join(stateDir, "media", "generated", `missing-${index}.jpg`),
      ),
    ];
    const omitted = mediaUrls.at(-1)!;
    const { sessionKey, storePath } = await createSession(
      "large-media",
      [
        { message: { role: "user", content: "inspect" } },
        {
          message: {
            role: "toolResult",
            toolCallId: "many-images",
            toolName: "image_generate",
            isError: false,
            content: "Generated",
            details: { media: { mediaUrls } },
          },
        },
        { message: { role: "assistant", content: `kept ${real}; omitted ${omitted}` } },
      ],
      stateDir,
    );

    const replay = await readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath,
      limit: 1,
      role: "assistant",
    });

    expect(replay.map((entry) => entry.text)).toEqual([
      `kept ${real}; omitted ${REDACTED}/generated/missing-99998.jpg`,
    ]);
  });

  it("preserves history above 128 while preparing its media root once", async () => {
    const messages = Array.from({ length: 140 }, (_, index) => ({
      message: { role: "assistant" as const, content: `message-${index}` },
    }));
    const { sessionKey, stateDir, storePath } = await createSession("large-history", messages);
    const realpath = vi.mocked(fsPromises.realpath);
    const stat = vi.mocked(fsPromises.stat);
    realpath.mockClear();
    stat.mockClear();
    try {
      const replay = await readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath,
        limit: 140,
        role: "assistant",
      });

      expect(replay).toHaveLength(140);
      expect(replay[0]?.text).toBe("message-0");
      expect(replay.at(-1)?.text).toBe("message-139");
      expect(
        realpath.mock.calls.filter(([candidate]) =>
          path.resolve(String(candidate)).startsWith(path.join(stateDir, "media")),
        ),
      ).toHaveLength(1);
      expect(stat).toHaveBeenCalledTimes(2);
    } finally {
      realpath.mockClear();
      stat.mockClear();
    }
  });

  it("bounds provenance across pages without bounding requested result pagination", async () => {
    const stateDir = tempDirs.make("grounding-window-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const old = path.join(stateDir, "media", "generated", "old.jpg");
    const recent = path.join(stateDir, "media", "generated", "recent.jpg");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "old");
    fs.writeFileSync(recent, "recent");
    const noops = Array.from({ length: 1_001 }, (_, index) => ({
      message: {
        role: "toolResult" as const,
        toolCallId: `noop-${index}`,
        toolName: "noop",
        isError: false,
        timestamp: 10 + index,
        content: "No media",
      },
    }));
    const { sessionKey, storePath } = await createSession(
      "window",
      [
        { message: { role: "user", timestamp: 1, content: "make images" } },
        {
          message: {
            role: "toolResult",
            toolCallId: "old",
            toolName: "image_generate",
            isError: false,
            timestamp: 2,
            content: "Old image",
            details: { media: { mediaUrls: [old] } },
          },
        },
        ...noops,
        {
          message: {
            role: "toolResult",
            toolCallId: "recent",
            toolName: "image_generate",
            isError: false,
            timestamp: 2_000,
            content: "Recent image",
            details: { media: { mediaUrls: [recent] } },
          },
        },
        {
          message: { role: "assistant", timestamp: 2_001, content: `old ${old} recent ${recent}` },
        },
      ],
      stateDir,
    );
    const replay = await readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath,
      limit: 1,
      role: "assistant",
    });
    expect(replay.map((entry) => entry.text)).toEqual([
      `old ${REDACTED}/generated/old.jpg recent ${recent}`,
    ]);
  });

  it("bounds every retained entry and the complete replay prompt after grounding", async () => {
    const stateDir = tempDirs.make("g-", "/tmp");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const fake = path.join(stateDir, "media", "generated", "fake.jpg");
    const repeatedShortRoot = `${path.join(stateDir, "media")} `.repeat(4_000);
    const messages: SessionTranscriptTurnPersistOptions["messages"] = [
      { message: { role: "user", timestamp: 1, content: "start" } },
      ...Array.from({ length: 5 }, (_, index) => ({
        message: {
          role: "assistant" as const,
          timestamp: index + 2,
          content: `entry-${index} ${fake} ${"x".repeat(40_000)}`,
        },
      })),
      {
        message: {
          role: "assistant",
          timestamp: 10,
          content: repeatedShortRoot,
        },
      },
    ];
    const { sessionKey, storePath } = await createSession("prompt-budget", messages, stateDir);

    const replay = await readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath,
      limit: 10,
    });

    expect(replay.some((entry) => entry.text.includes(`${REDACTED}/generated/fake.jpg`))).toBe(
      true,
    );
    expect(replay.at(-1)?.text.startsWith(REDACTED)).toBe(true);
    expect(replay.every((entry) => Buffer.byteLength(entry.text) <= 32 * 1024)).toBe(true);
    expect(
      replay.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0),
    ).toBeLessThanOrEqual(128 * 1024);
    expect(replay.some((entry) => entry.text.startsWith("entry-0"))).toBe(false);
    expect(replay.some((entry) => entry.text.startsWith("entry-4"))).toBe(true);
  });

  it("does not borrow provenance from another session", async () => {
    const stateDir = tempDirs.make("grounding-session-scope-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const real = path.join(stateDir, "media", "generated", "other.jpg");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "image");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    for (const [sessionKey, sessionId] of [
      ["agent:main:source", "source-session"],
      ["agent:main:target", "target-session"],
    ] as const) {
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId, chatType: "direct", updatedAt: 1 },
      );
    }
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "source-session",
        sessionKey: "agent:main:source",
        storePath,
      },
      {
        updateMode: "none",
        messages: [
          { message: { role: "user", content: "source" } },
          {
            message: {
              role: "toolResult",
              toolCallId: "image",
              toolName: "image_generate",
              isError: false,
              content: "Generated",
              details: { media: { mediaUrls: [real] } },
            },
          },
        ],
      },
    );
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "target-session",
        sessionKey: "agent:main:target",
        storePath,
      },
      {
        updateMode: "none",
        messages: [
          { message: { role: "user", content: "target" } },
          { message: { role: "assistant", content: `claim ${real}` } },
        ],
      },
    );
    const replay = await readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey: "agent:main:target",
      storePath,
      limit: 1,
      role: "assistant",
    });
    expect(replay.map((entry) => entry.text)).toEqual([`claim ${REDACTED}/generated/other.jpg`]);
  });

  it("does not borrow provenance from an inactive transcript branch", async () => {
    const stateDir = tempDirs.make("grounding-branch-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const real = path.join(stateDir, "media", "generated", "inactive.jpg");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "image");
    const { sessionId, sessionKey, storePath } = await createSession(
      "branch",
      [
        {
          eventId: "root-user",
          parentId: null,
          message: { role: "user", content: "inspect" },
        },
        {
          eventId: "active-assistant",
          parentId: "root-user",
          message: { role: "assistant", content: `claim ${real}` },
        },
        {
          eventId: "inactive-tool",
          parentId: "root-user",
          message: {
            role: "toolResult",
            toolCallId: "image",
            toolName: "image_generate",
            isError: false,
            content: "Generated",
            details: { media: { mediaUrls: [real] } },
          },
        },
      ],
      stateDir,
    );
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        type: "leaf",
        id: "select-active",
        parentId: "inactive-tool",
        targetId: "active-assistant",
      },
    );
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
    });

    const replay = await readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath,
      limit: 1,
      role: "assistant",
    });
    expect(replay.map((entry) => entry.text)).toEqual([`claim ${REDACTED}/generated/inactive.jpg`]);
  });
});
