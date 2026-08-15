// Read-only workspace browsing tests cover listing, pagination, previews,
// and the traversal/link-escape negatives that guard the workspace boundary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsWorkspaceHandlers } from "./agents-workspace.js";

const hoisted = vi.hoisted(() => ({
  listAgentIds: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    listAgentIds: hoisted.listAgentIds,
    resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
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

type WorkspaceMethod = "agents.workspace.list" | "agents.workspace.get";

async function invokeWorkspaceHandler(method: WorkspaceMethod, params: Record<string, unknown>) {
  const responder = createResponder();
  await agentsWorkspaceHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: { getRuntimeConfig: () => ({}) } as never,
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

function writeWorkspaceFile(root: string, filePath: string, content: string | Buffer) {
  const resolved = path.join(root, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content);
}

describe("agents.workspace RPC handlers", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Realpath the tmp root: macOS os.tmpdir() is a /var -> /private/var symlink
    // and fs-safe compares against the canonical root.
    workspaceRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agents-workspace-test-")),
    );
    hoisted.listAgentIds.mockReturnValue(["main"]);
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
    writeWorkspaceFile(workspaceRoot, "notes.md", "# Notes\n");
    writeWorkspaceFile(workspaceRoot, ".gitignore", "dist\n");
    writeWorkspaceFile(workspaceRoot, "src/index.ts", "export const ok = true;\n");
    writeWorkspaceFile(workspaceRoot, "src/util.ts", "export const util = 1;\n");
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("lists the workspace root with directories first and integer timestamps", async () => {
    const payload = expectOkPayload(
      await invokeWorkspaceHandler("agents.workspace.list", { agentId: "main" }),
    );

    expect(payload.path).toBe("");
    expect(payload.parentPath).toBeUndefined();
    expect(payload.totalEntries).toBe(3);
    expect(payload.offset).toBe(0);
    expect(
      payload.entries.map((entry: Record<string, unknown>) => [entry.path, entry.kind]),
    ).toEqual([
      ["src", "directory"],
      [".gitignore", "file"],
      ["notes.md", "file"],
    ]);
    const file = payload.entries.find(
      (entry: Record<string, unknown>) => entry.path === "notes.md",
    );
    expect(file.size).toBeGreaterThan(0);
    expect(Number.isInteger(file.updatedAtMs)).toBe(true);
  });

  it("lists subdirectories with a parent path", async () => {
    const payload = expectOkPayload(
      await invokeWorkspaceHandler("agents.workspace.list", { agentId: "main", path: "src" }),
    );

    expect(payload.path).toBe("src");
    expect(payload.parentPath).toBe("");
    expect(payload.entries.map((entry: Record<string, unknown>) => entry.path)).toEqual([
      "src/index.ts",
      "src/util.ts",
    ]);
  });

  it("paginates large directories deterministically", async () => {
    for (let index = 0; index < 12; index += 1) {
      writeWorkspaceFile(workspaceRoot, `bulk/file-${String(index).padStart(2, "0")}.txt`, "x");
    }

    const firstPage = expectOkPayload(
      await invokeWorkspaceHandler("agents.workspace.list", {
        agentId: "main",
        path: "bulk",
        limit: 5,
      }),
    );
    expect(firstPage.totalEntries).toBe(12);
    expect(firstPage.entries).toHaveLength(5);
    expect(firstPage.entries[0].name).toBe("file-00.txt");

    const secondPage = expectOkPayload(
      await invokeWorkspaceHandler("agents.workspace.list", {
        agentId: "main",
        path: "bulk",
        offset: 5,
        limit: 5,
      }),
    );
    expect(secondPage.offset).toBe(5);
    expect(secondPage.entries[0].name).toBe("file-05.txt");

    const tailPage = expectOkPayload(
      await invokeWorkspaceHandler("agents.workspace.list", {
        agentId: "main",
        path: "bulk",
        offset: 10,
        limit: 5,
      }),
    );
    expect(tailPage.entries).toHaveLength(2);
  });

  it("rejects unknown agents", async () => {
    const error = expectError(
      await invokeWorkspaceHandler("agents.workspace.list", { agentId: "ghost" }),
    );
    expect(error.message).toContain("unknown agent id");
  });

  it("rejects traversal outside the workspace for list and get", async () => {
    const listError = expectError(
      await invokeWorkspaceHandler("agents.workspace.list", { agentId: "main", path: "../" }),
    );
    expect(listError.details).toMatchObject({ type: "workspace_path_invalid" });

    const getError = expectError(
      await invokeWorkspaceHandler("agents.workspace.get", {
        agentId: "main",
        path: "../outside.txt",
      }),
    );
    expect(getError.details).toMatchObject({ type: "workspace_path_invalid" });

    const nestedTraversal = expectError(
      await invokeWorkspaceHandler("agents.workspace.get", {
        agentId: "main",
        path: "src/../../outside.txt",
      }),
    );
    expect(nestedTraversal.details).toMatchObject({ type: "workspace_path_invalid" });
  });

  it.each(["/etc/passwd", "C:\\Windows\\System32\\drivers\\etc\\hosts"])(
    "rejects absolute workspace paths: %s",
    async (filePath) => {
      const error = expectError(
        await invokeWorkspaceHandler("agents.workspace.get", {
          agentId: "main",
          path: filePath,
        }),
      );
      expect(error.details).toMatchObject({ path: filePath, type: "workspace_path_invalid" });
    },
  );

  it("does not follow symlinked files out of the workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-workspace-linked-${process.pid}.txt`);
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    fs.symlinkSync(outsidePath, path.join(workspaceRoot, "linked.txt"));

    try {
      const error = expectError(
        await invokeWorkspaceHandler("agents.workspace.get", {
          agentId: "main",
          path: "linked.txt",
        }),
      );
      expect(error.details).toMatchObject({
        path: "linked.txt",
        type: "workspace_file_not_found",
      });
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it("does not follow symlinked directories out of the workspace", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workspace-parent-"));
    writeWorkspaceFile(outsideDir, "secret.txt", "outside secret\n");
    fs.symlinkSync(outsideDir, path.join(workspaceRoot, "linked-dir"), "dir");

    try {
      const listError = expectError(
        await invokeWorkspaceHandler("agents.workspace.list", {
          agentId: "main",
          path: "linked-dir",
        }),
      );
      expect(listError.details).toMatchObject({ type: "workspace_path_not_found" });

      const getError = expectError(
        await invokeWorkspaceHandler("agents.workspace.get", {
          agentId: "main",
          path: "linked-dir/secret.txt",
        }),
      );
      expect(getError.details).toMatchObject({ type: "workspace_file_not_found" });
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects hardlinked files shared outside the workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-workspace-hardlink-${process.pid}.txt`);
    fs.writeFileSync(outsidePath, "shared\n", "utf8");
    fs.linkSync(outsidePath, path.join(workspaceRoot, "shared.txt"));

    try {
      const error = expectError(
        await invokeWorkspaceHandler("agents.workspace.get", {
          agentId: "main",
          path: "shared.txt",
        }),
      );
      expect(error.details).toMatchObject({ type: "workspace_file_not_found" });
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it("reads UTF-8 text files inline", async () => {
    const payload = expectOkPayload(
      await invokeWorkspaceHandler("agents.workspace.get", { agentId: "main", path: "notes.md" }),
    );

    expect(payload.file).toMatchObject({
      path: "notes.md",
      name: "notes.md",
      encoding: "utf8",
      mimeType: "text/plain",
      content: "# Notes\n",
    });
    expect(Number.isInteger(payload.file.updatedAtMs)).toBe(true);
  });

  it("reads images as base64 with their sniffed mime type", async () => {
    // 1x1 transparent PNG so magic-byte sniffing sees a real image payload.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    writeWorkspaceFile(workspaceRoot, "shot.png", pngBytes);

    const payload = expectOkPayload(
      await invokeWorkspaceHandler("agents.workspace.get", { agentId: "main", path: "shot.png" }),
    );

    expect(payload.file).toMatchObject({
      encoding: "base64",
      mimeType: "image/png",
      size: pngBytes.length,
    });
    expect(Buffer.from(payload.file.content, "base64")).toEqual(pngBytes);
  });

  it("refuses non-image binaries renamed to an image extension", async () => {
    writeWorkspaceFile(
      workspaceRoot,
      "disguised.png",
      Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64, 7)]),
    );

    const error = expectError(
      await invokeWorkspaceHandler("agents.workspace.get", {
        agentId: "main",
        path: "disguised.png",
      }),
    );
    expect(error.details).toMatchObject({
      path: "disguised.png",
      type: "workspace_file_unsupported",
    });
  });

  it("refuses non-image binary files", async () => {
    writeWorkspaceFile(workspaceRoot, "blob.bin", Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const error = expectError(
      await invokeWorkspaceHandler("agents.workspace.get", { agentId: "main", path: "blob.bin" }),
    );
    expect(error.details).toMatchObject({
      path: "blob.bin",
      type: "workspace_file_unsupported",
    });
  });

  it("refuses invalid UTF-8 without relying on a NUL byte", async () => {
    writeWorkspaceFile(workspaceRoot, "invalid.txt", Buffer.from([0xc3, 0x28]));

    const error = expectError(
      await invokeWorkspaceHandler("agents.workspace.get", {
        agentId: "main",
        path: "invalid.txt",
      }),
    );
    expect(error.details).toMatchObject({
      path: "invalid.txt",
      type: "workspace_file_unsupported",
    });
  });

  it("reports oversized text files with the preview cap", async () => {
    writeWorkspaceFile(workspaceRoot, "large.log", "x".repeat(260 * 1024));

    const error = expectError(
      await invokeWorkspaceHandler("agents.workspace.get", { agentId: "main", path: "large.log" }),
    );
    expect(error.details).toMatchObject({
      maxBytes: 256 * 1024,
      path: "large.log",
      size: 260 * 1024,
      type: "workspace_file_too_large",
    });
  });

  it("reports oversized images with the image preview cap", async () => {
    writeWorkspaceFile(workspaceRoot, "large.png", Buffer.alloc(5 * 1024 * 1024 + 1));

    const error = expectError(
      await invokeWorkspaceHandler("agents.workspace.get", {
        agentId: "main",
        path: "large.png",
      }),
    );
    expect(error.details).toMatchObject({
      maxBytes: 5 * 1024 * 1024,
      path: "large.png",
      size: 5 * 1024 * 1024 + 1,
      type: "workspace_file_too_large",
    });
  });

  it("treats directories as missing files for get", async () => {
    const error = expectError(
      await invokeWorkspaceHandler("agents.workspace.get", { agentId: "main", path: "src" }),
    );
    expect(error.details).toMatchObject({ type: "workspace_file_not_found" });
  });
});
