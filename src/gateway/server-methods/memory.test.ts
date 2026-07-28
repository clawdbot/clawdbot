// memory.list tests cover persisted-memory enumeration, default agent scoping,
// optional inline content, and caps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryHandlers } from "./memory.js";

const hoisted = vi.hoisted(() => ({
  listAgentIds: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    listAgentIds: hoisted.listAgentIds,
    resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
    resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
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

async function invokeMemoryList(params: Record<string, unknown>) {
  const responder = createResponder();
  await memoryHandlers["memory.list"]?.({
    req: { type: "req", id: "memory.list", method: "memory.list", params: {} },
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

describe("memory.list RPC handler", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-list-test-")),
    );
    hoisted.listAgentIds.mockReturnValue(["main", "ops"]);
    hoisted.resolveDefaultAgentId.mockReturnValue("main");
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-26-planning.md", "planning\n");
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-27.md", "daily\n");
    writeWorkspaceFile(workspaceRoot, "memory/ignore.txt", "not memory\n");
    writeWorkspaceFile(workspaceRoot, "MEMORY.md", "# Root memory\n");
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("lists daily memory files for the default agent newest first", async () => {
    const payload = expectOkPayload(await invokeMemoryList({}));

    expect(hoisted.resolveDefaultAgentId).toHaveBeenCalledWith({});
    expect(payload).toMatchObject({
      agentId: "main",
      memoryDir: "memory",
      totalFiles: 2,
      returnedFiles: 2,
      truncated: false,
    });
    expect(payload.files.map((file: Record<string, unknown>) => file.path)).toEqual([
      "memory/2026-07-27.md",
      "memory/2026-07-26-planning.md",
    ]);
    expect(payload.files[1]).toMatchObject({
      name: "2026-07-26-planning.md",
      date: "2026-07-26",
      slug: "planning",
      truncated: false,
    });
    expect(payload.files[0]).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("rootMemory");
  });

  it("uses an explicit agent id when provided", async () => {
    const payload = expectOkPayload(await invokeMemoryList({ agentId: "ops" }));

    expect(payload.agentId).toBe("ops");
    expect(hoisted.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(hoisted.resolveAgentWorkspaceDir).toHaveBeenCalledWith({}, "ops");
  });

  it("includes content and root memory when requested", async () => {
    const payload = expectOkPayload(
      await invokeMemoryList({ includeContent: true, includeRootMemory: true }),
    );

    expect(payload.files[0]).toMatchObject({
      path: "memory/2026-07-27.md",
      content: "daily\n",
      truncated: false,
    });
    expect(payload.rootMemory).toMatchObject({
      name: "MEMORY.md",
      path: "MEMORY.md",
      content: "# Root memory\n",
      truncated: false,
    });
  });

  it("caps returned files and reports truncation", async () => {
    const payload = expectOkPayload(await invokeMemoryList({ limit: 1 }));

    expect(payload.totalFiles).toBe(2);
    expect(payload.returnedFiles).toBe(1);
    expect(payload.truncated).toBe(true);
    expect(payload.files).toHaveLength(1);
  });

  it("marks oversized content as truncated without inlining it", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28-large.md", "x".repeat(20));

    const payload = expectOkPayload(
      await invokeMemoryList({ includeContent: true, maxContentBytes: 5 }),
    );

    expect(payload.files[0]).toMatchObject({
      path: "memory/2026-07-28-large.md",
      truncated: true,
    });
    expect(payload.files[0]).not.toHaveProperty("content");
  });

  it("returns an empty list when the memory directory is missing", async () => {
    fs.rmSync(path.join(workspaceRoot, "memory"), { recursive: true, force: true });

    const payload = expectOkPayload(await invokeMemoryList({ includeRootMemory: true }));

    expect(payload).toMatchObject({
      files: [],
      totalFiles: 0,
      returnedFiles: 0,
      truncated: false,
    });
    expect(payload.rootMemory).toMatchObject({ path: "MEMORY.md" });
  });

  it("rejects unknown agents", async () => {
    const error = expectError(await invokeMemoryList({ agentId: "ghost" }));

    expect(error.message).toContain("unknown agent id");
  });
});
