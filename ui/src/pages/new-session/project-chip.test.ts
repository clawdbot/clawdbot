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
      query: "site",
      expectedProjects: ["website"],
      expectedRecents: 0,
      showWorkspace: false,
    },
  ])("$name", ({ query, expectedProjects, expectedRecents, showWorkspace }) => {
    const state = resolveProjectChip({
      folder: "",
      workspace: "/workspace",
      projectId: "",
      selectedRemoteProject: null,
      projects,
      recents: [],
      projectQuery: query,
    });
    expect(state.localProjects.map((project) => project.id)).toEqual(expectedProjects);
    expect(state.recents).toHaveLength(expectedRecents);
    expect(state.showWorkspace).toBe(showWorkspace);
  });

  it("omits project recents already shown in the project list", () => {
    const folderRecent = {
      kind: "folder" as const,
      folder: "/workspace/scratch",
      displayName: "scratch",
    };
    const repositoryRecent = {
      kind: "repository" as const,
      url: "https://github.com/octocat/hello-world.git",
      displayName: "hello-world",
    };
    const state = resolveProjectChip({
      folder: "",
      workspace: "/workspace",
      projectId: "",
      selectedRemoteProject: null,
      projects,
      recents: [
        { kind: "project", projectId: "openclaw", displayName: "OpenClaw" },
        folderRecent,
        repositoryRecent,
      ],
      projectQuery: "",
    });

    expect(state.recents).toEqual([folderRecent, repositoryRecent]);
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
