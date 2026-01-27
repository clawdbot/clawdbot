import path from "node:path";

import { describe, expect, it } from "vitest";

import handler from "./handler.js";
import { createHookEvent } from "../../hooks.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import type { MoltbotConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";

describe("soul-evil hook", () => {
  it("skips subagent sessions", async () => {
    const tempDir = await makeTempWorkspace("moltbot-soul-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: "SOUL_EVIL.md",
      content: "chaotic",
    });

    const cfg: MoltbotConfig = {
      hooks: {
        internal: {
          entries: {
            "soul-evil": { enabled: true, chance: 1 },
          },
        },
      },
    };
    const context: AgentBootstrapHookContext = {
      workspaceDir: tempDir,
      bootstrapFiles: [
        {
          name: "SOUL.md",
          path: path.join(tempDir, "SOUL.md"),
          content: "friendly",
          missing: false,
        },
      ],
      cfg,
      sessionKey: "agent:main:subagent:abc",
    };

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);

    expect(context.bootstrapFiles[0]?.content).toBe("friendly");
  });
});
