import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  ProjectRecordSchema,
  ProjectsAddResultSchema,
  ProjectSummarySchema,
  ProjectsListResultSchema,
  ProjectsSearchRemoteResultSchema,
  validateProjectsAddParams,
  validateProjectsListParams,
  validateProjectsRegisterParams,
  validateProjectsRemoveParams,
  validateProjectsSearchRemoteParams,
  validateSessionsCreateParams,
} from "../index.js";

describe("project protocol schemas", () => {
  it("validates project method inputs as closed objects", () => {
    expect(validateProjectsListParams({})).toBe(true);
    expect(validateProjectsListParams({ includeObserved: true })).toBe(true);
    expect(validateProjectsListParams({ includeObserved: false })).toBe(true);
    expect(validateProjectsListParams({ includeObserved: "yes" })).toBe(false);
    expect(validateProjectsListParams({ extra: true })).toBe(false);
    expect(validateProjectsRegisterParams({ path: "/repo", name: "OpenClaw" })).toBe(true);
    expect(validateProjectsRegisterParams({ path: "" })).toBe(false);
    expect(validateProjectsAddParams({ gitUrl: "https://github.com/openclaw/openclaw.git" })).toBe(
      true,
    );
    expect(validateProjectsAddParams({ gitUrl: "", unexpected: true })).toBe(false);
    expect(validateProjectsSearchRemoteParams({ query: "openclaw" })).toBe(true);
    expect(validateProjectsSearchRemoteParams({ query: "" })).toBe(false);
    expect(validateProjectsRemoveParams({ id: "openclaw-2", deleteCheckout: true })).toBe(true);
    expect(validateProjectsRemoveParams({ id: "workspace:main" })).toBe(false);
  });

  it("accepts bounded remote search and clone results", () => {
    const project = {
      id: "openclaw",
      displayName: "OpenClaw",
      repoRoot: "/state/projects/fingerprint/openclaw",
      originUrl: "https://github.com/openclaw/openclaw.git",
      source: "cloned",
    };
    expect(Value.Check(ProjectsAddResultSchema, project)).toBe(true);
    expect(
      Value.Check(ProjectsSearchRemoteResultSchema, {
        credential: "missing",
        projects: [
          {
            name: "openclaw",
            fullName: "openclaw/openclaw",
            description: "Personal AI assistant",
            cloneUrl: "https://github.com/openclaw/openclaw.git",
            webUrl: "https://github.com/openclaw/openclaw",
            private: false,
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts workspace and stored project records", () => {
    expect(
      Value.Check(ProjectRecordSchema, {
        id: "workspace:main",
        displayName: "openclaw",
        source: "workspace",
        agentId: "main",
      }),
    ).toBe(true);
    expect(
      Value.Check(ProjectsListResultSchema, {
        projects: [
          {
            id: "openclaw",
            displayName: "OpenClaw",
            repoRoot: "/repo/openclaw",
            originUrl: "https://github.com/openclaw/openclaw.git",
            source: "registered",
          },
        ],
        recents: [
          { kind: "project", projectId: "openclaw", displayName: "OpenClaw" },
          { kind: "folder", folder: "/repo/scratch", displayName: "scratch" },
        ],
        observedProjects: [],
      }),
    ).toBe(true);
    expect(Value.Check(ProjectsListResultSchema, { projects: [] })).toBe(true);
    expect(Value.Check(ProjectsListResultSchema, { observedProjects: [] })).toBe(false);
  });

  it("bounds observed projects and their checkout lists", () => {
    const project = {
      name: "openclaw",
      originUrl: "https://github.com/openclaw/openclaw.git",
      checkouts: [{ runnerId: "gateway", path: "/repo/openclaw" }],
      lastUsedAt: 1,
    };
    expect(Value.Check(ProjectSummarySchema, project)).toBe(true);
    expect(
      Value.Check(ProjectSummarySchema, {
        ...project,
        checkouts: Array.from(
          { length: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 1 },
          (_, index) => ({ runnerId: "gateway", path: `/repo/openclaw-${index}` }),
        ),
      }),
    ).toBe(false);
    expect(
      Value.Check(ProjectsListResultSchema, {
        projects: [],
        observedProjects: Array.from({ length: PROJECTS_LIST_DEFAULT_LIMIT + 1 }, () => project),
      }),
    ).toBe(false);
  });

  it("accepts bounded project identity and remote URL as additive sessions.create parameters", () => {
    expect(validateSessionsCreateParams({ agentId: "main", projectId: "openclaw" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", projectId: "" })).toBe(false);
    expect(
      validateSessionsCreateParams({
        agentId: "main",
        projectGitUrl: "https://github.com/openclaw/openclaw.git",
      }),
    ).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", projectGitUrl: "" })).toBe(false);
    expect(
      validateSessionsCreateParams({ agentId: "main", projectGitUrl: "x".repeat(2_049) }),
    ).toBe(false);
  });
});
