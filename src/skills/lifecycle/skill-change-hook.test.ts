import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { dispatchCommittedSkillChangeBestEffort } from "./skill-change-hook.js";

afterEach(() => resetGlobalHookRunner());

describe("committed skill change dispatch", () => {
  it("emits a committed mutation when artifact snapshots are unavailable", async () => {
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));

    await dispatchCommittedSkillChangeBestEffort({
      action: "created",
      source: "source-install",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        source: "source-install",
      }),
      { workspaceDir: "/tmp/openclaw-workspace" },
    );
  });
});
