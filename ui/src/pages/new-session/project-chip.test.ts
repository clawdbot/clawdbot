import { describe, expect, it } from "vitest";
import { projectCloneInput, resolveProjectChip } from "./project-chip.ts";

const projects = [
  {
    id: "openclaw",
    displayName: "OpenClaw",
    repoRoot: "/workspace/openclaw",
    source: "registered" as const,
  },
  {
    id: "website",
    displayName: "Website",
    repoRoot: "/workspace/site",
    source: "workspace" as const,
  },
];

describe("What chip state", () => {
  it.each([
    {
      name: "filters registered and workspace projects locally",
      execNode: "",
      query: "site",
      expectedMode: "projects",
      expectedProjects: ["website"],
      expectedRecents: 0,
      showWorkspace: false,
    },
    {
      name: "switches to node-path mode without changing the source list",
      execNode: "macbook",
      query: "",
      expectedMode: "node-path",
      expectedProjects: ["openclaw", "website"],
      expectedRecents: 1,
      showWorkspace: false,
    },
  ])(
    "$name",
    ({ execNode, query, expectedMode, expectedProjects, expectedRecents, showWorkspace }) => {
      const state = resolveProjectChip({
        folder: "",
        workspace: "/workspace",
        projectId: "",
        selectedRemoteProject: null,
        projects,
        recents: [
          {
            kind: "folder",
            folder: "/remote/project",
            displayName: "project",
            execNode: "macbook",
          },
        ],
        projectQuery: query,
        execNode,
      });
      expect(state.mode).toBe(expectedMode);
      expect(state.localProjects.map((project) => project.id)).toEqual(expectedProjects);
      expect(state.recents).toHaveLength(expectedRecents);
      expect(state.showWorkspace).toBe(showWorkspace);
    },
  );

  it("omits project recents already shown in the project list", () => {
    const folderRecent = {
      kind: "folder" as const,
      folder: "/workspace/scratch",
      displayName: "scratch",
    };
    const state = resolveProjectChip({
      folder: "",
      workspace: "/workspace",
      projectId: "",
      selectedRemoteProject: null,
      projects,
      recents: [{ kind: "project", projectId: "openclaw", displayName: "OpenClaw" }, folderRecent],
      projectQuery: "",
      execNode: "",
    });

    expect(state.recents).toEqual([folderRecent]);
  });

  it.each([
    ["https://github.com/openclaw/openclaw.git", true],
    ["git@github.com:openclaw/openclaw.git", true],
    ["file:///tmp/openclaw.git", false],
    ["--upload-pack=touch-pwned", false],
    ["https://github.com/openclaw/openclaw.git --config=evil", false],
  ])("recognizes safe clone input %s", (value, expected) => {
    expect(projectCloneInput(value) !== null).toBe(expected);
  });
});
