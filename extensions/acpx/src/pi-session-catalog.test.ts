import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

type ResolveAcpSessionAvailability =
  (typeof import("openclaw/plugin-sdk/acp-runtime"))["resolveAcpSessionAvailability"];

const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
}));
const acpRuntimeMocks = vi.hoisted(() => ({
  resolveAcpSessionAvailability: vi.fn<ResolveAcpSessionAvailability>(() => ({ available: true })),
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  resolveAcpSessionAvailability: acpRuntimeMocks.resolveAcpSessionAvailability,
}));

vi.mock("openclaw/plugin-sdk/node-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/node-host")>();
  return {
    ...actual,
    runNodePtyCommand: nodeHostMocks.runNodePtyCommand,
    resolveNodeHostExecutable: (
      command: string,
      options: {
        env?: NodeJS.ProcessEnv;
        pathEnv?: string;
        includeExtensionless?: boolean;
      },
    ) => {
      const env = options.env ?? process.env;
      return actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv: options.pathEnv ?? env.PATH ?? env.Path ?? "",
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
    },
  };
});

import { registerPiSessionCatalog } from "./pi-session-catalog-plugin.js";
import { listLocalPiSessionPage, readLocalPiTranscriptPage } from "./pi-session-catalog.js";
import {
  capturePiContinuationCatalog,
  createPiStoreFixture,
  installFakePiFixture,
  registerPiNodeHostCommands,
} from "./pi-session-catalog.test-support.js";
import { listPiSummaryPage } from "./pi-session-store.js";

const PI_SESSIONS_LIST_COMMAND = "acpx.pi.sessions.list.v1";
const PI_SESSION_READ_COMMAND = "acpx.pi.sessions.read.v1";
const PI_TERMINAL_RESUME_COMMAND = "acpx.pi.terminal.resume.v1";

const temporaryDirectories: string[] = [];
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPath = process.env.PATH;

const createPiStore = (
  assistantText = "hi",
  sessionName = "Pi catalog session",
  toolArguments: unknown = { command: "pwd" },
  acpResolvable = false,
) =>
  createPiStoreFixture(
    temporaryDirectories,
    assistantText,
    sessionName,
    toolArguments,
    acpResolvable,
  );
const installFakePi = () => installFakePiFixture(temporaryDirectories, originalPath);

