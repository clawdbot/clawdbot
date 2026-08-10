import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ProjectRecordSchema,
  ProjectsListResultSchema,
  validateProjectsListParams,
  validateProjectsRegisterParams,
  validateProjectsRemoveParams,
  validateSessionsCreateParams,
} from "../index.js";

describe("project protocol schemas", () => {
  it("validates project method inputs as closed objects", () => {
    expect(validateProjectsListParams({})).toBe(true);
    expect(validateProjectsListParams({ extra: true })).toBe(false);
    expect(validateProjectsRegisterParams({ path: "/repo", name: "OpenClaw" })).toBe(true);
    expect(validateProjectsRegisterParams({ path: "" })).toBe(false);
    expect(validateProjectsRemoveParams({ id: "openclaw-2" })).toBe(true);
    expect(validateProjectsRemoveParams({ id: "workspace:main" })).toBe(false);
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
      }),
    ).toBe(true);
  });

  it("accepts projectId as an additive sessions.create parameter", () => {
    expect(validateSessionsCreateParams({ agentId: "main", projectId: "openclaw" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", projectId: "" })).toBe(false);
  });
});
