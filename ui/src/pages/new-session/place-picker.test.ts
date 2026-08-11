import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { projectCloneInput, renderPlaceSelect } from "./place-picker.ts";

type PlaceSelectParams = Parameters<typeof renderPlaceSelect>[0];

function placeParams(overrides: Partial<PlaceSelectParams> = {}): PlaceSelectParams {
  return {
    browseAvailable: true,
    isAdmin: true,
    canWrite: true,
    folder: "/workspace",
    workspace: "/workspace",
    workspaceRoots: ["/workspace"],
    projects: [],
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
    sessions: [],
    execNodes: [],
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