afterEach(async () => {
  acpRuntimeMocks.resolveAcpSessionAvailability.mockReset().mockReturnValue({ available: true });
  nodeHostMocks.runNodePtyCommand.mockClear();
  process.env.PATH = originalPath;
  if (originalSessionDir === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Pi session catalog", () => {
  it("lists named sessions and reads the active JSONL branch", async () => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, true);
    await installFakePi();
    const listed = await listLocalPiSessionPage({ limit: 20 });
    expect(listed).toEqual({
      sessions: [
        expect.objectContaining({
          threadId: "pi-session",
          name: "Pi catalog session",
          cwd: "/workspace",
          source: "pi-cli",
          canContinue: true,
        }),
      ],
    });

    const transcript = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 });
    expect(transcript.items.map((item) => [item.type, item.text])).toEqual([
      ["userMessage", "hello"],
      ["reasoning", "thinking"],
      ["agentMessage", "hi"],
      ["toolCall", 'bash\n{"command":"pwd"}'],
      ["toolResult", "bash\n/workspace"],
    ]);
    const itemIds = transcript.items.flatMap((item) => (item.id ? [item.id] : []));
    expect(new Set(itemIds).size).toBe(itemIds.length);

    const latest = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 2 });
    expect(latest.items.map((item) => item.type)).toEqual(["toolCall", "toolResult"]);
    expect(latest.nextCursor).toBeTruthy();
    const older = await readLocalPiTranscriptPage({
      threadId: "pi-session",
      limit: 2,
      cursor: latest.nextCursor,
    });
    expect(older.items.map((item) => item.type)).toEqual(["reasoning", "agentMessage"]);
    const nonEmitted = Buffer.from(JSON.stringify({ offset: 2, extra: true }), "utf8").toString(
      "base64url",
    );
    const unsafeOffset = Buffer.from(
      JSON.stringify({ offset: Number.MAX_SAFE_INTEGER + 1 }),
      "utf8",
    ).toString("base64url");
    for (const cursor of [
      `${latest.nextCursor}$`,
      `${latest.nextCursor}=`,
      ` ${latest.nextCursor} `,
      nonEmitted,
      unsafeOffset,
    ]) {
      await expect(
        readLocalPiTranscriptPage({
          threadId: "pi-session",
          cursor,
        }),
      ).rejects.toThrow("cursor is invalid");
    }
    await expect(listLocalPiSessionPage({ cursor: " " })).rejects.toThrow("cursor is invalid");
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-session", cursor: 123 }),
    ).rejects.toThrow("cursor is invalid");

    let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
    registerPiSessionCatalog({
      pluginConfig: {},
      runtime: { nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) } },
      registerSessionCatalog: (value: NonNullable<typeof provider>) => {
        provider = value;
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi);
    await expect(
      provider!.read({ hostId: "gateway", threadId: "pi-session", limit: 2 }),
    ).resolves.toMatchObject({ threadId: "pi-session", items: expect.any(Array) });
    await expect(provider!.list({})).resolves.toEqual([
      expect.objectContaining({ hostId: "gateway", sessions: [expect.any(Object)] }),
    ]);
  });

  it("recognizes Pi sessions when the agent directory uses a symlinked path", async () => {
    const sessionDirectory = await createPiStore();
    const agentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-agent-real-"));
    const symlinkParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-agent-link-"));
    const linkedAgentDirectory = path.join(symlinkParent, "agent");
    temporaryDirectories.push(agentDirectory, symlinkParent);
    await fs.mkdir(path.join(agentDirectory, "sessions"), { recursive: true });
    await fs.rename(sessionDirectory, path.join(agentDirectory, "sessions", "project"));
    await fs.symlink(
      agentDirectory,
      linkedAgentDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDirectory, "sessions", "project");
    process.env.PI_CODING_AGENT_DIR = linkedAgentDirectory;

    await expect(listLocalPiSessionPage({ limit: 20 })).resolves.toEqual({
      sessions: [expect.objectContaining({ threadId: "pi-session", canContinue: true })],
    });
  });

  it("refreshes cached continuation eligibility without mutating prior summaries", async () => {
    const sessionDirectory = await createPiStore(
      "hi",
      "Pi catalog session",
      { command: "pwd" },
      true,
    );
    const agentDirectory = path.dirname(path.dirname(sessionDirectory));
    const unrelatedAgentDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-pi-agent-unrelated-"),
    );
    temporaryDirectories.push(unrelatedAgentDirectory);
    const baseEnv = {
      ...process.env,
      PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
      PI_CODING_AGENT_DIR: agentDirectory,
    };

    const first = await listPiSummaryPage(baseEnv, { offset: 0, limit: 20 });
    const firstSummary = first.summaries[0];
    expect(firstSummary?.canContinue).toBe(true);

    const second = await listPiSummaryPage(
      { ...baseEnv, PI_CODING_AGENT_DIR: unrelatedAgentDirectory },
      { offset: 0, limit: 20 },
    );
    expect(second.summaries[0]?.canContinue).toBe(false);
    expect(second.summaries[0]).not.toBe(firstSummary);
    expect(firstSummary?.canContinue).toBe(true);

    const third = await listPiSummaryPage(baseEnv, { offset: 0, limit: 20 });
    expect(third.summaries[0]?.canContinue).toBe(true);
    expect(firstSummary?.canContinue).toBe(true);
  });

  it("summarizes and pages a large session within transport limits", async () => {
    await createPiStore("x".repeat(600 * 1024));
    const listed = await listLocalPiSessionPage({ limit: 20 });
    expect(listed.sessions[0]?.name).toBe("Pi catalog session");
    const transcript = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 });
    const answer = transcript.items.find((item) => item.type === "agentMessage");
    expect(answer?.text?.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(transcript), "utf8")).toBeLessThan(20 * 1024 * 1024);
  });

  it("keeps truncated tool arguments on a valid UTF-16 boundary", async () => {
    await createPiStore("hi", "Pi catalog session", {
      value: `${"x".repeat(19_989)}🎉`,
    });
    const transcript = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 });
    const toolCall = transcript.items.find((item) => item.type === "toolCall");

    expect(toolCall?.text).toMatch(/…$/u);
    expect(toolCall?.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("reads legacy linear sessions and visible extended messages", async () => {
    const directory = await createPiStore();
    const entries = [
      {
        type: "session",
        version: 1,
        id: "pi-session",
        timestamp: "2026-07-13T10:00:00Z",
        cwd: "/workspace",
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:01Z",
        message: { role: "user", content: "legacy hello" },
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:02Z",
        message: {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        },
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:03Z",
        message: { role: "bashExecution", command: "pwd", output: "/workspace", exitCode: 0 },
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:04Z",
        message: { role: "custom", customType: "review", content: "visible note", display: true },
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:05Z",
        message: {
          role: "hookMessage",
          customType: "legacy-review",
          content: "legacy visible note",
          display: true,
        },
      },
    ];
    await fs.writeFile(
      path.join(directory, "session.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const transcript = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 });
    expect(transcript.items.map((item) => [item.type, item.text])).toEqual([
      ["userMessage", "legacy hello"],
      ["userMessage", "[image: image/png]"],
      ["toolCall", "bash\npwd"],
      ["toolResult", "/workspace"],
      ["other", "review\nvisible note"],
      ["other", "legacy-review\nlegacy visible note"],
    ]);
  });

  it("resolves names anywhere in the file and honors a later clear", async () => {
    const directory = await createPiStore();
    const file = path.join(directory, "session.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "pi-session",
        timestamp: "2026-07-13T10:00:00Z",
        cwd: "/workspace",
      },
      {
        type: "message",
        id: "u",
        parentId: null,
        timestamp: "2026-07-13T10:00:01Z",
        message: { role: "user", content: "fallback title" },
      },
      {
        type: "session_info",
        id: "n",
        parentId: "u",
        timestamp: "2026-07-13T10:00:02Z",
        name: "Assigned title",
      },
      {
        type: "message",
        id: "a",
        parentId: "n",
        timestamp: "2026-07-13T10:00:03Z",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(40 * 1024) }] },
      },
    ];
    await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.name).toBe("Assigned title");

    await fs.appendFile(
      file,
      `${JSON.stringify({ type: "session_info", id: "clear", parentId: "a", timestamp: "2026-07-13T10:00:04Z", name: "" })}\n`,
    );
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.name).toBe("fallback title");
  });

  it("indexes final records without a trailing newline", async () => {
    const directory = await createPiStore();
    const file = path.join(directory, "session.jsonl");
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-session",
        timestamp: "2026-07-13T10:00:00Z",
        cwd: "/workspace",
      }),
    );
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.threadId).toBe("pi-session");

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "session_info",
        id: "name",
        parentId: null,
        timestamp: "2026-07-13T10:00:01Z",
        name: "No final newline",
      })}`,
    );
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.name).toBe(
      "No final newline",
    );
  });

  it("rebuilds metadata after a same-file replacement grows", async () => {
    const directory = await createPiStore("old session");
    const file = path.join(directory, "session.jsonl");
    await listLocalPiSessionPage({ limit: 20 });

    const entries = [
      {
        type: "session",
        version: 3,
        id: "pi-replaced-session",
        timestamp: "2026-07-13T11:00:00Z",
        cwd: "/workspace/replaced",
      },
      {
        type: "message",
        id: "replacement-user",
        parentId: null,
        timestamp: "2026-07-13T11:00:01Z",
        message: { role: "user", content: `replacement ${"x".repeat(4_096)}` },
      },
      {
        type: "session_info",
        id: "replacement-name",
        parentId: "replacement-user",
        timestamp: "2026-07-13T11:00:02Z",
        name: "Replacement session",
      },
    ];
    await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    await expect(listLocalPiSessionPage({ limit: 20 })).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          threadId: "pi-replaced-session",
          name: "Replacement session",
          cwd: "/workspace/replaced",
        }),
      ],
    });
  });

  it("does not reuse transcript paths after the configured store changes", async () => {
    await createPiStore("old store");
    await listLocalPiSessionPage({ limit: 20 });
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ text: "old store" })]),
    });

    await createPiStore("new store");
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ text: "new store" })]),
    });
  });

  it("paginates, searches, and reads beyond the newest summary batch", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-catalog-"));
    temporaryDirectories.push(directory);
    process.env.PI_CODING_AGENT_SESSION_DIR = directory;
    const baseTime = Date.parse("2026-07-13T10:00:00Z") / 1_000;
    await Promise.all(
      Array.from({ length: 105 }, async (_, index) => {
        const file = path.join(directory, `session-${String(index)}.jsonl`);
        const entries = [
          {
            type: "session",
            version: 3,
            id: `pi-session-${String(index)}`,
            timestamp: "2026-07-13T10:00:00Z",
            cwd: "/workspace",
          },
          {
            type: "session_info",
            id: `info-${String(index)}`,
            parentId: null,
            timestamp: "2026-07-13T10:00:01Z",
            name: `Pi history ${String(index)}`,
          },
        ];
        await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
        await fs.utimes(file, baseTime + index, baseTime + index);
      }),
    );

    const first = await listLocalPiSessionPage({ limit: 100 });
    expect(first.sessions).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = await listLocalPiSessionPage({ limit: 100, cursor: first.nextCursor });
    expect(second.sessions).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      listLocalPiSessionPage({ limit: 20, searchTerm: "Pi history 0" }),
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "pi-session-0" })],
    });
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-session-0", limit: 20 }),
    ).resolves.toMatchObject({ threadId: "pi-session-0" });
  });

  it("uses the configured Pi session directory and lists oversized sessions", async () => {
    const agentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-agent-"));
    const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-home-"));
    temporaryDirectories.push(agentDirectory, homeDirectory);
    const sessionDirectory = path.join(homeDirectory, "custom-sessions");
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(agentDirectory, "settings.json"),
      `${JSON.stringify({ sessionDir: "~/custom-sessions" })}\n`,
    );
    const file = path.join(sessionDirectory, "large.jsonl");
    await fs.writeFile(
      file,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-large-session",
        timestamp: "2026-07-13T10:00:00Z",
        cwd: "/workspace",
      })}\n`,
    );
    const middle = await fs.open(file, "r+");
    await middle.truncate(2 * 1024 * 1024);
    await middle.close();
    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "session_info",
        id: "large-info",
        parentId: null,
        timestamp: "2026-07-13T10:00:01Z",
        name: "Pi large session",
      })}\n`,
    );
    const handle = await fs.open(file, "r+");
    await handle.truncate(33 * 1024 * 1024);
    await handle.close();
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    process.env.HOME = homeDirectory;
    process.env.USERPROFILE = homeDirectory;

    await expect(listLocalPiSessionPage({ limit: 20 })).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({ threadId: "pi-large-session", name: "Pi large session" }),
      ],
    });
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-large-session", limit: 20 }),
    ).rejects.toThrow("32 MiB read safety limit");

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "session_info",
        id: "large-clear",
        parentId: "large-info",
        timestamp: "2026-07-13T10:00:02Z",
        name: "",
      })}\n`,
    );
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.name).toBeUndefined();
  });

  it("auto-detects the store and honors the node-local Web UI switch", async () => {
    const directory = await createPiStore();
    const binDirectory = await installFakePi();
    const commands = registerPiNodeHostCommands();
    expect(commands.map((command) => command.command)).toEqual([
      PI_SESSIONS_LIST_COMMAND,
      PI_SESSION_READ_COMMAND,
      PI_TERMINAL_RESUME_COMMAND,
    ]);
    expect(
      commands.every((command) =>
        command.isAvailable?.({
          config: {},
          env: { PI_CODING_AGENT_SESSION_DIR: directory, PATH: binDirectory },
        } as never),
      ),
    ).toBe(true);
    expect(
      commands.every((command) =>
        command.isAvailable?.({
          config: {
            plugins: { entries: { acpx: { config: { piSessionCatalog: { enabled: false } } } } },
          },
          env: { PI_CODING_AGENT_SESSION_DIR: directory, PATH: binDirectory },
        } as never),
      ),
    ).toBe(false);
    expect(
      commands.every((command) =>
        command.isAvailable?.({
          config: {},
          env: { PI_CODING_AGENT_SESSION_DIR: path.join(directory, "missing") },
        } as never),
      ),
    ).toBe(false);
    expect(
      commands.every((command) =>
        command.isAvailable?.({
          config: {},
          env: { PI_CODING_AGENT_SESSION_DIR: ".pi/sessions" },
        } as never),
      ),
    ).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "opens validated local Pi sessions with the upstream terminal resume contract",
    async () => {
      await createPiStore();
      await installFakePi();
      let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
      const commands: Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0][] = [];
      registerPiSessionCatalog({
        pluginConfig: {},
        runtime: { nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) } },
        registerSessionCatalog: (value: NonNullable<typeof provider>) => {
          provider = value;
        },
        registerNodeHostCommand: (
          command: Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0],
        ) => commands.push(command),
        registerNodeInvokePolicy: vi.fn(),
      } as unknown as OpenClawPluginApi);

      await expect(provider!.list({ hostIds: ["gateway"] })).resolves.toEqual([
        expect.objectContaining({
          sessions: [expect.objectContaining({ threadId: "pi-session", canOpenTerminal: true })],
        }),
      ]);
      await expect(
        provider!.openTerminal!({ hostId: "gateway", threadId: "pi-session" }),
      ).resolves.toEqual({
        kind: "local",
        argv: [expect.stringMatching(/pi$/u), "--session", "pi-session"],
        cwd: "/workspace",
        title: "pi --session pi-session…",
      });
      await expect(
        provider!.openTerminal!({ hostId: "gateway", threadId: "missing" }),
      ).rejects.toThrow("Pi session is unavailable");

      const terminal = commands.find((command) => command.command === PI_TERMINAL_RESUME_COMMAND)!;
      const io = {
        signal: new AbortController().signal,
        onInput: vi.fn(),
        emitChunk: vi.fn(),
      };
      await expect(
        terminal.handle?.(
          JSON.stringify({ threadId: "pi-session", cols: 100, rows: 30 }),
          io as never,
        ),
      ).resolves.toBe(JSON.stringify({ exitCode: 0 }));
      expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
        {
          file: expect.stringMatching(/pi$/u),
          args: ["--session", "pi-session"],
          cwd: "/workspace",
          cols: 100,
          rows: 30,
        },
        io,
      );
      await expect(
        terminal.handle?.(JSON.stringify({ threadId: "--help", cols: 100, rows: 30 }), io as never),
      ).rejects.toThrow("threadId is invalid");
    },
  );

  it("adopts local Pi sessions once with the native ACP resume binding", async () => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, true);
    await installFakePi();
    const { createSessionEntry, provider } = capturePiContinuationCatalog();

    const [first, concurrent] = await Promise.all([
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ]);
    const second = await provider.continueSession!({
      hostId: "gateway",
      threadId: "pi-session",
    });

    expect(first).toEqual(concurrent);
    expect(second).toEqual(first);
    expect(createSessionEntry).toHaveBeenCalledTimes(1);
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Pi catalog session",
        spawnedCwd: "/workspace",
        initialEntry: {
          acpBackendId: "acpx",
          acpSessionBinding: { acpAgentId: "pi", agentSessionId: "pi-session" },
          pluginExtensions: {
            acpx: { piSessionCatalog: { sourceThreadId: "pi-session" } },
          },
        },
      }),
    );
  });

  it("rejects paired-node and unknown Pi session continuation", async () => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, true);
    await installFakePi();
    const { createSessionEntry, provider } = capturePiContinuationCatalog();

    await expect(
      provider.continueSession!({ hostId: "node:remote", threadId: "pi-session" }),
    ).rejects.toThrow("paired-node Pi session rows are view-only");
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "missing" }),
    ).rejects.toThrow("Pi session is unavailable");
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("hides and rejects Continue when ACP cannot resume Pi", async () => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, true);
    await installFakePi();
    acpRuntimeMocks.resolveAcpSessionAvailability.mockReturnValue({
      available: false,
      message: "ACP is disabled by policy",
    });
    const { provider } = capturePiContinuationCatalog();

    await expect(provider.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "pi-session", canContinue: false })],
      }),
    ]);
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ).rejects.toThrow("ACP is disabled by policy");
  });

  it("keeps custom Pi stores browse-only when pi-acp cannot resolve them", async () => {
    await createPiStore();
    await installFakePi();
    const { provider } = capturePiContinuationCatalog();

    await expect(provider.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "pi-session", canContinue: false })],
      }),
    ]);
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ).rejects.toThrow("outside the session store supported by pi-acp");
  });

  it("hides and rejects Continue when the Pi CLI is unavailable", async () => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, true);
    process.env.PATH = "";
    const { provider } = capturePiContinuationCatalog();

    await expect(provider.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "pi-session", canContinue: false })],
      }),
    ]);
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ).rejects.toThrow("Pi CLI is unavailable");
  });

  it("opens paired-node Pi sessions only through the advertised terminal command", async () => {
    let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
    const page = {
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "pi-remote",
            cwd: "/remote/workspace",
            status: "stored",
            archived: false,
            canContinue: true,
            canArchive: false,
          },
        ],
      }),
    };
    const invoke = vi.fn().mockResolvedValue(page);
    registerPiSessionCatalog({
      pluginConfig: {},
      runtime: {
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: [
              {
                nodeId: "node-1",
                connected: true,
                commands: [PI_SESSIONS_LIST_COMMAND, PI_TERMINAL_RESUME_COMMAND],
              },
            ],
          }),
          invoke,
        },
      },
      registerSessionCatalog: (value: NonNullable<typeof provider>) => {
        provider = value;
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi);

    await expect(provider!.list({ hostIds: ["node:node-1"], search: "remote" })).resolves.toEqual([
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            threadId: "pi-remote",
            canContinue: false,
            canOpenTerminal: true,
          }),
        ],
      }),
    ]);
    expect(invoke).toHaveBeenNthCalledWith(1, {
      nodeId: "node-1",
      command: PI_SESSIONS_LIST_COMMAND,
      params: { searchTerm: "remote" },
      timeoutMs: 20_000,
      scopes: ["operator.write"],
    });
    await expect(
      provider!.openTerminal!({ hostId: "node:node-1", threadId: "pi-remote" }),
    ).resolves.toEqual({
      kind: "node",
      nodeId: "node-1",
      command: PI_TERMINAL_RESUME_COMMAND,
      paramsJSON: JSON.stringify({ threadId: "pi-remote" }),
      cwd: "/remote/workspace",
      title: "pi --session pi-remote…",
    });
    expect(invoke).toHaveBeenLastCalledWith({
      nodeId: "node-1",
      command: PI_SESSIONS_LIST_COMMAND,
      params: { searchTerm: "pi-remote", limit: 100 },
      timeoutMs: 20_000,
      scopes: ["operator.write"],
    });
  });

  it("does not register the catalog when explicitly disabled", () => {
    const registerSessionCatalog = vi.fn();
    const api = {
      pluginConfig: { piSessionCatalog: { enabled: false } },
      registerSessionCatalog,
    } as unknown as OpenClawPluginApi;
    registerPiSessionCatalog(api);
    expect(registerSessionCatalog).not.toHaveBeenCalled();
  });

  it("bridges paired-node list and read requests without undefined transport fields", async () => {
    let provider: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0] | undefined;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        payloadJSON: JSON.stringify({
          sessions: [
            {
              threadId: "pi-remote",
              status: "stored",
              source: "pi-cli",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        payloadJSON: JSON.stringify({
          threadId: "pi-remote",
          items: [{ type: "agentMessage", text: "remote answer" }],
        }),
      });
    const api = {
      pluginConfig: {},
      runtime: {
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: [
              {
                nodeId: "node-1",
                displayName: "Remote",
                connected: true,
                commands: [PI_SESSIONS_LIST_COMMAND, PI_SESSION_READ_COMMAND],
              },
            ],
          }),
          invoke,
        },
      },
      registerSessionCatalog: (value: NonNullable<typeof provider>) => {
        provider = value;
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi;

    registerPiSessionCatalog(api);
    const catalog = provider;
    expect(catalog).toBeDefined();
    await catalog!.list({ hostIds: ["node:node-1"] });
    await catalog!.read({ hostId: "node:node-1", threadId: "pi-remote" });

    expect(invoke).toHaveBeenNthCalledWith(1, {
      nodeId: "node-1",
      command: PI_SESSIONS_LIST_COMMAND,
      params: {},
      timeoutMs: 20_000,
      scopes: ["operator.write"],
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      nodeId: "node-1",
      command: PI_SESSION_READ_COMMAND,
      params: { threadId: "pi-remote" },
      timeoutMs: 20_000,
      scopes: ["operator.write"],
    });

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: 123,
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      }),
    });
    await expect(catalog!.list({ hostIds: ["node:node-1"] })).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "--help",
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      }),
    });
    await expect(catalog!.list({ hostIds: ["node:node-1"] })).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        threadId: "pi-remote",
        items: [{ type: "invalid", text: "bad" }],
      }),
    });
    await expect(catalog!.read({ hostId: "node:node-1", threadId: "pi-remote" })).rejects.toThrow(
      "invalid transcript page",
    );

    invoke.mockClear();
    await expect(
      catalog!.read({ hostId: "node:node-1", threadId: "pi-remote", cursor: "" }),
    ).rejects.toThrow("cursor is invalid");
    await expect(
      catalog!.list({
        hostIds: ["node:node-1"],
        cursors: { "node:node-1": "" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({ sessions: [], nextCursor: " wrapped " }),
    });
    await expect(catalog!.list({ hostIds: ["node:node-1"] })).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);
    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        threadId: "pi-remote",
        items: [],
        nextCursor: " wrapped ",
      }),
    });
    await expect(catalog!.read({ hostId: "node:node-1", threadId: "pi-remote" })).rejects.toThrow(
      "invalid cursor",
    );

    const exactCursor = Buffer.from(JSON.stringify({ offset: 1 }), "utf8").toString("base64url");
    invoke.mockResolvedValueOnce({ payloadJSON: JSON.stringify({ sessions: [] }) });
    await catalog!.list({
      hostIds: ["node:node-1"],
      cursors: { "node:node-1": exactCursor },
    });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { cursor: exactCursor } }),
    );
    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({ threadId: "pi-remote", items: [] }),
    });
    await catalog!.read({
      hostId: "node:node-1",
      threadId: "pi-remote",
      cursor: exactCursor,
    });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { threadId: "pi-remote", cursor: exactCursor } }),
    );
  });
});
