import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBootstrapFile } from "./workspace.js";

vi.mock("./workspace.js", () => ({
  loadWorkspaceBootstrapFiles: vi.fn(),
}));

function makeFile(name: string, content: string): WorkspaceBootstrapFile {
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/ws/${name}`,
    content,
    missing: false,
  };
}

describe("getOrLoadBootstrapFiles", () => {
  const files = [makeFile("AGENTS.md", "# Agent"), makeFile("SOUL.md", "# Soul")];
  let clearAllBootstrapSnapshots: typeof import("./bootstrap-cache.js").clearAllBootstrapSnapshots;
  let getOrLoadBootstrapFiles: typeof import("./bootstrap-cache.js").getOrLoadBootstrapFiles;
  let workspaceModule: typeof import("./workspace.js");

  const mockLoad = () => vi.mocked(workspaceModule.loadWorkspaceBootstrapFiles);

  beforeAll(async () => {
    ({ clearAllBootstrapSnapshots, getOrLoadBootstrapFiles } =
      await import("./bootstrap-cache.js"));
    workspaceModule = await import("./workspace.js");
  });

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad().mockResolvedValue(files);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("loads from disk on first call and caches", async () => {
    const result = await getOrLoadBootstrapFiles({
      workspaceDir: "/ws",
      sessionKey: "session-1",
    });

    expect(result).toBe(files);
    expect(mockLoad()).toHaveBeenCalledTimes(1);
  });

  it("refreshes from disk on second call while preserving unchanged object identity", async () => {
    const refreshedFiles = [makeFile("AGENTS.md", "# Agent"), makeFile("SOUL.md", "# Soul")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(refreshedFiles);

    const first = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(first).toBe(files);
    expect(result).toBe(first);
    expect(result).not.toBe(refreshedFiles);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("replaces cached result when workspace bootstrap contents change", async () => {
    const updatedFiles = [makeFile("AGENTS.md", "# Agent v2"), makeFile("SOUL.md", "# Soul")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(updatedFiles);

    const first = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(first).toBe(files);
    expect(result).toBe(updatedFiles);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("different session keys get independent caches", async () => {
    const files2 = [makeFile("AGENTS.md", "# Agent v2")];
    mockLoad().mockResolvedValueOnce(files).mockResolvedValueOnce(files2);

    const r1 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-2" });

    expect(r1).toBe(files);
    expect(r2).toBe(files2);
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });
});

describe("clearBootstrapSnapshot", () => {
  let clearAllBootstrapSnapshots: typeof import("./bootstrap-cache.js").clearAllBootstrapSnapshots;
  let clearBootstrapSnapshot: typeof import("./bootstrap-cache.js").clearBootstrapSnapshot;
  let getOrLoadBootstrapFiles: typeof import("./bootstrap-cache.js").getOrLoadBootstrapFiles;
  let workspaceModule: typeof import("./workspace.js");

  const mockLoad = () => vi.mocked(workspaceModule.loadWorkspaceBootstrapFiles);

  beforeAll(async () => {
    ({ clearAllBootstrapSnapshots, clearBootstrapSnapshot, getOrLoadBootstrapFiles } =
      await import("./bootstrap-cache.js"));
    workspaceModule = await import("./workspace.js");
  });

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad().mockResolvedValue([makeFile("AGENTS.md", "content")]);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("clears a single session entry", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    clearBootstrapSnapshot("sk");

    // Next call should hit disk again.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(mockLoad()).toHaveBeenCalledTimes(2);
  });

  it("does not affect other sessions", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk1" });
    const first = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });

    clearBootstrapSnapshot("sk1");

    // sk2 should still preserve its cached snapshot identity after refresh.
    const second = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });
    expect(second).toBe(first);
    expect(mockLoad()).toHaveBeenCalledTimes(3); // sk1 x1, sk2 x2
  });
});
