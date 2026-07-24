import { execFileSync } from "node:child_process";
// Session file method tests cover transcript-linked files plus the workspace browser.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenPathCommand } from "./open-path.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import { updateWorkspaceFile } from "./workspace-fs.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: hoisted.execOpenPath };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    loadSessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    visitSessionMessagesAsync: hoisted.visitSessionMessagesAsync,
  };
});

function createResponder() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

type SessionFilesMethod =
  | "sessions.files.list"
  | "sessions.files.get"
  | "sessions.files.set"
  | "sessions.files.reveal";

async function invokeSessionFilesHandler(
  method: SessionFilesMethod,
  params: Record<string, unknown>,
  context: Record<string, unknown> = {},
) {
  const responder = createResponder();
  await sessionsFilesHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: context as never,
  });
  return responder.calls;
}

function expectOkPayload(calls: ReturnType<typeof createResponder>["calls"]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload as Record<string, any>;
}

function expectError(calls: ReturnType<typeof createResponder>["calls"]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(false);
  return calls[0]?.error as Record<string, any>;
}

function assistantToolCall(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name,
        arguments: args,
      },
    ],
  };
}

function writeWorkspaceFile(root: string, filePath: string, content: string) {
  const resolved = path.join(root, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("sessions.files RPC handlers", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const tempRoot = fs.realpathSync(os.tmpdir());
    workspaceRoot = fs.mkdtempSync(path.join(tempRoot, "openclaw-session-files-test-"));
    hoisted.resolveDefaultAgentId.mockReturnValue("main");
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
    hoisted.execOpenPath.mockResolvedValue(undefined);
    writeWorkspaceFile(workspaceRoot, "package.json", '{"name":"openclaw-test"}\n');
    writeWorkspaceFile(workspaceRoot, "src/readme.md", "# Read me\n");
    writeWorkspaceFile(workspaceRoot, "ui/chat.ts", "export const chat = true;\n");
    writeWorkspaceFile(workspaceRoot, "ui/vite.config.ts", "export default {};\n");

    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        spawnedCwd: workspaceRoot,
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      [
        assistantToolCall("edit", { path: "ui/chat.ts" }),
        assistantToolCall("read", { path: "src/readme.md" }),
        assistantToolCall("apply_patch", {
          input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n",
        }),
      ].forEach((message, index) => visit(message, index + 1));
      return 3;
    });
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("lists session-touched files with a browser rooted at the session workspace", async () => {
    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.gitCheckout).toBe(false);
    expect(payload.files.map((file: Record<string, unknown>) => [file.path, file.kind])).toEqual([
      ["package.json", "modified"],
      ["ui/chat.ts", "modified"],
      ["src/readme.md", "read"],
    ]);
    expect(payload.browser.path).toBe("");
    expect(
      payload.browser.entries.map((entry: Record<string, unknown>) => [
        entry.path,
        entry.kind,
        entry.sessionKind,
      ]),
    ).toEqual([
      ["src", "directory", "read"],
      ["ui", "directory", "modified"],
      ["package.json", "file", "modified"],
    ]);
    execFileSync("git", ["-C", workspaceRoot, "init", "-q", "-b", "main"]);
    const gitPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", { sessionKey: "agent:main:main" }),
    );
    expect(gitPayload.gitCheckout).toBe(true);
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

  it("collects touched files from existing transcript tool-call spellings", async () => {
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "read", input: { path: "src/readme.md" } },
            { type: "toolcall", name: "edit", arguments: { path: "ui/vite.config.ts" } },
            { type: "tool_use", name: "read", args: { path: "ui/chat.ts" } },
            {
              type: "tool_call",
              name: "apply_patch",
              input: {
                input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n",
              },
            },
          ],
        },
        1,
      );
      return 1;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.files.map((file: Record<string, unknown>) => [file.path, file.kind])).toEqual([
      ["package.json", "modified"],
      ["ui/vite.config.ts", "modified"],
      ["src/readme.md", "read"],
      ["ui/chat.ts", "read"],
    ]);
  });

  it("collects changed files from structured apply_patch changes", async () => {
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(
        assistantToolCall("apply_patch", {
          changes: [
            { path: "ui/chat.ts", kind: "update" },
            { path: "src/readme.md", kind: "delete" },
            { path: "old-name.md", kind: { type: "update", move_path: "package.json" } },
          ],
        }),
        1,
      );
      return 1;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.files.map((file: Record<string, unknown>) => [file.path, file.kind])).toEqual([
      ["old-name.md", "modified"],
      ["package.json", "modified"],
      ["src/readme.md", "modified"],
      ["ui/chat.ts", "modified"],
    ]);
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
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      visit(assistantToolCall("read", { path: "../shared/config.ts" }), 2);
      return 2;
    });

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
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      return 1;
    });

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
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      return 1;
    });

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
      hash: hashContent("export default {};\n"),
      kind: "read",
      missing: false,
      path: "ui/vite.config.ts",
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
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: outsidePath }), 1);
      return 1;
    });

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

  it("omits transcript paths outside the workspace without hiding missing workspace files", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-outside-list-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      [
        outsidePath,
        "../outside.txt",
        "~/.openclaw-external.txt",
        pathToFileURL(outsidePath).href,
        `@${outsidePath}`,
        "..cache/missing.txt",
        "missing.txt",
        "src/readme.md",
      ].forEach((filePath, index) =>
        visit(assistantToolCall("read", { path: filePath }), index + 1),
      );
      return 8;
    });

    try {
      const payload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.files.list", {
          sessionKey: "agent:main:main",
        }),
      );

      expect(payload.files).toHaveLength(3);
      expect(payload.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "..cache/missing.txt", missing: true }),
          expect.objectContaining({ path: "missing.txt", missing: true }),
          expect.objectContaining({
            path: "src/readme.md",
            missing: false,
            workspacePath: "src/readme.md",
          }),
        ]),
      );
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
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "secret.txt" }), 1);
      return 1;
    });
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
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "large.log" }), 1);
      return 1;
    });

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
    expect(hoisted.visitSessionMessagesAsync).not.toHaveBeenCalled();
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

  it("previews binary files without issuing a CAS hash", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    fs.writeFileSync(path.join(workspaceRoot, "logo.png"), binary);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "logo.png",
      }),
    );

    expect(typeof payload.file.content).toBe("string");
    expect(payload.file.hash).toBeUndefined();
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
