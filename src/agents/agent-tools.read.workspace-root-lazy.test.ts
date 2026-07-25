import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Regression guard: doctor's active-tool schema projection constructs the full
// coding toolset to inspect tool input schemas. Workspace-scoped edit/write
// tools used to resolve their fs-safe root eagerly at construction. When the
// agent's workspace dir does not exist yet (e.g. an unresolved `${ENV}`
// placeholder in the authored config), that orphaned a rejecting promise:
//   "[openclaw] Unhandled promise rejection: FsSafeError: root dir not found"
// The root must only be opened when a read/write/access operation actually runs.

const rootSpy = vi.hoisted(() => vi.fn());

type WorkspaceFileOps = {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
};
const captured = vi.hoisted(() => ({
  write: undefined as WorkspaceFileOps | undefined,
  edit: undefined as WorkspaceFileOps | undefined,
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return { ...actual, root: rootSpy };
});

// Capture the operations object handed to the underlying write/edit tools so the
// regression can drive a single workspace write operation directly.
vi.mock("./sessions/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessions/index.js")>();
  const stub = (name: string) => ({
    name,
    description: `test ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  });
  return {
    ...actual,
    createWriteTool: (_cwd: string, options?: { operations?: WorkspaceFileOps }) => {
      captured.write = options?.operations;
      return stub("write");
    },
    createEditTool: (_cwd: string, options?: { operations?: WorkspaceFileOps }) => {
      captured.edit = options?.operations;
      return stub("edit");
    },
  };
});

const { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } =
  await import("./agent-tools.read.js");

function requireOps(ops: WorkspaceFileOps | undefined, label: string): WorkspaceFileOps {
  if (!ops) {
    throw new Error(`expected captured ${label} operations`);
  }
  return ops;
}

describe("workspace-scoped coding tools resolve their fs root lazily", () => {
  it("does not open the fs-safe root while only constructing the tool", () => {
    // Resolve to a stub root handle so a lazy call would not reject, yet assert
    // construction never reaches it.
    rootSpy.mockReset().mockResolvedValue({
      read: vi.fn(),
      write: vi.fn(),
      open: vi.fn(),
    });
    const missingWorkspace = "/openclaw-nonexistent-workspace-zzz/does/not/exist";

    createHostWorkspaceEditTool(missingWorkspace, { workspaceOnly: true });
    createHostWorkspaceWriteTool(missingWorkspace, { workspaceOnly: true });

    expect(rootSpy).not.toHaveBeenCalled();
  });

  it("does not orphan a rejecting fs-safe root when a write/edit targets a missing root", async () => {
    // A workspace-only write/edit against an absent root fails path validation first
    // (realpath on the missing root). The fs-safe root must only be started after that
    // validation succeeds, so a failed write never leaves a rejecting root promise
    // unawaited and surfacing as an unhandled rejection.
    rootSpy.mockReset().mockRejectedValue(new Error("root dir not found"));
    const missingWorkspace = "/openclaw-nonexistent-workspace-zzz/does/not/exist";
    const missingFile = path.join(missingWorkspace, "out.txt");

    createHostWorkspaceWriteTool(missingWorkspace, { workspaceOnly: true });
    createHostWorkspaceEditTool(missingWorkspace, { workspaceOnly: true });
    const writeOps = requireOps(captured.write, "write");
    const editOps = requireOps(captured.edit, "edit");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(writeOps.writeFile(missingFile, "x")).rejects.toThrow();
      await expect(editOps.writeFile(missingFile, "x")).rejects.toThrow();
      // Let any orphaned rejection settle into the listener before asserting.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // Validation failed before the fs-safe root was started, so there is no orphaned
    // rejecting promise — neither a rootSpy call nor an unhandled rejection.
    expect(rootSpy).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
