// Tests that a configured (~-relative) agentDir is resolved with the caller's env/homedir rather
// than process.env, so the duplicate-agentDir guard does not false-negative when deps.env differs.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDuplicateAgentDirs } from "./agent-dirs.js";
import type { OpenClawConfig } from "./types.js";

describe("findDuplicateAgentDirs env forwarding", () => {
  it("expands a ~-relative configured agentDir with the caller's env/homedir, not process.env", () => {
    const customHome = path.join(path.sep, "custom-openclaw-home-4b");
    const deps = {
      env: { HOME: customHome, OPENCLAW_HOME: customHome } as NodeJS.ProcessEnv,
      homedir: () => customHome,
    };
    const dups = findDuplicateAgentDirs(
      {
        agents: {
          list: [
            { id: "a", agentDir: "~/shared" },
            { id: "b", agentDir: path.join(customHome, "shared") },
          ],
        },
      } as unknown as OpenClawConfig,
      deps,
    );
    // Under deps, "~/shared" expands to customHome/shared and collides with agent b => one duplicate.
    // On main the configured branch drops deps.env/homedir and expands "~" via process.env/os.homedir,
    // so agent a resolves elsewhere and the collision is missed (false negative => empty result).
    expect(dups).toEqual([{ agentDir: path.join(customHome, "shared"), agentIds: ["a", "b"] }]);
  });
});
