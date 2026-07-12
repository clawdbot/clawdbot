import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_SESSIONS_LIST_COMMAND,
  CLAUDE_SESSION_READ_COMMAND,
  createClaudeSessionNodeHostCommands,
  listClaudeSessionCatalog,
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
  registerClaudeSessionCatalog,
} from "./session-catalog.js";

const homes: string[] = [];
const originalHome = process.env.HOME;

async function createHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-catalog-"));
  homes.push(home);
  return home;
}

async function writeProject(params: {
  home: string;
  project?: string;
  entries: Array<Record<string, unknown>>;
  transcripts: Record<string, Array<Record<string, unknown>>>;
}): Promise<void> {
  const projectDir = path.join(params.home, ".claude", "projects", params.project ?? "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: params.entries }),
  );
  await Promise.all(
    Object.entries(params.transcripts).map(([sessionId, rows]) =>
      fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    ),
  );
}

async function writeDesktopMetadata(
  home: string,
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `local_${name}.json`), JSON.stringify(metadata));
}

function message(
  sessionId: string,
  type: "user" | "assistant",
  text: string,
  index: number,
): Record<string, unknown> {
  return {
    type,
    sessionId,
    uuid: `${sessionId}-${index}`,
    timestamp: `2026-07-0${index}T00:00:00.000Z`,
    isSidechain: false,
    message: {
      role: type,
      content: [{ type: "text", text }],
      ...(type === "assistant" ? { model: "claude-opus-4-8" } : {}),
    },
  };
}

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Claude session catalog", () => {
  it("adopts a local CLI row with a locked one-shot fork binding", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-source-session";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "Source session",
          projectPath: "/work/source",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "source prompt", 1)] },
    });
    const createSessionEntry = vi.fn(async (params: Record<string, unknown>) => ({
      key: `agent:main:${String(params.key)}`,
      agentId: "main",
      sessionId: "openclaw-adopted",
      entry: { sessionId: "openclaw-adopted", updatedAt: Date.now() },
    }));
    let provider: SessionCatalogProvider | undefined;
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        agent: {
          session: {
            listSessionEntries: () => [],
            createSessionEntry,
          },
        },
      },
      registerSessionCatalog: (candidate: SessionCatalogProvider) => {
        provider = candidate;
      },
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);

    await expect(
      provider?.continueSession?.({ hostId: "gateway:local", threadId: sessionId }),
    ).resolves.toEqual({
      sessionKey: expect.stringContaining("plugin:anthropic:catalog-adopt:claude:"),
    });
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnedCwd: "/work/source",
        initialEntry: expect.objectContaining({
          cliBackendId: "claude-cli",
          model: "claude-opus-4-8",
          modelSelectionLocked: true,
          pluginOwnerId: "anthropic",
          cliSessionBinding: {
            sessionId,
            forceReuse: true,
            forkNextResume: true,
          },
        }),
      }),
    );
  });

  it("merges CLI indexes with active Desktop metadata and hides archived Desktop sessions", async () => {
    const home = await createHome();
    await writeProject({
      home,
      entries: [
        {
          sessionId: "cli-session",
          fullPath: path.join(home, ".claude", "projects", "-workspace", "cli-session.jsonl"),
          summary: "CLI title",
          modified: "2026-07-01T00:00:00.000Z",
          projectPath: "/work/cli",
          isSidechain: false,
        },
        {
          sessionId: "desktop-session",
          fullPath: path.join(home, ".claude", "projects", "-workspace", "desktop-session.jsonl"),
          summary: "Index title",
          modified: "2026-07-02T00:00:00.000Z",
          projectPath: "/work/desktop",
          isSidechain: false,
        },
        {
          sessionId: "archived-session",
          fullPath: path.join(home, ".claude", "projects", "-workspace", "archived-session.jsonl"),
          summary: "Archived",
          modified: "2026-07-03T00:00:00.000Z",
          isSidechain: false,
        },
      ],
      transcripts: {
        "cli-session": [message("cli-session", "user", "CLI", 1)],
        "desktop-session": [message("desktop-session", "user", "Desktop", 1)],
        "archived-session": [message("archived-session", "user", "Archived", 1)],
      },
    });
    await writeDesktopMetadata(home, "active", {
      sessionId: "local-active",
      cliSessionId: "desktop-session",
      title: "Desktop title",
      cwd: "/desktop/cwd",
      lastActivityAt: Date.parse("2026-07-04T00:00:00.000Z"),
      isArchived: false,
    });
    await writeDesktopMetadata(home, "archived", {
      sessionId: "local-archived",
      cliSessionId: "archived-session",
      title: "Archived title",
      isArchived: true,
    });

    const first = await listLocalClaudeSessionPage({ limit: 1 }, home);
    expect(first.sessions).toEqual([
      expect.objectContaining({
        threadId: "desktop-session",
        name: "Desktop title",
        cwd: "/desktop/cwd",
        source: "claude-desktop",
        archived: false,
      }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await listLocalClaudeSessionPage({ limit: 1, cursor: first.nextCursor }, home);
    expect(second.sessions).toEqual([
      expect.objectContaining({
        threadId: "cli-session",
        name: "CLI title",
        source: "claude-cli",
      }),
    ]);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      readLocalClaudeTranscriptPage({ threadId: "archived-session", limit: 1 }, home),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("rejects sidechain, unindexed, and symlink-escaped transcript ids", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const escapedId = "escaped-session";
    const escapedPath = path.join(projectDir, `${escapedId}.jsonl`);
    const externalPath = path.join(home, "outside.jsonl");
    await writeProject({
      home,
      entries: [
        {
          sessionId: "sidechain-session",
          fullPath: path.join(projectDir, "sidechain-session.jsonl"),
          isSidechain: true,
        },
        { sessionId: escapedId, fullPath: escapedPath, isSidechain: false },
      ],
      transcripts: {
        "sidechain-session": [message("sidechain-session", "user", "sidechain", 1)],
        "unindexed-session": [message("unindexed-session", "user", "unindexed", 1)],
        "sdk-cli-session": [
          {
            ...message("sdk-cli-session", "user", "CLI prompt", 1),
            entrypoint: "sdk-cli",
            cwd: "/work/sdk",
            version: "2.1.204",
          },
        ],
        "discovered-sidechain": [
          {
            ...message("discovered-sidechain", "user", "sidechain", 1),
            entrypoint: "sdk-cli",
            isSidechain: true,
          },
        ],
      },
    });
    await fs.writeFile(
      externalPath,
      `${JSON.stringify(message(escapedId, "user", "outside", 1))}\n`,
    );
    await fs.symlink(externalPath, escapedPath);
    await writeDesktopMetadata(home, "sidechain", {
      cliSessionId: "sidechain-session",
      title: "Desktop sidechain",
      isArchived: false,
    });
    await writeDesktopMetadata(home, "discovered-sidechain", {
      cliSessionId: "discovered-sidechain",
      title: "Discovered Desktop sidechain",
      isArchived: false,
    });

    expect((await listLocalClaudeSessionPage({}, home)).sessions).toEqual([
      expect.objectContaining({
        threadId: "sdk-cli-session",
        name: "CLI prompt",
        source: "claude-cli",
      }),
    ]);
    await expect(
      readLocalClaudeTranscriptPage({ threadId: "sdk-cli-session", limit: 1 }, home),
    ).resolves.toEqual(
      expect.objectContaining({ items: [expect.objectContaining({ text: "CLI prompt" })] }),
    );
    for (const threadId of [
      "sidechain-session",
      "discovered-sidechain",
      "unindexed-session",
      escapedId,
    ]) {
      await expect(readLocalClaudeTranscriptPage({ threadId, limit: 1 }, home)).rejects.toThrow(
        "Claude session is unavailable",
      );
    }
  });

  it("reads newest transcript messages first by page while returning each page chronologically", async () => {
    const home = await createHome();
    const sessionId = "transcript-session";
    const oldUser = "old user ".repeat(20_000);
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "Transcript",
          modified: "2026-07-04T00:00:00.000Z",
          isSidechain: false,
        },
      ],
      transcripts: {
        [sessionId]: [
          { type: "queue-operation", sessionId },
          message(sessionId, "user", oldUser, 1),
          message(sessionId, "assistant", "old assistant", 2),
          message(sessionId, "user", "new user", 3),
          message(sessionId, "assistant", "new assistant", 4),
        ],
      },
    });

    const latest = await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 2 }, home);
    expect(latest.items.map((item) => item.text)).toEqual(["new assistant", "new user"]);
    expect(latest.nextCursor).toEqual(expect.any(String));

    const older = await readLocalClaudeTranscriptPage(
      { threadId: sessionId, limit: 2, cursor: latest.nextCursor },
      home,
    );
    expect(older.items.map((item) => item.text)).toEqual(["old assistant", oldUser]);
    expect(older.nextCursor).toBeUndefined();
  });

  it("registers read-only node commands only when a Claude store exists", async () => {
    const home = await createHome();
    const commands = createClaudeSessionNodeHostCommands();
    expect(commands.map((command) => command.command)).toEqual([
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
    ]);
    expect(commands.every((command) => command.dangerous === false)).toBe(true);
    const availabilityContext = { config: {}, env: { HOME: home } } as never;
    expect(commands.every((command) => command.isAvailable?.(availabilityContext))).toBe(false);
    await fs.mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    expect(commands.every((command) => command.isAvailable?.(availabilityContext))).toBe(true);

    const registerSessionCatalog = vi.fn();
    const api = {
      runtime: {},
      registerSessionCatalog,
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);
    expect(registerSessionCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude", label: "Claude Code" }),
    );
  });

  it("keeps one failed node isolated from healthy hosts", async () => {
    const runtime = {
      nodes: {
        list: vi.fn().mockResolvedValue({
          nodes: [
            {
              nodeId: "healthy",
              displayName: "Healthy",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND],
            },
            {
              nodeId: "failed",
              displayName: "Failed",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND],
            },
          ],
        }),
        invoke: vi.fn().mockImplementation(({ nodeId }: { nodeId: string }) => {
          if (nodeId === "failed") {
            throw new Error("offline");
          }
          return { payloadJSON: JSON.stringify({ sessions: [] }) };
        }),
      },
    } as unknown as PluginRuntime;

    const result = await listClaudeSessionCatalog({
      runtime,
      query: { hostIds: ["node:healthy", "node:failed"] },
    });
    expect(result.hosts).toEqual([
      expect.objectContaining({ hostId: "node:failed", error: expect.any(Object) }),
      expect.objectContaining({ hostId: "node:healthy", sessions: [] }),
    ]);
  });

  it("rejects malformed fields returned by a paired node", async () => {
    const runtime = {
      nodes: {
        list: vi.fn().mockResolvedValue({
          nodes: [
            {
              nodeId: "malformed",
              displayName: "Malformed",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND],
            },
          ],
        }),
        invoke: vi.fn().mockResolvedValue({
          payloadJSON: JSON.stringify({
            sessions: [
              {
                threadId: "session",
                name: 1,
                status: "stored",
                source: "claude-cli",
                modelProvider: "anthropic",
                archived: false,
              },
            ],
          }),
        }),
      },
    } as unknown as PluginRuntime;

    const result = await listClaudeSessionCatalog({
      runtime,
      query: { hostIds: ["node:malformed"] },
    });
    expect(result.hosts).toEqual([
      expect.objectContaining({ hostId: "node:malformed", error: expect.any(Object) }),
    ]);
  });
});
