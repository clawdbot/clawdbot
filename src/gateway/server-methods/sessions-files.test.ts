// Session file method tests cover transcript-linked files plus the workspace browser.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenPathCommand } from "./open-path.js";
import { resolveLocalSessionWorkspaceRoot, sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  hashContent,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
  writeWorkspaceFile,
} from "./sessions-files.test-support.js";
import { updateWorkspaceFile } from "./workspace-fs.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: hoisted.execOpenPath };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readSessionTranscriptVisibleMessageDeltaCore:
      hoisted.readSessionTranscriptVisibleMessageDeltaCore,
  };
});

const invokeSessionFilesHandler = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const mockVisibleMessages = createVisibleMessagesMock(
  hoisted.readSessionTranscriptVisibleMessageDeltaCore,
);

describe("sessions.files RPC handlers", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
  });

  afterEach(() => {
    removeWorkspaceFixture(workspaceRoot);
  });

  it("reveals the same workspace root returned by sessions.files.list", async () => {
    const listPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );
    const revealPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.reveal", {
        key: "agent:main:main",
      }),
    );

    expect(revealPayload).toEqual({ ok: true, path: listPayload.root });
    // Compare against the resolver's own output so the assertion holds on
    // every supported platform (open / xdg-open / PowerShell Start-Process).
    expect(hoisted.execOpenPath).toHaveBeenCalledWith(
      resolveOpenPathCommand(listPayload.root as string),
    );
  });

  it("uses the persisted fixed-store owner for a bare session workspace", async () => {
    const cfg = {
      session: { store: path.join(workspaceRoot, "shared.sqlite"), scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as const;
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "ops",
      canonicalKey: "global",
      cfg,
      storePath: cfg.session.store,
      entry: { sessionId: "sess-owned-global" },
    });
    hoisted.resolveAgentWorkspaceDir.mockImplementation((_cfg: unknown, agentId: string) =>
      agentId === "ops" ? workspaceRoot : path.join(workspaceRoot, "wrong-research"),
    );

    const payload = expectOkPayload(
      await invokeSessionFilesHandler(
        "sessions.files.list",
        { sessionKey: "global" },
        { getRuntimeConfig: () => cfg },
      ),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(hoisted.readSessionTranscriptVisibleMessageDeltaCore).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops", sessionKey: "global" }),
      expect.any(Object),
    );
  });

  it("rejects a foreign agent before a bare fixed-store workspace write", async () => {
    const cfg = {
      session: { store: path.join(workspaceRoot, "shared.sqlite"), scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as const;

    const error = expectError(
      await invokeSessionFilesHandler(
        "sessions.files.set",
        {
          sessionKey: "global",
          agentId: "research",
          path: "ui/chat.ts",
          content: "foreign write\n",
          expectedHash: hashContent("export const chat = true;\n"),
        },
        { getRuntimeConfig: () => cfg },
      ),
    );

    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'agent "research" does not match session key agent "ops"',
    });
    expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(workspaceRoot, "ui/chat.ts"), "utf8")).toBe(
      "export const chat = true;\n",
    );
  });

  it("refuses to reveal a remote session workspace", async () => {
    const payload = expectOkPayload(
      await invokeSessionFilesHandler(
        "sessions.files.reveal",
        { key: "agent:main:main" },
        {
          workerSessionPlacementService: {
            getMany: () => new Map([["sess-main", { state: "active" }]]),
          },
        },
      ),
    );

    expect(payload).toMatchObject({ ok: false, path: workspaceRoot });
    expect(payload.error).toContain("runs remotely");
    expect(hoisted.execOpenPath).not.toHaveBeenCalled();
  });

  it("refuses to reveal an exec-node session workspace", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        spawnedCwd: workspaceRoot,
        execNode: "build-mac",
      },
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.reveal", { key: "agent:main:main" }),
    );

    expect(payload).toMatchObject({ ok: false, path: workspaceRoot });
    expect(payload.error).toContain("exec node");
    expect(hoisted.execOpenPath).not.toHaveBeenCalled();
  });

  it("withholds the workspace root of an exec-node session", () => {
    // Workspace identity surfaces read this root. An exec-node session's
    // directory lives on another host, while the precedence below it falls back
    // to the local agent workspace — handing that back would name this machine.
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "sess-main.jsonl", execNode: "build-mac" },
    });
    expect(resolveLocalSessionWorkspaceRoot({ sessionKey: "agent:main:main" })).toBeUndefined();

    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "sess-main.jsonl", spawnedCwd: workspaceRoot },
    });
    expect(resolveLocalSessionWorkspaceRoot({ sessionKey: "agent:main:main" })).toBe(workspaceRoot);
  });

  it("refuses to reveal when the session has no workspace root", async () => {
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(undefined);
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "sess-main.jsonl" },
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.reveal", { key: "agent:main:main" }),
    );

    expect(payload).toEqual({
      ok: false,
      error: "No workspace root is available for this session.",
    });
    expect(hoisted.execOpenPath).not.toHaveBeenCalled();
  });

  it("returns opener failures as successful RPC results", async () => {
    const warn = vi.fn();
    hoisted.execOpenPath.mockRejectedValueOnce(new Error("xdg-open: no method available"));

    const payload = expectOkPayload(
      await invokeSessionFilesHandler(
        "sessions.files.reveal",
        { key: "agent:main:main" },
        { logGateway: { warn } },
      ),
    );

    expect(payload).toMatchObject({ ok: false, path: workspaceRoot });
    expect(payload.error).toContain("headless environment");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("sessions.files.reveal failed path="),
    );
  });

  it("prefers the spawned workspace root over a nested spawned cwd", async () => {
    const nestedCwd = path.join(workspaceRoot, "packages/app");
    fs.mkdirSync(nestedCwd, { recursive: true });
    writeWorkspaceFile(workspaceRoot, "packages/app/src/readme.md", "# Nested read me\n");
    writeWorkspaceFile(workspaceRoot, "packages/shared/config.ts", "export const shared = true;\n");
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        spawnedCwd: nestedCwd,
        spawnedWorkspaceDir: workspaceRoot,
      },
    });
    mockVisibleMessages([
      assistantToolCall("read", { path: "src/readme.md" }),
      assistantToolCall("read", { path: "../shared/config.ts" }),
    ]);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files).toEqual([
      expect.objectContaining({
        missing: false,
        path: "../shared/config.ts",
      }),
      expect.objectContaining({
        missing: false,
        path: "src/readme.md",
      }),
    ]);
    expect(
      payload.browser.entries.map((entry: Record<string, unknown>) => [
        entry.path,
        entry.kind,
        entry.sessionKind,
      ]),
    ).toEqual([
      ["packages", "directory", "read"],
      ["src", "directory", undefined],
      ["ui", "directory", undefined],
      ["package.json", "file", undefined],
    ]);

    const preview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "src/readme.md",
      }),
    );
    expect(preview.file.content).toBe("# Nested read me\n");
    expect(preview.file.workspacePath).toBe("packages/app/src/readme.md");

    const workspaceRootPreview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: path.join(workspaceRoot, "src/readme.md"),
      }),
    );
    expect(workspaceRootPreview.file.content).toBe("# Read me\n");
    expect(workspaceRootPreview.file.workspacePath).toBe("src/readme.md");

    const browserPreview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "packages/app/src/readme.md",
      }),
    );
    expect(browserPreview.file.content).toBe("# Nested read me\n");

    const aliasedPreview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "packages//app/src/readme.md",
      }),
    );
    expect(aliasedPreview.file.workspacePath).toBe("packages/app/src/readme.md");

    const parentRelativePreview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "../shared/config.ts",
      }),
    );
    expect(parentRelativePreview.file.content).toBe("export const shared = true;\n");

    const parentRelativeBrowserPreview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "packages/shared/config.ts",
      }),
    );
    expect(parentRelativeBrowserPreview.file.content).toBe("export const shared = true;\n");
  });

  it("falls back to the configured agent workspace for sessions without spawned metadata", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
      },
    });
    mockVisibleMessages([assistantToolCall("read", { path: "src/readme.md" })]);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(hoisted.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.any(Object), "main");
    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files).toEqual([
      expect.objectContaining({
        missing: false,
        path: "src/readme.md",
      }),
    ]);
    expect(payload.browser).toBeDefined();
  });

  it("uses the canonical session owner for configured workspace fallback", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:aiden:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
      },
    });
    mockVisibleMessages([assistantToolCall("read", { path: "src/readme.md" })]);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(hoisted.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.any(Object), "aiden");
    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files).toEqual([
      expect.objectContaining({
        missing: false,
        path: "src/readme.md",
      }),
    ]);
  });

  it("round-trips listed folders beginning with two dots", async () => {
    writeWorkspaceFile(workspaceRoot, "..notes/readme.md", "# Notes\n");
    const root = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );
    const selected = root.browser.entries.find(
      (entry: Record<string, unknown>) => entry.name === "..notes",
    );
    const folder = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        path: selected.path,
      }),
    );
    expect(folder.browser).toMatchObject({
      path: "..notes",
      parentPath: "",
      entries: [{ path: "..notes/readme.md", kind: "file" }],
    });
    const preview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: folder.browser.entries[0].path,
      }),
    );
    expect(preview.file.content).toBe("# Notes\n");
  });

  it("browses, searches, and previews files not referenced by the session", async () => {
    const folderPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        path: "ui",
      }),
    );

    expect(folderPayload.browser.parentPath).toBe("");
    expect(
      folderPayload.browser.entries.map((entry: Record<string, unknown>) => [
        entry.path,
        entry.kind,
        entry.sessionKind,
      ]),
    ).toEqual([
      ["ui/chat.ts", "file", "modified"],
      ["ui/vite.config.ts", "file", undefined],
    ]);

    const searchPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        search: "vite",
      }),
    );

    expect(searchPayload.browser.search).toBe("vite");
    expect(
      searchPayload.browser.entries.map((entry: Record<string, unknown>) => entry.path),
    ).toEqual(["ui/vite.config.ts"]);

    const preview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
      }),
    );

    expect(preview.file).toMatchObject({
      content: "export default {};\n",
      contentEncoding: "utf8",
      hash: hashContent("export default {};\n"),
      kind: "read",
      mimeType: "text/plain",
      missing: false,
      path: "ui/vite.config.ts",
      previewKind: "text",
    });
  });

  it("truncates broad workspace searches by visited entries, not only by matches", async () => {
    for (let index = 0; index < 5_025; index += 1) {
      writeWorkspaceFile(workspaceRoot, `bulk-${String(index).padStart(4, "0")}.txt`, "");
    }
    writeWorkspaceFile(workspaceRoot, "zz-tail-needle.ts", "export const needle = true;\n");

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        search: "needle",
      }),
    );

    expect(payload.browser).toMatchObject({
      search: "needle",
      truncated: true,
    });
    expect(payload.browser.entries).toEqual([]);
  });

  it("does not read absolute or parent-relative paths outside the configured workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "missing-session.jsonl",
      },
    });
    mockVisibleMessages([assistantToolCall("read", { path: outsidePath })]);

    try {
      for (const requestedPath of [outsidePath, "../outside.txt"]) {
        const error = expectError(
          await invokeSessionFilesHandler("sessions.files.get", {
            sessionKey: "agent:main:main",
            path: requestedPath,
          }),
        );

        expect(error.details).toMatchObject({
          path: requestedPath,
          type: "session_file_not_found",
        });
      }
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it("does not follow workspace symlinks for file previews", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-linked-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, "linked outside\n", "utf8");
    fs.symlinkSync(outsidePath, path.join(workspaceRoot, "linked.txt"));

    try {
      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: "linked.txt",
        }),
      );

      expect(error.details).toMatchObject({
        path: "linked.txt",
        type: "session_file_not_found",
      });
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it("does not follow symlinked parent directories for file previews", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linked-parent-"));
    writeWorkspaceFile(outsideDir, "secret.txt", "linked parent outside\n");
    fs.symlinkSync(outsideDir, path.join(workspaceRoot, "linked-dir"), "dir");

    try {
      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: "linked-dir/secret.txt",
        }),
      );

      expect(error.details).toMatchObject({
        path: "linked-dir/secret.txt",
        type: "session_file_not_found",
      });
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("returns integer file timestamps for protocol responses", async () => {
    const datedPath = path.join(workspaceRoot, "dated.txt");
    writeWorkspaceFile(workspaceRoot, "dated.txt", "dated\n");
    fs.utimesSync(datedPath, 1_700_000_000.123, 1_700_000_000.123);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );
    const entry = payload.browser.entries.find(
      (browserEntry: Record<string, unknown>) => browserEntry.path === "dated.txt",
    );

    expect(Number.isInteger(entry.updatedAtMs)).toBe(true);
  });

  it("does not browse paths outside the session workspace root", async () => {
    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        path: "../",
      }),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.browser).toBeUndefined();
  });

  it("does not derive a workspace root from transcript cwd", async () => {
    const sessionsDir = path.join(workspaceRoot, "custom-sessions");
    const transcriptCwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-cwd-"));
    writeWorkspaceFile(transcriptCwd, "secret.txt", "transcript cwd secret\n");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sess-main.jsonl"),
      `${JSON.stringify({ cwd: transcriptCwd })}\n`,
      "utf8",
    );
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(sessionsDir, "sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
      },
    });
    mockVisibleMessages([assistantToolCall("read", { path: "secret.txt" })]);
    try {
      const listPayload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.files.list", {
          sessionKey: "agent:main:main",
        }),
      );

      expect(listPayload.root).toBe(workspaceRoot);
      expect(listPayload.browser).toBeDefined();
      expect(listPayload.files).toMatchObject([
        {
          missing: true,
          path: "secret.txt",
        },
      ]);

      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: "secret.txt",
        }),
      );
      expect(error.details).toMatchObject({
        path: "secret.txt",
        type: "session_file_not_found",
      });
    } finally {
      fs.rmSync(transcriptCwd, { recursive: true, force: true });
    }
  });

  it("reports oversized existing files without marking them missing", async () => {
    writeWorkspaceFile(workspaceRoot, "large.log", "x".repeat(260 * 1024));
    mockVisibleMessages([assistantToolCall("read", { path: "large.log" })]);

    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "large.log",
      }),
    );

    expect(error.details).toMatchObject({
      maxPreviewBytes: 256 * 1024,
      path: "large.log",
      size: 260 * 1024,
      type: "session_file_too_large",
    });
  });

  it.each([
    {
      name: "SQLite",
      mimeType: "application/x-sqlite3",
      bytes: Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(260 * 1024)]),
    },
    {
      name: "PNG",
      mimeType: "image/png",
      bytes: Buffer.concat([
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        ),
        Buffer.alloc(260 * 1024),
      ]),
    },
  ])("returns oversized $name files as bounded metadata", async (fixture) => {
    const fileName = `large-${fixture.name.toLowerCase()}.bin`;
    fs.writeFileSync(path.join(workspaceRoot, fileName), fixture.bytes);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: fileName,
      }),
    );

    expect(payload.file).toMatchObject({
      mimeType: fixture.mimeType,
      path: fileName,
      previewKind: "unsupported",
      size: fixture.bytes.length,
    });
    expect(payload.file.content).toBeUndefined();
    expect(payload.file.contentEncoding).toBeUndefined();
    expect(payload.file.hash).toBeUndefined();
  });

  it("overwrites an existing file when its hash matches", async () => {
    const original = "export default {};\n";
    const content = "export default { server: true };\n";

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
        content,
        expectedHash: hashContent(original),
      }),
    );

    expect(fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8")).toBe(content);
    expect(payload.file).toMatchObject({
      path: "ui/vite.config.ts",
      workspacePath: "ui/vite.config.ts",
      name: "vite.config.ts",
      kind: "modified",
      missing: false,
      size: Buffer.byteLength(content, "utf8"),
      hash: hashContent(content),
    });
    expect(Number.isInteger(payload.file.updatedAtMs)).toBe(true);
    expect(payload.file.content).toBeUndefined();
  });

  it("rejects a stale file hash with the current hash", async () => {
    const current = "export default {};\n";
    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
        content: "changed\n",
        expectedHash: hashContent("stale\n"),
      }),
    );

    expect(error.details).toEqual({
      type: "session_file_conflict",
      path: "ui/vite.config.ts",
      currentHash: hashContent(current),
    });
    expect(fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8")).toBe(current);
  });

  it("rejects malformed CAS hashes before reading the workspace", async () => {
    const calls = await invokeSessionFilesHandler("sessions.files.set", {
      sessionKey: "agent:main:main",
      path: "ui/vite.config.ts",
      content: "changed\n",
      expectedHash: "not-a-sha256",
    });

    expect(calls).toMatchObject([{ ok: false }]);
    expect(fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8")).toBe(
      "export default {};\n",
    );
  });

  it("allows only one concurrent save for the same expected hash", async () => {
    const original = "export default {};\n";
    const expectedHash = hashContent(original);
    const [first, second] = await Promise.all([
      invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
        content: "export default { first: true };\n",
        expectedHash,
      }),
      invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
        content: "export default { second: true };\n",
        expectedHash,
      }),
    ]);

    const calls = [first[0], second[0]];
    expect(calls.filter((call) => call?.ok)).toHaveLength(1);
    const conflict = calls.find((call) => !call?.ok)?.error as Record<string, any>;
    expect(conflict.details).toMatchObject({ type: "session_file_conflict" });
    const content = fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8");
    expect(["export default { first: true };\n", "export default { second: true };\n"]).toContain(
      content,
    );
    expect(conflict.details.currentHash).toBe(hashContent(content));
  });

  it("serializes concurrent saves across lexical aliases", async () => {
    const original = "export default {};\n";
    const expectedHash = hashContent(original);
    const results = await Promise.all([
      updateWorkspaceFile(
        workspaceRoot,
        "ui/vite.config.ts",
        "export default { first: true };\n",
        expectedHash,
      ),
      updateWorkspaceFile(
        workspaceRoot,
        "ui//vite.config.ts",
        "export default { second: true };\n",
        expectedHash,
      ),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["conflict", "updated"]);
  });

  it("serializes concurrent saves across nested workspace roots", async () => {
    const original = "export default {};\n";
    const expectedHash = hashContent(original);
    const results = await Promise.all([
      updateWorkspaceFile(
        workspaceRoot,
        "ui/vite.config.ts",
        "export default { outer: true };\n",
        expectedHash,
      ),
      updateWorkspaceFile(
        path.join(workspaceRoot, "ui"),
        "vite.config.ts",
        "export default { nested: true };\n",
        expectedHash,
      ),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["conflict", "updated"]);
  });

  it("rejects writes to nonexistent files", async () => {
    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "missing.txt",
        content: "new\n",
        expectedHash: hashContent(""),
      }),
    );

    expect(error.details).toMatchObject({
      path: "missing.txt",
      type: "session_file_not_found",
    });
    expect(fs.existsSync(path.join(workspaceRoot, "missing.txt"))).toBe(false);
  });

  it("rejects oversized replacement content before allocating an encoded Buffer", async () => {
    const content = "é".repeat(128 * 1024 + 1);
    const bufferFrom = vi.spyOn(Buffer, "from");
    try {
      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.set", {
          sessionKey: "agent:main:main",
          path: "ui/vite.config.ts",
          content,
          expectedHash: hashContent("export default {};\n"),
        }),
      );

      expect(error.details).toMatchObject({
        maxPreviewBytes: 256 * 1024,
        path: "ui/vite.config.ts",
        size: 256 * 1024 + 2,
        type: "session_file_too_large",
      });
      expect(bufferFrom).not.toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it("round-trips a UTF-8 BOM through get and set", async () => {
    const original = "\uFEFFexport default {};\n";
    writeWorkspaceFile(workspaceRoot, "bom.ts", original);

    const preview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "bom.ts",
      }),
    );
    expect(preview.file.content).toBe(original);
    expect(preview.file.hash).toBe(hashContent(original));

    const next = "\uFEFFexport default { bom: true };\n";
    expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "bom.ts",
        content: next,
        expectedHash: preview.file.hash,
      }),
    );
    const bytes = fs.readFileSync(path.join(workspaceRoot, "bom.ts"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe(next);
  });

  it("rejects replacement content containing NUL bytes", async () => {
    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
        content: "before\0after",
        expectedHash: hashContent("export default {};\n"),
      }),
    );

    expect(error.details).toMatchObject({
      path: "ui/vite.config.ts",
      type: "session_file_unsafe",
    });
    expect(fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8")).toBe(
      "export default {};\n",
    );
  });

  it("rejects replacement content that cannot round-trip through UTF-8", async () => {
    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
        content: "before\ud800after",
        expectedHash: hashContent("export default {};\n"),
      }),
    );

    expect(error.details).toMatchObject({
      path: "ui/vite.config.ts",
      type: "session_file_unsafe",
    });
    expect(fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8")).toBe(
      "export default {};\n",
    );
  });

  it.each([
    {
      format: "BMP",
      bytes: Buffer.concat([Buffer.from("BM", "ascii"), Buffer.alloc(16)]),
      mimeType: "image/bmp",
    },
    {
      format: "HEIC",
      bytes: Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00,
        0x00, 0x6d, 0x69, 0x66, 0x31,
      ]),
      mimeType: "image/heic",
    },
  ])("keeps browser-incompatible $format images metadata-only", async (fixture) => {
    const fileName = `preview-${fixture.format.toLowerCase()}.bin`;
    fs.writeFileSync(path.join(workspaceRoot, fileName), fixture.bytes);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: fileName,
      }),
    );

    expect(payload.file).toMatchObject({
      mimeType: fixture.mimeType,
      path: fileName,
      previewKind: "unsupported",
      size: fixture.bytes.length,
    });
    expect(payload.file.content).toBeUndefined();
    expect(payload.file.contentEncoding).toBeUndefined();
  });

  it("does not trust a supported image extension without supported image bytes", async () => {
    const binary = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64, 7)]);
    fs.writeFileSync(path.join(workspaceRoot, "disguised.png"), binary);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "disguised.png",
      }),
    );

    expect(payload.file).toMatchObject({
      mimeType: "application/x-sqlite3",
      path: "disguised.png",
      previewKind: "unsupported",
    });
    expect(payload.file.content).toBeUndefined();
  });

  it("rejects writes to binary files even with a matching byte hash", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    fs.writeFileSync(path.join(workspaceRoot, "logo.png"), binary);

    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "logo.png",
        content: "text\n",
        expectedHash: createHash("sha256").update(binary).digest("hex"),
      }),
    );

    expect(error.details).toMatchObject({
      path: "logo.png",
      type: "session_file_unsafe",
    });
    expect(fs.readFileSync(path.join(workspaceRoot, "logo.png"))).toEqual(binary);
  });

  it("rejects escaped and symlinked write targets without touching outside files", async () => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const outsidePath = path.join(tempRoot, `openclaw-session-write-outside-${Date.now()}.txt`);
    const escapedName = `openclaw-session-write-escape-${Date.now()}.txt`;
    const escapedPath = path.resolve(workspaceRoot, "..", escapedName);
    const outsideContent = "outside\n";
    fs.writeFileSync(outsidePath, outsideContent, "utf8");
    fs.symlinkSync(outsidePath, path.join(workspaceRoot, "linked.txt"));

    try {
      for (const requestedPath of [`../${escapedName}`, "linked.txt"]) {
        const error = expectError(
          await invokeSessionFilesHandler("sessions.files.set", {
            sessionKey: "agent:main:main",
            path: requestedPath,
            content: "replaced\n",
            expectedHash: hashContent(outsideContent),
          }),
        );
        expect(["session_file_not_found", "session_file_unsafe"]).toContain(error.details.type);
      }
      expect(fs.readFileSync(outsidePath, "utf8")).toBe(outsideContent);
      expect(fs.existsSync(escapedPath)).toBe(false);
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });
});
