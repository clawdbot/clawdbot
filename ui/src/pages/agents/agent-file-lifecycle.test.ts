/* @vitest-environment jsdom */

import { render, type TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsListResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { loadAgentFileContent } from "./files.ts";
import type { AgentsRouteData } from "./route.ts";
import "./agents-page.ts";

const AGENT_FILE_GATEWAY_HELLO = gatewayHelloForMethods(["agents.files.set"]);

type TestAgentsPage = HTMLElement &
  Parameters<typeof loadAgentFileContent>[0] & {
    context: ApplicationContext;
    routeData?: AgentsRouteData;
    agentsList: AgentsListResult | null;
    agentsSelectedId: string | null;
    agentFilesList: AgentsFilesListResult | null;
    agentFileActive: string | null;
    gateway: {
      applySnapshot: (
        snapshot: ApplicationGatewaySnapshot,
        binding: { initial: boolean; sourceChanged: boolean },
      ) => void;
    };
    selectDefaultAgentFile: (agentId: string) => Promise<void>;
    syncCurrentAgentFiles: (agents?: ApplicationContext["agents"]) => void;
    loadAgentFiles: (agentId: string, force?: boolean) => Promise<void>;
    saveSelectedAgentFile: (agentId: string, name: string, content: string) => void;
    render: () => TemplateResult;
  };

function snapshot(client: GatewayBrowserClient): ApplicationGatewaySnapshot {
  return {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: AGENT_FILE_GATEWAY_HELLO,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function gateway(current: ApplicationGatewaySnapshot): ApplicationContext["gateway"] {
  return {
    snapshot: current,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

function setPageGateway(page: TestAgentsPage, client: GatewayBrowserClient) {
  page.gateway.applySnapshot(snapshot(client), { initial: false, sourceChanged: false });
}

function fileList(): AgentsFilesListResult {
  return {
    agentId: "main",
    workspace: "/tmp/workspace",
    files: [{ name: "AGENTS.md", path: "/tmp/workspace/AGENTS.md", missing: false }],
  };
}

describe("agent file lifecycle", () => {
  it("hydrates a file selected by an early list publication after list loading settles", async () => {
    const list = fileList();
    const request = vi.fn(async () => ({
      ...list,
      file: { ...list.files[0], content: "# Instructions" },
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const agents = {
      files: () => ({ list, loading: false, error: null }),
      recordFile: () => list,
    } as unknown as ApplicationContext["agents"];
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.context = { gateway: gateway(snapshot(client)), agents } as unknown as ApplicationContext;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";
    page.routeData = { panel: "files" } as AgentsRouteData;
    page.agentFilesLoading = true;

    page.syncCurrentAgentFiles(agents);
    expect(page.agentFileActive).toBe("AGENTS.md");
    expect(request).not.toHaveBeenCalled();

    page.agentFilesLoading = false;
    await page.selectDefaultAgentFile("main");

    expect(page.agentFileContents["AGENTS.md"]).toBe("# Instructions");
  });

  it("refreshes the active file base without replacing a dirty draft", async () => {
    const list = fileList();
    let authoritativeContent = "server revision 1";
    const request = vi.fn(async () => ({
      file: {
        ...list.files[0],
        content: authoritativeContent,
      },
    }));
    const refreshFiles = vi.fn(async () => list);
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.context = {
      gateway: gateway(snapshot(client)),
      agents: {
        files: () => ({ list: null, loading: false, error: null }),
        ensureFiles: vi.fn(async () => list),
        refreshFiles,
        recordFile: () => list,
      },
    } as unknown as ApplicationContext;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";

    await page.loadAgentFiles("main");
    page.agentFileDrafts = { "AGENTS.md": "local draft" };
    authoritativeContent = "server revision 2";

    await page.loadAgentFiles("main", true);

    expect(refreshFiles).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.agentFileContents["AGENTS.md"]).toBe("server revision 2");
    expect(page.agentFileDrafts["AGENTS.md"]).toBe("local draft");
  });

  it("keeps a rejected save visible without refreshing it away", async () => {
    const request = vi.fn(async () => {
      throw new Error("workspace write failed");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const refreshFiles = vi.fn(async () => fileList());
    const agents = {
      files: () => ({ list: null, loading: false, error: null }),
      refreshFiles,
    } as unknown as ApplicationContext["agents"];
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.context = { gateway: gateway(snapshot(client)), agents } as unknown as ApplicationContext;
    setPageGateway(page, client);
    page.agentsSelectedId = "main";

    page.saveSelectedAgentFile("main", "AGENTS.md", "updated");

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(page.agentFilesError).toBe("workspace write failed"));
    expect(refreshFiles).not.toHaveBeenCalled();
  });

  it.each(["content read", "file list", "invalidated cache"] as const)(
    "keeps saved file metadata through a pending %s and unrelated agent publication",
    async (pendingRequest) => {
      const missingFile = { name: "AGENTS.md", path: "/tmp/workspace/AGENTS.md", missing: true };
      const missingList = { ...fileList(), files: [missingFile] };
      const savedFile = { ...missingFile, missing: false, content: "saved content", size: 13 };
      const savedList = { ...missingList, files: [savedFile] };
      const savedResult = { agentId: "main", workspace: missingList.workspace, file: savedFile };
      const contentRead = createDeferred<AgentsFilesGetResult>();
      const listRead = createDeferred<AgentsFilesListResult>();
      let listCalls = 0;
      let contentCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "agents.files.list") {
          listCalls += 1;
          if (listCalls === 1) {
            return missingList;
          }
          return pendingRequest === "file list" && listCalls === 2
            ? await listRead.promise
            : savedList;
        }
        if (method === "agents.files.get") {
          contentCalls += 1;
          return pendingRequest === "content read" && contentCalls === 1
            ? await contentRead.promise
            : savedResult;
        }
        if (method === "agents.files.set") {
          return { ok: true, ...savedResult };
        }
        if (method === "agents.list") {
          return { defaultId: "main", agents: [{ id: "main" }] };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const currentGateway = gateway(snapshot(client));
      const agents = createAgentCapability(currentGateway);
      await agents.ensureFiles("main");
      const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
      page.context = { gateway: currentGateway, agents } as unknown as ApplicationContext;
      setPageGateway(page, client);
      page.agentsSelectedId = "main";
      page.routeData = { panel: "files" } as AgentsRouteData;
      page.agentFilesList = missingList;
      page.agentFileActive = missingFile.name;
      page.agentFileContents = { [missingFile.name]: "" };
      page.agentFileDrafts = { [missingFile.name]: savedFile.content };
      const unsubscribe = agents.subscribe(() => page.syncCurrentAgentFiles(agents));
      const refresh =
        pendingRequest !== "file list"
          ? loadAgentFileContent(page, "main", missingFile.name, { force: true })
          : page.loadAgentFiles("main", true);

      try {
        expect(page.agentFilesLoading).toBe(true);
        if (pendingRequest === "invalidated cache") {
          agents.invalidateFiles(["main"]);
        }
        page.saveSelectedAgentFile("main", missingFile.name, savedFile.content);
        await vi.waitFor(() => {
          expect(page.agentFileSaving).toBe(false);
          expect(page.agentFileContents[missingFile.name]).toBe(savedFile.content);
        });
        expect(page.agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);

        contentRead.resolve(savedResult);
        listRead.resolve(missingList);
        await refresh;
        expect(page.agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);
        expect(page.agentFileActive).toBe(missingFile.name);

        await agents.refreshList();

        expect(page.agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);
        expect(page.agentFileContents[missingFile.name]).toBe(savedFile.content);
        expect(page.agentFileDrafts[missingFile.name]).toBe(savedFile.content);
        expect(page.agentFilesError).toBeNull();
      } finally {
        unsubscribe();
        contentRead.resolve(savedResult);
        listRead.resolve(missingList);
        await refresh;
        agents.dispose();
      }
    },
  );

  it.each([false, true])(
    "renders a failed cache rebuild without replacing a newer save error: %s",
    async (newerSaveFails) => {
      const list = fileList();
      const savedContent = "saved content";
      const rebuildError = "workspace metadata refresh failed";
      const writeError = "newer workspace write failed";
      const rebuild = createDeferred<AgentsFilesListResult>();
      let listCalls = 0;
      let writeCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "agents.files.list") {
          listCalls += 1;
          return listCalls === 1 ? list : await rebuild.promise;
        }
        if (method === "agents.files.set") {
          writeCalls += 1;
          if (writeCalls > 1) {
            throw new Error(writeError);
          }
          return {
            ok: true,
            agentId: "main",
            workspace: list.workspace,
            file: { ...list.files[0], content: savedContent },
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const currentGateway = gateway(snapshot(client));
      const agents = createAgentCapability(currentGateway);
      await agents.ensureFiles("main");
      const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
      page.context = {
        basePath: "",
        gateway: { ...currentGateway, connection: { password: "" } },
        agents,
        agentIdentity: { entries: () => [] },
        channels: { state: {} },
        runtimeConfig: { state: { configForm: {} } },
        navigation: { snapshot: { pinnedAgentIds: [] } },
      } as unknown as ApplicationContext;
      setPageGateway(page, client);
      page.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", name: "Main" }],
      };
      page.agentsSelectedId = "main";
      page.routeData = { panel: "files" } as AgentsRouteData;
      page.agentFilesList = list;
      page.agentFileActive = "AGENTS.md";
      page.agentFileContents = { "AGENTS.md": "original" };
      page.agentFileDrafts = { "AGENTS.md": savedContent };
      const unsubscribe = agents.subscribe(() => page.syncCurrentAgentFiles(agents));
      const container = document.createElement("div");

      try {
        agents.invalidateFiles(["main"]);
        page.saveSelectedAgentFile("main", "AGENTS.md", savedContent);
        await vi.waitFor(() => {
          expect(page.agentFileSaving).toBe(false);
          expect(page.agentFileContents["AGENTS.md"]).toBe(savedContent);
          expect(listCalls).toBe(2);
        });
        if (newerSaveFails) {
          page.agentFileDrafts = { "AGENTS.md": "newer draft" };
          page.saveSelectedAgentFile("main", "AGENTS.md", "newer draft");
          await vi.waitFor(() => expect(page.agentFilesError).toBe(writeError));
        }
        rebuild.reject(new Error(rebuildError));
        await vi.waitFor(() => expect(agents.files("main").error).toBe(rebuildError));

        render(page.render(), container);

        expect(container.querySelector(".callout.danger")?.textContent).toBe(
          newerSaveFails ? writeError : rebuildError,
        );
        expect(container.querySelector<HTMLTextAreaElement>(".agent-file-textarea")?.value).toBe(
          newerSaveFails ? "newer draft" : savedContent,
        );
        expect(page.agentFileContents["AGENTS.md"]).toBe(savedContent);
      } finally {
        unsubscribe();
        rebuild.resolve(list);
        agents.dispose();
        render(null, container);
      }
    },
  );
});
