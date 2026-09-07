import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
} from "../../components/terminal/terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "../../components/terminal/terminal-panel.ts";
import {
  createDraftFixture,
  registerTextPayload,
  stubObjectUrls,
} from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

const nativeTerminalController = vi.fn(async () => createTerminalController());
const nativeTerminalElement = defineTestTerminalPanelElement(nativeTerminalController);

function mountNativeTerminal(context: ApplicationContext) {
  const listeners = new Set<(event: { event: string; payload: unknown }) => void>();
  const client = expectDefined(context.gateway.snapshot.client, "connected Gateway");
  Object.assign(client, {
    addEventListener: (listener: (event: { event: string; payload: unknown }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forceReconnect: vi.fn(),
  });
  const panel = document.createElement(nativeTerminalElement) as OpenClawTerminalPanel;
  panel.client = client;
  panel.available = true;
  document.body.append(panel);
  return {
    panel,
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners) {
        listener({ event, payload });
      }
    },
  };
}

describe("DraftSubmissionFlow native terminal", () => {
  it.each([
    { catalogId: "codex", exitCode: 0, signal: 1, exitLabel: "exited (signal 1)" },
    { catalogId: "claude", exitCode: 1, signal: 0, exitLabel: "exited (1)" },
  ])(
    "primary submission retains $catalogId output and exit that precede the native start response",
    async ({ catalogId, exitCode, signal, exitLabel }) => {
      const controller = createTerminalController();
      nativeTerminalController.mockResolvedValueOnce(controller);
      const { context, flow, request } = createDraftFixture({
        scopes: ["operator.admin", "operator.read", "operator.write"],
        methods: ["sessions.create", "sessions.catalog.startTerminal", "terminal.open"],
        data: {
          agentId: "main",
          requestedAgentId: "main",
          catalogId,
          model: "openai/test",
          catalogLabel: catalogId,
          startTerminal: true,
          terminalHosts: [{ hostId: "gateway:local", label: "Local CLI" }],
        },
        request: async (method) => {
          if (method === "sessions.catalog.startTerminal") {
            terminal.emit("terminal.data", {
              sessionId: "terminal-created",
              seq: 23,
              data: "Native CLI startup text",
            });
            terminal.emit("terminal.exit", {
              sessionId: "terminal-created",
              reason: "process_exit",
              exitCode,
              signal,
            });
            return terminalOpenResult("terminal-created");
          }
          if (method === "terminal.attach") {
            throw new Error('unknown terminal session "terminal-created"');
          }
          return {};
        },
      });
      const terminal = mountNativeTerminal(context);
      flow.setMessage("start this task");
      await flow.submit();

      expect(controller.write).toHaveBeenCalledWith(
        new TextEncoder().encode("Native CLI startup text"),
      );
      expect(request).toHaveBeenCalledWith(
        "sessions.catalog.startTerminal",
        {
          catalogId,
          agentId: "main",
          hostId: "gateway:local",
          cwd: "/workspace",
          initialMessage: "start this task",
        },
        { timeoutMs: 35_000 },
      );
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(flow.message).toBe("");
      await terminal.panel.updateComplete;
      expect(terminal.panel.renderRoot.textContent).toContain(exitLabel);
      expect(terminal.panel.renderRoot.textContent).not.toContain("Could not attach");
      expect(request.mock.calls.some(([method]) => method === "terminal.attach")).toBe(false);
      expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe("[]");
      expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull();
    },
  );

  it("keeps the native prompt until terminal startup succeeds", async () => {
    let rejectStart!: (error: Error) => void;
    const started = new Promise<never>((_, reject) => {
      rejectStart = reject;
    });
    const { context, flow, request } = createDraftFixture({
      scopes: ["operator.admin"],
      methods: ["sessions.catalog.startTerminal", "terminal.open"],
      data: {
        agentId: "main",
        requestedAgentId: "main",
        catalogId: "codex",
        catalogLabel: "Codex",
        model: "",
        startTerminal: true,
        terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
      },
      request: (method) =>
        method === "sessions.catalog.startTerminal" ? started : Promise.resolve({}),
    });
    const { panel } = mountNativeTerminal(context);
    flow.setMessage("keep my prompt");
    const submitting = flow.submit();
    await vi.waitFor(() =>
      expect(
        request.mock.calls.some(([method]) => method === "sessions.catalog.startTerminal"),
      ).toBe(true),
    );
    expect(flow.message).toBe("keep my prompt");
    expect(flow.submitting).toBe(true);
    rejectStart(new Error("Native CLI is unavailable"));
    await submitting;
    expect(flow.message).toBe("keep my prompt");
    expect(flow.error).toContain("Native CLI is unavailable");
    await panel.updateComplete;
    expect(panel.renderRoot.textContent).toContain("Native CLI is unavailable");
    expect(panel.renderRoot.querySelector(".tabstrip-tab")).toBeNull();
  });

  it("does not start a cancelled native draft after the terminal finishes loading", async () => {
    let finishTerminal!: (controller: ReturnType<typeof createTerminalController>) => void;
    const loading = new Promise<ReturnType<typeof createTerminalController>>((resolve) => {
      finishTerminal = resolve;
    });
    nativeTerminalController.mockReturnValueOnce(loading);
    const { context, flow, request } = createDraftFixture({
      scopes: ["operator.admin"],
      methods: ["sessions.catalog.startTerminal", "terminal.open"],
      data: {
        agentId: "main",
        requestedAgentId: "main",
        catalogId: "codex",
        catalogLabel: "Codex",
        model: "",
        startTerminal: true,
        terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
      },
      request: async () => terminalOpenResult("cancelled-start"),
    });
    const { panel } = mountNativeTerminal(context);
    const previousBoots = nativeTerminalController.mock.calls.length;
    flow.setMessage("do not launch this stale draft");
    const submitting = flow.submit();
    await vi.waitFor(() =>
      expect(nativeTerminalController.mock.calls.length).toBe(previousBoots + 1),
    );
    flow.invalidate("gateway-changed");
    const controller = createTerminalController();
    finishTerminal(controller);
    await submitting;
    expect(request.mock.calls.some(([method]) => method === "sessions.catalog.startTerminal")).toBe(
      false,
    );
    expect(flow.message).toBe("do not launch this stale draft");
    expect(controller.dispose).toHaveBeenCalledOnce();
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".tabstrip-tab")).toBeNull();
  });

  it("provisions the chosen local worktree before opening the native CLI", async () => {
    const { flow, place, request, context } = createDraftFixture({
      scopes: ["operator.admin"],
      methods: ["sessions.catalog.startTerminal", "worktrees.create", "terminal.open"],
      agents: [{ id: "main", workspace: "/repo", workspaceGit: true }],
      data: {
        agentId: "main",
        requestedAgentId: "main",
        catalogId: "codex",
        catalogLabel: "Codex",
        model: "",
        startTerminal: true,
        terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
      },
      request: async (method) =>
        method === "worktrees.branches"
          ? { repositoryStatus: "git", branches: ["main"], headBranch: "main" }
          : method === "worktrees.create"
            ? { path: "/repo/worktrees/native" }
            : terminalOpenResult("native-worktree"),
    });
    mountNativeTerminal(context);
    await vi.waitFor(() => expect(place.repository.kind).toBe("git"));
    place.selectWorktree(true);
    place.setWorktreeName("native");
    place.setBaseRef("main");
    await flow.submit();
    expect(request).toHaveBeenCalledWith("worktrees.create", {
      repoRoot: "/repo",
      name: "native",
      baseRef: "main",
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.catalog.startTerminal",
      {
        catalogId: "codex",
        agentId: "main",
        hostId: "gateway:local",
        cwd: "/repo/worktrees/native",
      },
      { timeoutMs: 35_000 },
    );
    expect(context.sessions.createResult).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"])(
    "%s native launch preserves node ownership and refuses stale capabilities",
    async (catalogId) => {
      const data = {
        agentId: "main",
        requestedAgentId: "main",
        catalogId,
        model: "",
        catalogLabel: catalogId,
        startTerminal: true,
        terminalHosts: [{ hostId: "node:chosen", label: "Chosen" }],
      };
      const { context, flow, gateway, place, request } = createDraftFixture({
        data,
        agents: [{ id: "main", workspace: "/gateway-only" }],
        scopes: ["operator.admin"],
        methods: ["sessions.catalog.startTerminal", "terminal.open"],
        request: async () => terminalOpenResult("native-node"),
      });
      mountNativeTerminal(context);
      place.selectTerminalHost("node:chosen");
      expect(flow.submitDisabledReason()).toBeTruthy();
      place.applyFolder("/node/existing-project");
      const persistPreference = vi.spyOn(gateway, "persistPreference");
      request.mockClear();
      place.invalidateGatewayDiscovery(false);
      place.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
      expect(persistPreference).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      flow.setMessage("native prompt");
      await flow.submit();
      expect(request).toHaveBeenCalledWith(
        "sessions.catalog.startTerminal",
        {
          catalogId,
          agentId: "main",
          hostId: "node:chosen",
          cwd: "/node/existing-project",
          initialMessage: "native prompt",
        },
        { timeoutMs: 35_000 },
      );
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      request.mockClear();
      data.terminalHosts = [];
      await flow.submit();
      expect(flow.blockedSubmitNotice()).toContain("Native CLI host unavailable");
      expect(request).not.toHaveBeenCalled();
      expect(place.terminalHostId).toBe("node:chosen");
      expect(place.folder).toBe("/node/existing-project");

      // Same-route revalidation can retire the capability without changing the chosen node.
      data.startTerminal = false;
      data.catalogLabel = "";
      place.adoptAgentDefaults({ preserveSelectedAgent: true, preserveSelectedFolder: true });
      request.mockClear();
      persistPreference.mockClear();
      place.applyFolder("/node/revalidated-project");
      expect(request).not.toHaveBeenCalled();
      expect(persistPreference).not.toHaveBeenCalled();
      expect(place.terminalHostId).toBe("node:chosen");
      expect(place.folder).toBe("/node/revalidated-project");
      await flow.submit();
      expect(flow.blockedSubmitNotice()).toBe("This session target is unavailable.");
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "attachments", "overrides", "mentions", "missing method", "non-admin"])(
    "native launch fails visibly for %s without Chat fallback",
    async (failure) => {
      const { context, flow, request } = createDraftFixture({
        scopes: failure === "non-admin" ? ["operator.write"] : ["operator.admin"],
        methods:
          failure === "missing method"
            ? ["sessions.create"]
            : ["sessions.catalog.startTerminal", "terminal.open"],
        data: {
          agentId: "main",
          requestedAgentId: "main",
          catalogId: "codex",
          model: "",
          catalogLabel: "Codex",
          startTerminal: true,
          terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
        },
      });
      if (failure === "disabled") {
        context.config.current.cliAgentsEnabled = false;
      }
      if (failure === "attachments") {
        stubObjectUrls("blob:native-attachment");
        flow.attachmentDraft.replace([registerTextPayload("native-attachment")]);
      }
      if (failure === "overrides") {
        flow.capabilities.setToolOverrides({ skills: { release: false } });
      }
      const message =
        failure === "mentions" ? "@Alex do not turn this into Chat" : "do not turn this into Chat";
      flow.setMessage(
        message,
        failure === "mentions" ? [{ profileId: "profile-alex", start: 0, end: 5 }] : undefined,
      );
      await flow.submit();
      expect(flow.blockedSubmitNotice()).toBeTruthy();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(flow.message).toBe(message);
      if (failure === "mentions") {
        expect(flow.mentions).toEqual([{ profileId: "profile-alex", start: 0, end: 5 }]);
        expect(flow.blockedSubmitNotice()).toBe(
          "Human mentions are not available in this mode. Remove the selected mentions or send from a normal chat.",
        );
      }
      if (failure === "overrides") {
        flow.capabilities.setToolOverrides(null);
        expect(flow.canSubmit()).toBe(true);
      }
    },
  );
});
