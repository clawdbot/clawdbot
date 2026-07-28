// Read-only persisted memory enumeration tests cover the empty state,
// newest-first daily listing, workspace-relative paths, content omission,
// bounded content with truncation, the file count cap, and root memory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryHandlers } from "./memory.js";

const hoisted = vi.hoisted(() => ({
  resolveDefaultAgentId: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
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
    hoisted.resolveDefaultAgentId.mockReturnValue("main");
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("returns an empty list when the memory directory is missing", async () => {
    const payload = expectOkPayload(await invokeMemoryList({}));
    expect(payload.agentId).toBe("main");
    expect(payload.files).toEqual([]);
    expect(payload.totalFiles).toBe(0);
    expect(payload.returnedFiles).toBe(0);
  });

  it("lists daily files newest-first with workspace-relative paths", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-26.md", "oldest\n");
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "newest\n");
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28-dreams.md", "slugged\n");
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-27.md", "middle\n");
    // Non-daily files stay out of the listing.
    writeWorkspaceFile(workspaceRoot, "memory/random-notes.md", "ignored\n");

    const payload = expectOkPayload(await invokeMemoryList({}));
    expect(payload.files.map((f: any) => f.path)).toEqual([
      "memory/2026-07-28.md",
      "memory/2026-07-28-dreams.md",
      "memory/2026-07-27.md",
      "memory/2026-07-26.md",
    ]);
    expect(payload.totalFiles).toBe(4);
    expect(payload.returnedFiles).toBe(4);
  });

  it("omits content unless includeContent is set", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "hello memory\n");

    const payload = expectOkPayload(await invokeMemoryList({}));
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).not.toHaveProperty("content");
    expect(payload.files[0]).not.toHaveProperty("truncated");
    expect(payload.files[0].sizeBytes).toBeGreaterThan(0);
  });

  it("includes content when requested", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "hello memory\n");

    const payload = expectOkPayload(await invokeMemoryList({ includeContent: true }));
    expect(payload.files[0].content).toBe("hello memory\n");
    expect(payload.files[0]).not.toHaveProperty("truncated");
  });

  it("bounds content by maxContentBytes and flags truncation", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "x".repeat(128 * 1024));

    const payload = expectOkPayload(
      await invokeMemoryList({ includeContent: true, maxContentBytes: 1024 }),
    );
    expect(payload.files[0].content).toHaveLength(1024);
    expect(payload.files[0].truncated).toBe(true);
  });

  it("caps content at the default 64 KiB bound", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "y".repeat(100 * 1024));

    const payload = expectOkPayload(await invokeMemoryList({ includeContent: true }));
    expect(payload.files[0].content).toHaveLength(64 * 1024);
    expect(payload.files[0].truncated).toBe(true);
  });

  it("caps the returned file count while reporting totalFiles", async () => {
    for (let day = 1; day <= 10; day += 1) {
      const stamp = `2026-07-${String(day).padStart(2, "0")}`;
      writeWorkspaceFile(workspaceRoot, `memory/${stamp}.md`, `${stamp}\n`);
    }

    const payload = expectOkPayload(await invokeMemoryList({ limit: 3 }));
    expect(payload.returnedFiles).toBe(3);
    expect(payload.totalFiles).toBe(10);
    expect(payload.files.map((f: any) => f.path)).toEqual([
      "memory/2026-07-10.md",
      "memory/2026-07-09.md",
      "memory/2026-07-08.md",
    ]);
  });

  it("clamps an out-of-range limit to the 366 file maximum", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "one\n");

    const payload = expectOkPayload(await invokeMemoryList({ limit: 5000 }));
    expect(payload.returnedFiles).toBe(1);
    expect(payload.totalFiles).toBe(1);
  });

  it("includes the root MEMORY.md first when requested", async () => {
    writeWorkspaceFile(workspaceRoot, "MEMORY.md", "# Curated\n");
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "daily\n");

    const payload = expectOkPayload(await invokeMemoryList({ includeRootMemory: true }));
    expect(payload.files.map((f: any) => f.path)).toEqual(["MEMORY.md", "memory/2026-07-28.md"]);
    expect(payload.totalFiles).toBe(2);
    expect(payload.returnedFiles).toBe(2);
  });

  it("skips a missing root MEMORY.md without failing", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "daily\n");

    const payload = expectOkPayload(await invokeMemoryList({ includeRootMemory: true }));
    expect(payload.files.map((f: any) => f.path)).toEqual(["memory/2026-07-28.md"]);
    expect(payload.totalFiles).toBe(1);
  });

  it("omits the root MEMORY.md by default", async () => {
    writeWorkspaceFile(workspaceRoot, "MEMORY.md", "# Curated\n");

    const payload = expectOkPayload(await invokeMemoryList({}));
    expect(payload.files).toEqual([]);
    expect(payload.totalFiles).toBe(0);
  });

  it("rejects invalid params", async () => {
    const calls = await invokeMemoryList({ limit: "many" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ok).toBe(false);
  });

  it("counts root MEMORY.md against the limit", async () => {
    writeWorkspaceFile(workspaceRoot, "MEMORY.md", "# Curated\n");
    for (let day = 1; day <= 5; day += 1) {
      const stamp = `2026-07-${String(day).padStart(2, "0")}`;
      writeWorkspaceFile(workspaceRoot, `memory/${stamp}.md`, `${stamp}\n`);
    }

    const payload = expectOkPayload(await invokeMemoryList({ includeRootMemory: true, limit: 3 }));
    expect(payload.returnedFiles).toBe(3);
    expect(payload.totalFiles).toBe(6);
    expect(payload.files[0].path).toBe("MEMORY.md");
    expect(payload.files).toHaveLength(3);
  });

  it("returns only root MEMORY.md when limit is 1 and root is included", async () => {
    writeWorkspaceFile(workspaceRoot, "MEMORY.md", "# Curated\n");
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "daily\n");

    const payload = expectOkPayload(await invokeMemoryList({ includeRootMemory: true, limit: 1 }));
    expect(payload.returnedFiles).toBe(1);
    expect(payload.files[0].path).toBe("MEMORY.md");
    expect(payload.totalFiles).toBe(2);
  });

  it("clamps limit=0 to 1 instead of rejecting", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "hello\n");

    const payload = expectOkPayload(await invokeMemoryList({ limit: 0 }));
    expect(payload.returnedFiles).toBe(1);
    expect(payload.totalFiles).toBe(1);
  });

  it("clamps a negative limit to 1 instead of rejecting", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "hello\n");

    const payload = expectOkPayload(await invokeMemoryList({ limit: -10 }));
    expect(payload.returnedFiles).toBe(1);
    expect(payload.totalFiles).toBe(1);
  });

  it("clamps maxContentBytes=0 to 1 instead of rejecting", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "hello memory\n");

    const payload = expectOkPayload(
      await invokeMemoryList({ includeContent: true, maxContentBytes: 0 }),
    );
    expect(payload.files[0].content).toHaveLength(1);
    expect(payload.files[0].truncated).toBe(true);
  });

  it("clamps a negative maxContentBytes to 1 instead of rejecting", async () => {
    writeWorkspaceFile(workspaceRoot, "memory/2026-07-28.md", "hello memory\n");

    const payload = expectOkPayload(
      await invokeMemoryList({ includeContent: true, maxContentBytes: -100 }),
    );
    expect(payload.files[0].content).toHaveLength(1);
    expect(payload.files[0].truncated).toBe(true);
  });
});
