import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { readDraftEnvironments } from "./discovery.ts";
import { resolvePlacePickerSections } from "./place-picker-sections.ts";
import { projectCloneInput, renderPlaceSelect } from "./place-picker.ts";

type PlaceSelectParams = Parameters<typeof renderPlaceSelect>[0];

function placeParams(overrides: Partial<PlaceSelectParams> = {}): PlaceSelectParams {
  return {
    browseAvailable: true,
    isAdmin: true,
    canWrite: true,
    folder: "/workspace",
    workspace: "/workspace",
    projects: [],
    recents: [],
    projectQuery: "",
    projectSearchAvailable: true,
    projectAddAvailable: true,
    remoteProjects: [],
    projectSearchCredential: null,
    projectSearchLoading: false,
    projectSearchError: null,
    projectCloneBusy: false,
    projectCloneError: null,
    projectId: "",
    execNodes: [],
    environments: null,
    gatewayName: "",
    cloudProfiles: [],
    cloudProfileId: "",
    execNode: "",
    syncFolder: "/workspace",
    worktree: false,
    worktreeVisible: false,
    worktreeAvailable: false,
    branches: null,
    branchesLoading: false,
    baseRef: "",
    worktreeName: "",
    submitting: false,
    pendingCloud: false,
    showDestinations: false,
    popoverOpen: true,
    popoverHiding: false,
    browserTarget: null,
    browserListing: null,
    browserLoading: false,
    browserError: null,
    browserPathDraft: "",
    usableBrowserPath: null,
    registerProjectPath: null,
    registeringProject: false,
    onGuardTransition: () => undefined,
    onPopoverShow: () => undefined,
    onPopoverHide: () => undefined,
    onPopoverAfterHide: () => undefined,
    onSelectExecNode: () => undefined,
    onSelectCloudProfile: () => undefined,
    onSelectProject: () => undefined,
    onProjectQueryInput: () => undefined,
    onCloneProject: () => undefined,
    onApplyFolder: () => undefined,
    onBrowse: () => undefined,
    onBrowserPathDraftChange: () => undefined,
    onBrowserNavigate: () => undefined,
    onBrowserBack: () => undefined,
    onRegisterProject: () => undefined,
    onClose: () => undefined,
    onToggleWorktree: () => undefined,
    onBaseRefInput: () => undefined,
    onWorktreeNameInput: () => undefined,
    ...overrides,
  };
}

describe("project picker", () => {
  it.each([
    ["https://github.com/openclaw/openclaw.git", true],
    ["git@github.com:openclaw/openclaw.git", true],
    ["ssh://git@github.com/openclaw/openclaw.git", true],
    ["file:///tmp/openclaw.git", false],
    ["/tmp/openclaw", false],
    ["--upload-pack=touch-pwned", false],
    ["https://github.com/openclaw/openclaw.git --config=evil", false],
  ])("detects clone input %s", (value, expected) => {
    expect(projectCloneInput(value) !== null).toBe(expected);
  });

  it("groups gateway, device, and cloud destinations without status copy", () => {
    const container = document.createElement("div");
    render(
      renderPlaceSelect(
        placeParams({
          showDestinations: true,
          worktreeAvailable: true,
          execNodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              canExec: true,
              canBrowse: true,
            },
          ],
          cloudProfiles: [{ id: "aws", providerId: "crabbox", trust: "disposable" }],
        }),
      ),
      container,
    );

    const destinationHeadings = [
      ...container.querySelectorAll<HTMLElement>(".new-session-page__menu-title"),
    ]
      .map((element) => element.textContent?.trim())
      .filter((label) => ["This gateway", "Your devices", "Cloud", "Places"].includes(label ?? ""));
    expect(destinationHeadings).toEqual(["This gateway", "Your devices", "Cloud"]);
    expect(container.querySelector('[data-value="gateway"]')).not.toBeNull();
    expect(container.querySelector('[data-value="node:macbook"]')).not.toBeNull();
    expect(container.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    expect(container.textContent).not.toContain("persistent");
    expect(container.textContent).not.toContain("disposable");
  });

  it("renders local matches before remote clone results and explains missing credentials", () => {
    const onCloneProject = vi.fn();
    const container = document.createElement("div");
    render(
      renderPlaceSelect(
        placeParams({
          projectQuery: "openclaw",
          projects: [
            {
              id: "local-openclaw",
              displayName: "Local OpenClaw",
              repoRoot: "/workspace/openclaw",
              source: "registered",
            },
          ],
          projectSearchCredential: "missing",
          remoteProjects: [
            {
              name: "openclaw",
              fullName: "openclaw/openclaw",
              description: "Personal AI assistant",
              cloneUrl: "https://github.com/openclaw/openclaw.git",
              webUrl: "https://github.com/openclaw/openclaw",
              private: false,
            },
          ],
          onCloneProject,
        }),
      ),
      container,
    );

    const values = [...container.querySelectorAll<HTMLElement>("[data-value]")].map(
      (element) => element.dataset.value,
    );
    expect(values.indexOf("project:local-openclaw")).toBeLessThan(
      values.indexOf("remote-project:openclaw/openclaw"),
    );
    expect(container.textContent).toContain("GH_TOKEN");
    container
      .querySelector<HTMLButtonElement>('[data-value="remote-project:openclaw/openclaw"]')
      ?.click();
    expect(onCloneProject).toHaveBeenCalledWith("https://github.com/openclaw/openclaw.git");
  });

  it("turns a pasted URL into one explicit clone affordance", () => {
    const onCloneProject = vi.fn();
    const container = document.createElement("div");
    const gitUrl = "https://github.com/openclaw/openclaw.git";
    render(
      renderPlaceSelect(
        placeParams({
          projectQuery: gitUrl,
          remoteProjects: [
            {
              name: "ignored",
              fullName: "ignored/remote",
              cloneUrl: "https://github.com/ignored/remote.git",
              webUrl: "https://github.com/ignored/remote",
              private: false,
            },
          ],
          onCloneProject,
        }),
      ),
      container,
    );

    expect(container.querySelector('[data-value^="remote-project:"]')).toBeNull();
    const clone = container.querySelector<HTMLButtonElement>('[data-value="project-clone-url"]');
    expect(clone?.textContent).toContain("Clone");
    clone?.click();
    expect(onCloneProject).toHaveBeenCalledWith(gitUrl);
  });
});

