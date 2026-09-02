import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesGetResult, AgentsFilesSetResult } from "../../api/types.ts";
import {
  loadAgentFileContent,
  overwriteAgentFile,
  reloadAgentFile,
  saveAgentFile,
} from "./files.ts";

type FilesState = Parameters<typeof loadAgentFileContent>[0];

function createState(client: GatewayBrowserClient): FilesState {
  return {
    client,
    connected: true,
    requestGeneration: 0,
    agents: { recordFile: vi.fn(() => null) },
    agentFilesLoading: false,
    agentFilesError: null,
    agentFileContents: {},
    agentFileHashes: {},
    agentFileConflict: null,
    agentFileDrafts: {},
    agentFileSaving: false,
    agentFileWriteRevisions: new Map(),
  };
}

function fileResult(content: string, hash?: string): AgentsFilesGetResult {
  return {
    agentId: "main",
    workspace: "workspace",
    file: {
      name: "AGENTS.md",
      path: "AGENTS.md",
      missing: false,
      content,
      ...(hash ? { hash } : {}),
    },
  };
}

describe("agent file requests", () => {
  it.each(["read result", "read error"])(
    "retires an older %s after saving the same file",
    async (completion) => {
      const read = createDeferred<AgentsFilesGetResult>();
      const client = {
        request: vi.fn((method: string) =>
          method === "agents.files.get"
            ? read.promise
            : Promise.resolve({ ok: true, ...fileResult("saved") }),
        ),
      } as unknown as GatewayBrowserClient;
      const state = createState(client);
      state.agentFileContents = { "AGENTS.md": "original" };
      state.agentFileDrafts = { "AGENTS.md": "original" };

      const load = loadAgentFileContent(state, "main", "AGENTS.md", { force: true });
      state.agentFileDrafts = { "AGENTS.md": "saved" };
      expect(await saveAgentFile(state, "main", "AGENTS.md", "saved")).toBe(true);
      if (completion === "read error") {
        read.reject(new Error("obsolete read failed"));
      } else {
        read.resolve(fileResult("original"));
      }
      expect(await load).toBe(false);
      expect(state.agentFileContents).toEqual({ "AGENTS.md": "saved" });
      expect(state.agentFileDrafts).toEqual({ "AGENTS.md": "saved" });
      expect(state.agentFilesError).toBeNull();
      expect(state.agentFilesLoading).toBe(false);
    },
  );

  it("retires a read started during a write before publishing its result", async () => {
    const read = createDeferred<AgentsFilesGetResult>();
    const write = createDeferred<AgentsFilesSetResult>();
    const client = {
      request: vi.fn((method: string) =>
        method === "agents.files.get" ? read.promise : write.promise,
      ),
    } as unknown as GatewayBrowserClient;
    const state = createState(client);
    state.agentFileContents = { "AGENTS.md": "original" };
    state.agentFileDrafts = { "AGENTS.md": "saved" };

    const save = saveAgentFile(state, "main", "AGENTS.md", "saved");
    const load = loadAgentFileContent(state, "main", "AGENTS.md", { force: true });
    write.resolve({ ok: true, ...fileResult("saved") });
    expect(await save).toBe(true);
    read.resolve(fileResult("original"));
    expect(await load).toBe(false);
    expect(state.agentFileContents).toEqual({ "AGENTS.md": "saved" });
    expect(state.agentFileDrafts).toEqual({ "AGENTS.md": "saved" });
    expect(state.agentFilesLoading).toBe(false);
  });

  it("allows another file's read and a fresh post-save refresh", async () => {
    const read = createDeferred<AgentsFilesGetResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValueOnce({ ok: true, ...fileResult("saved") })
      .mockResolvedValueOnce(fileResult("external update"));
    const state = createState({ request } as unknown as GatewayBrowserClient);
    const load = loadAgentFileContent(state, "main", "SOUL.md");
    await saveAgentFile(state, "main", "AGENTS.md", "saved");
    read.resolve({ ...fileResult("soul"), file: { ...fileResult("soul").file, name: "SOUL.md" } });
    expect(await load).toBe(true);
    expect(state.agentFileDrafts).toEqual({ "AGENTS.md": "saved", "SOUL.md": "soul" });

    expect(await loadAgentFileContent(state, "main", "AGENTS.md", { force: true })).toBe(true);
    expect(state.agentFileDrafts["AGENTS.md"]).toBe("external update");
  });

  it("keeps a failed save and its dirty draft visible after an older read settles", async () => {
    const read = createDeferred<AgentsFilesGetResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(read.promise)
      .mockRejectedValueOnce(new Error("workspace write failed"));
    const state = createState({ request } as unknown as GatewayBrowserClient);
    state.agentFileContents = { "AGENTS.md": "original" };
    state.agentFileDrafts = { "AGENTS.md": "unsaved" };
    const load = loadAgentFileContent(state, "main", "AGENTS.md", { force: true });
    expect(await saveAgentFile(state, "main", "AGENTS.md", "unsaved")).toBe(false);
    read.resolve(fileResult("old"));
    expect(await load).toBe(false);
    expect(state.agentFileContents["AGENTS.md"]).toBe("original");
    expect(state.agentFileDrafts["AGENTS.md"]).toBe("unsaved");
    expect(state.agentFilesError).toBe("workspace write failed");
  });

  it("does not let an old-client read overwrite or finish a replacement read", async () => {
    let resolveOld!: (value: AgentsFilesGetResult) => void;
    let resolveNext!: (value: AgentsFilesGetResult) => void;
    const oldClient = {
      request: vi.fn(
        () =>
          new Promise<AgentsFilesGetResult>((resolve) => {
            resolveOld = resolve;
          }),
      ),
    } as unknown as GatewayBrowserClient;
    const nextClient = {
      request: vi.fn(
        () =>
          new Promise<AgentsFilesGetResult>((resolve) => {
            resolveNext = resolve;
          }),
      ),
    } as unknown as GatewayBrowserClient;
    const state = createState(oldClient);

    const oldLoad = loadAgentFileContent(state, "main", "AGENTS.md");
    state.client = nextClient;
    state.requestGeneration += 1;
    state.agentFilesLoading = false;
    const nextLoad = loadAgentFileContent(state, "main", "AGENTS.md");

    resolveOld(fileResult("old"));
    await oldLoad;
    expect(state.agentFileContents).toEqual({});
    expect(state.agentFilesLoading).toBe(true);

    resolveNext(fileResult("new"));
    await nextLoad;
    expect(state.agentFileContents).toEqual({ "AGENTS.md": "new" });
    expect(state.agentFilesLoading).toBe(false);
  });

  it.each(["client", "capability"] as const)("ignores an old-%s save completion", async (owner) => {
    let resolveSave!: (value: AgentsFilesSetResult) => void;
    const oldClient = {
      request: vi.fn(
        () =>
          new Promise<AgentsFilesSetResult>((resolve) => {
            resolveSave = resolve;
          }),
      ),
    } as unknown as GatewayBrowserClient;
    const state = createState(oldClient);
    const save = saveAgentFile(state, "main", "AGENTS.md", "old");

    if (owner === "client") {
      state.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      state.requestGeneration += 1;
    } else {
      state.agents = { recordFile: vi.fn() };
    }
    state.agentFileSaving = false;
    resolveSave({ ok: true, ...fileResult("old") });
    await save;

    expect(state.agentFileContents).toEqual({});
    expect(state.agentFileSaving).toBe(false);
    expect(state.agents.recordFile).not.toHaveBeenCalled();
  });

  it("commits the submitted draft when it stays current", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ ok: true, ...fileResult("submitted") }),
    } as unknown as GatewayBrowserClient;
    const state = createState(client);
    state.agentFileContents = { "AGENTS.md": "original" };
    state.agentFileDrafts = { "AGENTS.md": "submitted" };

    await saveAgentFile(state, "main", "AGENTS.md", "submitted");

    expect(state.agentFileContents).toEqual({ "AGENTS.md": "submitted" });
    expect(state.agentFileDrafts).toEqual({ "AGENTS.md": "submitted" });
    expect(state.agentFileSaving).toBe(false);
  });

  it("preserves edits made while a save is pending", async () => {
    let resolveSave!: (value: AgentsFilesSetResult) => void;
    const client = {
      request: vi.fn(
        () =>
          new Promise<AgentsFilesSetResult>((resolve) => {
            resolveSave = resolve;
          }),
      ),
    } as unknown as GatewayBrowserClient;
    const state = createState(client);
    state.agentFileContents = { "AGENTS.md": "original" };
    state.agentFileDrafts = { "AGENTS.md": "submitted" };

    const save = saveAgentFile(state, "main", "AGENTS.md", "submitted");
    state.agentFileDrafts = { "AGENTS.md": "typed while saving" };
    resolveSave({ ok: true, ...fileResult("submitted") });
    await save;

    expect(state.agentFileContents).toEqual({ "AGENTS.md": "submitted" });
    expect(state.agentFileDrafts).toEqual({ "AGENTS.md": "typed while saving" });
    expect(state.agentFileSaving).toBe(false);
  });

  it("sends the loaded hash on save and keeps that hash after a refused write", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const conflict = () =>
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: 'agent file "AGENTS.md" changed since it was read',
        details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
      });
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict());
    const state = createState({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    state.agentFileDrafts = { "AGENTS.md": "original\noperator note" };
    expect(await saveAgentFile(state, "main", "AGENTS.md", "original\noperator note")).toBe(false);
    expect(await saveAgentFile(state, "main", "AGENTS.md", "original\noperator note")).toBe(false);

    const setCall = [
      "agents.files.set",
      {
        agentId: "main",
        name: "AGENTS.md",
        content: "original\noperator note",
        expectedHash: loadedHash,
      },
    ];
    expect(request.mock.calls[1]).toEqual(setCall);
    expect(request.mock.calls[2]).toEqual(setCall);
    expect(state.agentFileContents["AGENTS.md"]).toBe("original");
    expect(state.agentFileHashes["AGENTS.md"]).toBe(loadedHash);
    expect(state.agentFileDrafts["AGENTS.md"]).toBe("original\noperator note");
    expect(state.agentFileConflict).toBe("AGENTS.md");
    expect(state.agentFilesError).toContain("changed since it was read");
    expect(state.agentFileSaving).toBe(false);
    expect(state.agentFilesLoading).toBe(false);
  });

  it("keeps a dirty draft's precondition when an ordinary refresh rebases the base", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockResolvedValueOnce(fileResult("original\nagent appended", currentHash))
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: 'agent file "AGENTS.md" changed since it was read',
          details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
        }),
      );
    const state = createState({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    state.agentFileDrafts = { "AGENTS.md": "original\noperator note" };
    expect(await loadAgentFileContent(state, "main", "AGENTS.md", { force: true })).toBe(true);

    expect(state.agentFileContents["AGENTS.md"]).toBe("original\nagent appended");
    expect(state.agentFileDrafts["AGENTS.md"]).toBe("original\noperator note");
    expect(state.agentFileHashes["AGENTS.md"]).toBe(loadedHash);

    expect(await saveAgentFile(state, "main", "AGENTS.md", "original\noperator note")).toBe(false);

    expect(request.mock.calls[2]).toEqual([
      "agents.files.set",
      {
        agentId: "main",
        name: "AGENTS.md",
        content: "original\noperator note",
        expectedHash: loadedHash,
      },
    ]);
    expect(state.agentFileConflict).toBe("AGENTS.md");
  });

  it("adopts the refreshed hash when an ordinary refresh rebases a clean draft", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockResolvedValueOnce(fileResult("original\nagent appended", currentHash));
    const state = createState({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    expect(await loadAgentFileContent(state, "main", "AGENTS.md", { force: true })).toBe(true);

    expect(state.agentFileDrafts["AGENTS.md"]).toBe("original\nagent appended");
    expect(state.agentFileHashes["AGENTS.md"]).toBe(currentHash);
  });

  it("keeps an outstanding conflict through an ordinary refresh that spares the draft", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: 'agent file "AGENTS.md" changed since it was read',
          details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
        }),
      )
      .mockResolvedValueOnce(fileResult("original\nagent appended", currentHash));
    const state = createState({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    state.agentFileDrafts = { "AGENTS.md": "original\noperator note" };
    expect(await saveAgentFile(state, "main", "AGENTS.md", "original\noperator note")).toBe(false);
    expect(state.agentFileConflict).toBe("AGENTS.md");

    expect(await loadAgentFileContent(state, "main", "AGENTS.md", { force: true })).toBe(true);

    expect(state.agentFileConflict).toBe("AGENTS.md");
    expect(state.agentFileHashes["AGENTS.md"]).toBe(loadedHash);
  });

  it("takes the workspace version when a conflict is resolved by reloading", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: 'agent file "AGENTS.md" changed since it was read',
          details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
        }),
      )
      .mockResolvedValueOnce(fileResult("original\nagent appended", currentHash));
    const state = createState({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    state.agentFileDrafts = { "AGENTS.md": "original\noperator note" };
    expect(await saveAgentFile(state, "main", "AGENTS.md", "original\noperator note")).toBe(false);
    expect(await reloadAgentFile(state, "main", "AGENTS.md")).toBe(true);

    expect(request.mock.calls[2]).toEqual([
      "agents.files.get",
      { agentId: "main", name: "AGENTS.md" },
    ]);
    expect(state.agentFileContents["AGENTS.md"]).toBe("original\nagent appended");
    expect(state.agentFileDrafts["AGENTS.md"]).toBe("original\nagent appended");
    expect(state.agentFileHashes["AGENTS.md"]).toBe(currentHash);
    expect(state.agentFileConflict).toBeNull();
  });

  it("rebases onto the current hash when a conflict is resolved by overwriting", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const writtenHash = "c".repeat(64);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: 'agent file "AGENTS.md" changed since it was read',
          details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
        }),
      )
      .mockResolvedValueOnce(fileResult("original\nagent appended", currentHash))
      .mockResolvedValueOnce({
        ok: true,
        ...fileResult("original\noperator note", writtenHash),
      });
    const state = createState({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    state.agentFileDrafts = { "AGENTS.md": "original\noperator note" };
    expect(await saveAgentFile(state, "main", "AGENTS.md", "original\noperator note")).toBe(false);
    expect(await overwriteAgentFile(state, "main", "AGENTS.md", "original\noperator note")).toBe(
      true,
    );

    expect(request.mock.calls[3]).toEqual([
      "agents.files.set",
      {
        agentId: "main",
        name: "AGENTS.md",
        content: "original\noperator note",
        expectedHash: currentHash,
      },
    ]);
    expect(state.agentFileContents["AGENTS.md"]).toBe("original\noperator note");
    expect(state.agentFileHashes["AGENTS.md"]).toBe(writtenHash);
    expect(state.agentFileConflict).toBeNull();
    expect(state.agentFilesError).toBeNull();
  });
});
