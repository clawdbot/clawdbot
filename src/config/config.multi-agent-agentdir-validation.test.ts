import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";
import { validateConfigObject } from "./validation.js";

describe("multi-agent agentDir validation", () => {
  it("rejects shared agents.list agentDir", () => {
    const shared = path.join(tmpdir(), "openclaw-shared-agentdir");
    const res = validateConfigObject({
      agents: {
        list: [
          { id: "a", agentDir: shared },
          { id: "b", agentDir: shared },
        ],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual([
        {
          path: "agents.list",
          message: `Duplicate agentDir detected (multi-agent config).
Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.

Conflicts:
- ${shared}: "a", "b"

Fix: remove the shared agents.list[].agentDir override (or give each agent its own directory).
If you want to share credentials, copy auth-profiles.json instead of sharing the entire agentDir.`,
        },
      ]);
    }
  });

  it("throws on shared agentDir during getRuntimeConfig()", async () => {
    await withTempHomeConfig(
      {
        agents: {
          list: [
            { id: "a", agentDir: "~/.openclaw/agents/shared/agent" },
            { id: "b", agentDir: "~/.openclaw/agents/shared/agent" },
          ],
        },
        bindings: [{ agentId: "a", match: { channel: "forum" } }],
      },
      async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => getRuntimeConfig()).toThrow(/duplicate agentDir/i);
        expect(spy.mock.calls.flat().join(" ")).toMatch(/Duplicate agentDir/i);
        spy.mockRestore();
      },
    );
  });
});