describe("Where picker", () => {
  it("uses node presence until a non-empty authoritative environment catalog arrives", () => {
    const execNodes = [
      {
        nodeId: "usable",
        displayName: "Usable",
        connected: true,
        canExec: true,
        canBrowse: false,
      },
      {
        nodeId: "disconnected",
        displayName: "Disconnected",
        connected: false,
        canExec: true,
        canBrowse: false,
      },
      {
        nodeId: "no-exec",
        displayName: "No exec",
        connected: true,
        canExec: false,
        canBrowse: false,
      },
    ];

    expect(
      resolvePlacePickerSections({ environments: null, execNodes, cloudProfiles: [] }).deviceNodes,
    ).toEqual([execNodes[0]]);
    expect(
      resolvePlacePickerSections({ environments: [], execNodes, cloudProfiles: [] }).deviceNodes,
    ).toEqual([execNodes[0]]);
  });

  it("groups usable places from environment types and the legacy node catalog", () => {
    const container = document.createElement("div");
    const connectedExecNodes = [
      "macbook",
      "worker",
      "local",
      "missing-environment",
      "future-type",
    ].map((nodeId) => ({
      nodeId,
      displayName: nodeId,
      connected: true,
      canExec: true,
      canBrowse: false,
    }));
    render(
      renderPlaceSelect(
        placeParams({
          folder: "",
          execNodes: [
            ...connectedExecNodes,
            {
              nodeId: "offline",
              displayName: "Offline Mac",
              connected: false,
              canExec: false,
              canBrowse: false,
            },
            {
              nodeId: "no-exec",
              displayName: "No exec",
              connected: true,
              canExec: false,
              canBrowse: false,
            },
          ],
          environments: readDraftEnvironments([
            { id: "gateway", type: "local" },
            { id: "node:macbook", type: "node" },
            { id: "node:worker", type: "worker" },
            { id: "node:local", type: "local" },
            { id: "node:offline", type: "node" },
            { id: "node:no-exec", type: "node" },
            { id: "node:future-type", type: "future" },
          ]),
          gatewayName: "Studio",
          cloudProfiles: [
            { id: "aws", providerId: "crabbox" },
            { id: "legacy", providerId: "static-ssh" },
          ],
          worktreeAvailable: true,
          showDestinations: true,
        }),
      ),
      container,
    );

    const titles = [...container.querySelectorAll(".new-session-page__menu-title")].map((element) =>
      element.textContent?.trim(),
    );
    expect(titles).toEqual(["Folder", "Projects", "This gateway", "Your devices", "Cloud"]);
    expect(container.querySelector('[data-value="node:macbook"]')).not.toBeNull();
    for (const nodeId of [
      "worker",
      "local",
      "missing-environment",
      "future-type",
      "offline",
      "no-exec",
    ]) {
      expect(container.querySelector(`[data-value="node:${nodeId}"]`)).toBeNull();
    }
    expect(container.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    expect(container.querySelector('[data-value="cloud:legacy"]')).not.toBeNull();

    const gateway = container.querySelector('[data-value="gateway"]');
    expect(gateway?.lastElementChild?.classList.contains("session-menu__check")).toBe(true);
  });
});
