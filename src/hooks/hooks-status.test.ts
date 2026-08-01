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
});
