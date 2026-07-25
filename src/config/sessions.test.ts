// Covers session config path and compatibility behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  buildGroupDisplayName,
  deriveSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptsDir,
} from "./sessions.js";

describe("sessions", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createCaseDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-suite-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  const withStateDir = <T>(stateDir: string, fn: () => T): T =>
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, fn);

  function expectedBot1FallbackSessionPath() {
    return path.join(
      path.resolve("/different/state"),
      "agents",
      "bot1",
      "sessions",
      "sess-1.jsonl",
    );
  }

  async function createAgentSessionsLayout(label: string): Promise<{
    stateDir: string;
    mainStorePath: string;
    bot2SessionPath: string;
    outsidePath: string;
  }> {
    const stateDir = await createCaseDir(label);
    const mainSessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const bot1SessionsDir = path.join(stateDir, "agents", "bot1", "sessions");
    const bot2SessionsDir = path.join(stateDir, "agents", "bot2", "sessions");
    await fs.mkdir(mainSessionsDir, { recursive: true });
    await fs.mkdir(bot1SessionsDir, { recursive: true });
    await fs.mkdir(bot2SessionsDir, { recursive: true });

    const mainStorePath = path.join(mainSessionsDir, "sessions.json");
    await fs.writeFile(mainStorePath, "{}", "utf-8");

    const bot2SessionPath = path.join(bot2SessionsDir, "sess-1.jsonl");
    await fs.writeFile(bot2SessionPath, "{}", "utf-8");

    const outsidePath = path.join(stateDir, "outside", "not-a-session.jsonl");
    await fs.mkdir(path.dirname(outsidePath), { recursive: true });
    await fs.writeFile(outsidePath, "{}", "utf-8");

    return { stateDir, mainStorePath, bot2SessionPath, outsidePath };
  }

  async function normalizePathForComparison(filePath: string): Promise<string> {
    const canonicalFile = await fs.realpath(filePath).catch(() => null);
    if (canonicalFile) {
      return canonicalFile;
    }
    const parentDir = path.dirname(filePath);
    const canonicalParent = await fs.realpath(parentDir).catch(() => parentDir);
    return path.join(canonicalParent, path.basename(filePath));
  }

  const deriveSessionKeyCases = [
    {
      name: "returns normalized per-sender key",
      scope: "per-sender" as const,
      ctx: { From: "chat:+1555" },
      expected: "+1555",
    },
    {
      name: "falls back to unknown when sender missing",
      scope: "per-sender" as const,
      ctx: {},
      expected: "unknown",
    },
    {
      name: "global scope returns global",
      scope: "global" as const,
      ctx: { From: "+1" },
      expected: "global",
    },
    {
      name: "keeps group chats distinct",
      scope: "per-sender" as const,
      ctx: { From: "room-123", ChatType: "group", Provider: "demo-chat" },
      expected: "demo-chat:group:room-123",
    },
    {
      name: "prefixes group keys with provider when available",
      scope: "per-sender" as const,
      ctx: { From: "room-456", ChatType: "group", Provider: "demo-chat" },
      expected: "demo-chat:group:room-456",
    },
  ] as const;

  for (const testCase of deriveSessionKeyCases) {
    it(testCase.name, () => {
      expect(deriveSessionKey(testCase.scope, testCase.ctx)).toBe(testCase.expected);
    });
  }

  it("builds discord display name with guild+channel slugs", () => {
    expect(
      buildGroupDisplayName({
        provider: "discord",
        groupChannel: "#general",
        space: "friends-of-openclaw",
        id: "123",
        key: "discord:group:123",
      }),
    ).toBe("discord:friends-of-openclaw#general");
  });

  const resolveSessionKeyCases = [
    {
      name: "keeps explicit provider when provided in group key",
      scope: "per-sender" as const,
      ctx: { From: "discord:group:12345", ChatType: "group" },
      mainKey: "main",
      expected: "agent:main:discord:group:12345",
    },
    {
      name: "collapses direct chats to main by default",
      scope: "per-sender" as const,
      ctx: { From: "+1555" },
      mainKey: undefined,
      expected: "agent:main:main",
    },
    {
      name: "collapses direct chats to main even when sender missing",
      scope: "per-sender" as const,
      ctx: {},
      mainKey: undefined,
      expected: "agent:main:main",
    },
    {
      name: "maps direct chats to main key when provided",
      scope: "per-sender" as const,
      ctx: { From: "chat:+1555" },
      mainKey: "main",
      expected: "agent:main:main",
    },
    {
      name: "uses custom main key when provided",
      scope: "per-sender" as const,
      ctx: { From: "+1555" },
      mainKey: "primary",
      expected: "agent:main:primary",
    },
    {
      name: "keeps global scope untouched",
      scope: "global" as const,
      ctx: { From: "+1555" },
      mainKey: undefined,
      expected: "global",
    },
    {
      name: "leaves groups untouched even with main key",
      scope: "per-sender" as const,
      ctx: { From: "room-123", ChatType: "group", Provider: "demo-chat" },
      mainKey: "main",
      expected: "agent:main:demo-chat:group:room-123",
    },
  ] as const;

  for (const testCase of resolveSessionKeyCases) {
    it(testCase.name, () => {
      expect(resolveSessionKey(testCase.scope, testCase.ctx, testCase.mainKey)).toBe(
        testCase.expected,
      );
    });
  }

  it("derives session transcripts dir from OPENCLAW_STATE_DIR", () => {
    const dir = resolveSessionTranscriptsDir(
      { OPENCLAW_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv,
      () => "/home/ignored",
    );
    expect(dir).toBe(path.join(path.resolve("/custom/state"), "agents", "main", "sessions"));
  });

  it("includes topic ids in session transcript filenames", () => {
    withStateDir("/custom/state", () => {
      const sessionFile = resolveSessionTranscriptPath("sess-1", "main", 123);
      expect(sessionFile).toBe(
        path.join(
          path.resolve("/custom/state"),
          "agents",
          "main",
          "sessions",
          "sess-1-topic-123.jsonl",
        ),
      );
    });
  });

  it("uses agent id when resolving session file fallback paths", () => {
    withStateDir("/custom/state", () => {
      const sessionFile = resolveSessionFilePath("sess-2", undefined, {
        agentId: "codex",
      });
      expect(sessionFile).toBe(
        path.join(path.resolve("/custom/state"), "agents", "codex", "sessions", "sess-2.jsonl"),
      );
    });
  });

  it("resolves cross-agent absolute sessionFile paths", async () => {
    const { stateDir, bot2SessionPath } = await createAgentSessionsLayout("cross-agent");
    const sessionFile = withStateDir(stateDir, () =>
      // Agent bot1 resolves a sessionFile that belongs to agent bot2
      resolveSessionFilePath("sess-1", { sessionFile: bot2SessionPath }, { agentId: "bot1" }),
    );
    expect(await normalizePathForComparison(sessionFile)).toBe(
      await normalizePathForComparison(bot2SessionPath),
    );
  });

  it("resolves cross-agent paths when OPENCLAW_STATE_DIR differs from stored paths", () => {
    withStateDir(path.resolve("/different/state"), () => {
      const originalBase = path.resolve("/original/state");
      const bot2Session = path.join(originalBase, "agents", "bot2", "sessions", "sess-1.jsonl");
      // sessionFile was created under a different state dir than current env
      const sessionFile = resolveSessionFilePath(
        "sess-1",
        { sessionFile: bot2Session },
        { agentId: "bot1" },
      );
      expect(sessionFile).toBe(bot2Session);
    });
  });

  it("falls back when structural cross-root path traverses after sessions", () => {
    withStateDir(path.resolve("/different/state"), () => {
      const originalBase = path.resolve("/original/state");
      const unsafe = path.join(originalBase, "agents", "bot2", "sessions", "..", "..", "etc");
      const sessionFile = resolveSessionFilePath(
        "sess-1",
        { sessionFile: path.join(unsafe, "passwd") },
        { agentId: "bot1" },
      );
      expect(sessionFile).toBe(expectedBot1FallbackSessionPath());
    });
  });

  it("falls back when structural cross-root path nests under sessions", () => {
    withStateDir(path.resolve("/different/state"), () => {
      const originalBase = path.resolve("/original/state");
      const nested = path.join(
        originalBase,
        "agents",
        "bot2",
        "sessions",
        "nested",
        "sess-1.jsonl",
      );
      const sessionFile = resolveSessionFilePath(
        "sess-1",
        { sessionFile: nested },
        { agentId: "bot1" },
      );
      expect(sessionFile).toBe(expectedBot1FallbackSessionPath());
    });
  });

  it("resolveSessionFilePathOptions keeps explicit agentId alongside absolute store path", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const resolved = resolveSessionFilePathOptions({
      agentId: "bot2",
      storePath,
    });
    expect(resolved?.agentId).toBe("bot2");
    expect(resolved?.sessionsDir).toBe(path.dirname(path.resolve(storePath)));
  });

  it("resolves sibling agent absolute sessionFile using alternate agentId from options", async () => {
    const { stateDir, mainStorePath, bot2SessionPath } =
      await createAgentSessionsLayout("sibling-agent");
    const sessionFile = withStateDir(stateDir, () => {
      const opts = resolveSessionFilePathOptions({
        agentId: "bot2",
        storePath: mainStorePath,
      });

      return resolveSessionFilePath("sess-1", { sessionFile: bot2SessionPath }, opts);
    });
    expect(await normalizePathForComparison(sessionFile)).toBe(
      await normalizePathForComparison(bot2SessionPath),
    );
  });

  it("falls back to derived transcript path when sessionFile is outside agent sessions directories", async () => {
    const { stateDir, outsidePath } = await createAgentSessionsLayout("outside-fallback");
    const sessionFile = withStateDir(stateDir, () =>
      resolveSessionFilePath("sess-1", { sessionFile: outsidePath }, { agentId: "bot1" }),
    );
    const expectedPath = path.join(stateDir, "agents", "bot1", "sessions", "sess-1.jsonl");
    expect(await normalizePathForComparison(sessionFile)).toBe(
      await normalizePathForComparison(expectedPath),
    );
  });
});
