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
      expect(res.issues.map((issue) => issue.path)).toContain("agents.list");
      expect(res.issues[0]?.message).toContain("Duplicate agentDir");
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
