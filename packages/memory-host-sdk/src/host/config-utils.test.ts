import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeConfiguredMemoryExtraPaths,
  resolveMemoryHostAgentWorkspaceDir,
  resolveRememberAcrossConversations,
} from "./config-utils.js";

describe("resolveMemoryHostAgentWorkspaceDir", () => {
  it("uses the active profile state root for the default agent workspace", () => {
    expect(
      resolveMemoryHostAgentWorkspaceDir({}, "main", {
        HOME: "/home/peter",
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: "/home/peter/.openclaw-work",
      }),
    ).toBe("/home/peter/.openclaw-work/workspace");
  });

  it("keeps the default agent workspace inside an overridden state directory", () => {
    expect(
      resolveMemoryHostAgentWorkspaceDir({}, "main", {
        HOME: "/home/peter",
        OPENCLAW_STATE_DIR: "/srv/openclaw-scratch",
      }),
    ).toBe("/srv/openclaw-scratch/workspace");
  });

  it("prefers an explicit workspace override to the state directory", () => {
    expect(
      resolveMemoryHostAgentWorkspaceDir({}, "main", {
        HOME: "/home/peter",
        OPENCLAW_STATE_DIR: "/srv/openclaw-scratch",
        OPENCLAW_WORKSPACE_DIR: "/srv/openclaw-workspace",
      }),
    ).toBe("/srv/openclaw-workspace");
  });

  it("keeps literal $ patterns in home when expanding tilde workspace paths", () => {
    expect(
      resolveMemoryHostAgentWorkspaceDir(
        { agents: { entries: { support: { workspace: "~/ws" } } } },
        "support",
        { HOME: "/home/peter$&mall", OPENCLAW_HOME: "~/oc" },
      ),
    ).toBe(path.resolve("/home/peter$&mall/oc/ws"));
  });
});

describe("resolveRememberAcrossConversations", () => {
  it("honors keyed per-agent memory overrides", () => {
    const config = {
      memory: { search: { rememberAcrossConversations: true } },
      agents: {
        entries: {
          support: { memory: { search: { rememberAcrossConversations: false } } },
        },
      },
    };

    expect(resolveRememberAcrossConversations(config, "support")).toBe(false);
  });
});

describe("normalizeConfiguredMemoryExtraPaths", () => {
  it("preserves distinct patterns and canonicalizes unpatterned objects", () => {
    expect(
      normalizeConfiguredMemoryExtraPaths([
        " notes ",
        { path: "notes" },
        { path: " notes ", pattern: " runbooks/**/*.md " },
        { path: "notes", pattern: "runbooks/**/*.md" },
        { path: "notes", pattern: "decisions/**/*.md" },
      ]),
    ).toEqual([
      "notes",
      { path: "notes", pattern: "runbooks/**/*.md" },
      { path: "notes", pattern: "decisions/**/*.md" },
    ]);
  });
});
