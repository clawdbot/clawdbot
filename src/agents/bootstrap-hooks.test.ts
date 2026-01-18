import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { DEFAULT_SOUL_FILENAME, type WorkspaceBootstrapFile } from "./workspace.js";

function makeFile(name = DEFAULT_SOUL_FILENAME): WorkspaceBootstrapFile {
  return {
    name,
    path: `/tmp/${name}`,
    content: "base",
    missing: false,
  };
}

describe("applyBootstrapHookOverrides", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns updated files when a hook mutates the context", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        { name: "EXTRA.md", path: "/tmp/EXTRA.md", content: "extra", missing: false },
      ];
    });

    const updated = await applyBootstrapHookOverrides({
      files: [makeFile()],
      workspaceDir: "/tmp",
    });

    expect(updated).toHaveLength(2);
    expect(updated[1]?.name).toBe("EXTRA.md");
  });
});
