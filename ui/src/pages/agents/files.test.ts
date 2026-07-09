import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesGetResult, AgentsFilesSetResult } from "../../api/types.ts";
import { loadAgentFileContent, saveAgentFile } from "./files.ts";

type FilesState = Parameters<typeof loadAgentFileContent>[0];

function createState(client: GatewayBrowserClient): FilesState {
  return {
    client,
    connected: true,
    requestGeneration: 0,
    agentFilesLoading: false,
    agentFilesError: null,
    agentFilesList: { agentId: "main", workspace: "workspace", files: [] },
    agentFileContents: {},
    agentFileDrafts: {},
    agentFileActive: null,
    agentFileSaving: false,
  };
}

function fileResult(content: string): AgentsFilesGetResult {
  return {
    agentId: "main",
    workspace: "workspace",
    file: { name: "AGENTS.md", path: "AGENTS.md", missing: false, content },
  };
}

describe("agent file requests", () => {
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

  it("ignores an old-client save completion", async () => {
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

    state.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    state.requestGeneration += 1;
    state.agentFileSaving = false;
    resolveSave({ ok: true, ...fileResult("old") });
    await save;

    expect(state.agentFileContents).toEqual({});
    expect(state.agentFileSaving).toBe(false);
  });
});
