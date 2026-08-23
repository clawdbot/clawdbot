/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { AgentsRouteData } from "./route.ts";
import "./agents-page.ts";

const AGENT_FILE_GATEWAY_HELLO = gatewayHelloForMethods(["agents.files.set"]);

type TestAgentsPage = HTMLElement & {
  context: ApplicationContext;
  routeData?: AgentsRouteData;
  agentsSelectedId: string | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
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
});
