// Verifies multi-agent agent directory validation and rejection paths.
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";
import { validateConfigObject } from "./validation.js";

describe("multi-agent agentDir validation", () => {
  it("rejects shared agents.entries agentDir", () => {
    const shared = path.join(tmpdir(), "openclaw-shared-agentdir");
    const res = validateConfigObject({
      agents: {
        entries: { a: { agentDir: shared, default: true }, b: { agentDir: shared } },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual([
        {
          path: "agents.entries",
          message: `Duplicate agentDir detected (multi-agent config).
Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.

Conflicts:
- ${shared}: "a", "b"

Fix: remove the shared agents.entries.*.agentDir override (or give each agent its own directory).
If you want to share credentials, copy auth-profiles.json instead of sharing the entire agentDir.`,
        },
      ]);
    }
  });

  it("throws on shared agentDir during getRuntimeConfig()", async () => {
    await withTempHomeConfig(
      {
        agents: {
          entries: {
            a: { agentDir: "~/.openclaw/agents/shared/agent" },
            b: { agentDir: "~/.openclaw/agents/shared/agent" },
          },
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
