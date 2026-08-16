import { describe, expect, it } from "vitest";
import { buildWorkspaceHookStatus } from "./hooks-status.js";
import type { HookEntry } from "./types.js";

function createHookEntry(params: {
  source: HookEntry["hook"]["source"];
  events: string[];
}): HookEntry {
  return {
    hook: {
      name: "session-memory",
      description: "Save session context to memory",
      source: params.source,
      filePath: `/tmp/${params.source}/HOOK.md`,
      baseDir: `/tmp/${params.source}`,
      handlerPath: `/tmp/${params.source}/handler.js`,
    },
    frontmatter: {},
    metadata: { events: params.events },
  };
}

describe("hook status", () => {
  it("reports an eventless managed winner as not loadable", () => {
    const report = buildWorkspaceHookStatus("/tmp/workspace", {
      entries: [
        createHookEntry({
          source: "openclaw-managed",
          events: [],
        }),
        createHookEntry({
          source: "openclaw-workspace",
          events: ["command:new"],
        }),
      ],
    });

    expect(report.hooks).toHaveLength(1);
    expect(report.hooks[0]).toMatchObject({
      source: "openclaw-managed",
      events: [],
      enabledByConfig: true,
      requirementsSatisfied: true,
      loadable: false,
      blockedReason: "no events defined",
    });
  });

  it("keeps OS incompatibility visible for always-on hooks", () => {
    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";
    const entry = createHookEntry({
      source: "openclaw-workspace",
      events: ["command:new"],
    });
    entry.metadata = {
      ...entry.metadata,
      events: ["command:new"],
      always: true,
      os: [mismatchedOs],
      requires: { env: ["MISSING_HOOK_ENV"] },
    };

    const report = buildWorkspaceHookStatus("/tmp/workspace", {
      entries: [entry],
      config: {
        hooks: {
          internal: {
            enabled: true,
            entries: { "session-memory": { enabled: true } },
          },
        },
      },
    });

    expect(report.hooks[0]).toMatchObject({
      always: true,
      requirementsSatisfied: false,
      loadable: false,
      blockedReason: "missing requirements",
      missing: {
        bins: [],
        anyBins: [],
        env: [],
        config: [],
        os: [mismatchedOs],
      },
    });
  });
});
