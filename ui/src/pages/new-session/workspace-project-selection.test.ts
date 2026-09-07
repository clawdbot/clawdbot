import { afterEach, expect, it, vi } from "vitest";
import { CHAT_ROUTE_READY_EVENT } from "../../app/route-transition.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

it.each(["main", "work"])(
  "creates a session with the selected %s workspace owner",
  async (agentId) => {
    const projects = ["main", "work"].map((id) => ({
      id: `workspace:${id}`,
      displayName: "shared",
      repoRoot: "/workspace/shared",
      source: "workspace" as const,
      agentId: id,
    }));
    const registered = {
      id: "registered",
      displayName: "Registered",
      repoRoot: "/workspace/registered",
      source: "registered" as const,
    };
    const { context, flow, place } = createDraftFixture({
      agents: ["main", "work"].map((id) => ({
        id,
        workspace: "/workspace/shared",
        workspaceGit: false,
        model: { primary: "openai/gpt-5.6-luna" },
      })),
      methods: ["sessions.create", "projects.list"],
      request: async (method) =>
        method === "projects.list" ? { projects: [...projects, registered] } : {},
    });
    await place.browser.refreshProjects();
    const otherAgentId = agentId === "main" ? "work" : "main";
    place.selectAgentId(otherAgentId);
    place.selectProjectId(`workspace:${agentId}`);
    place.selectProjectId(`workspace:${otherAgentId}`);
    expect(
      place.buildSessionCreateParams({ message: "Switch workspace", visibility: "normal" }),
    ).toMatchObject({ agentId: otherAgentId, projectId: `workspace:${otherAgentId}` });
    place.selectProjectId(`workspace:${agentId}`);
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: `agent:${agentId}:new`,
      initialRun: { status: "idle" },
    });
    vi.mocked(context.navigateAndWait).mockImplementation(async () => {
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    flow.setMessage("Check this workspace");
    await vi.waitFor(() => expect(flow.submitBlock()).toBeUndefined());

    await flow.submit();

    expect(flow.error).toBeNull();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    expect(context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId,
        projectId: `workspace:${agentId}`,
        message: "Check this workspace",
      }),
      { reconciliation: "background" },
    );
    place.selectProjectId(registered.id);
    expect(
      place.buildSessionCreateParams({
        message: "Check the registered project",
        visibility: "normal",
      }),
    ).toMatchObject({ agentId, projectId: registered.id });
    flow.disconnect();
    place.browser.disconnect();
  },
);
