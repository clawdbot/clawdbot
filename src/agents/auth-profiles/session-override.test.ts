import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

async function writeAuthStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: {
      zai: ["zai:work"],
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

describe("resolveSessionAuthProfileOverride", () => {
  it("keeps user override when provider alias differs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    process.env.CLAWDBOT_STATE_DIR = tmpDir;
    try {
      const agentDir = path.join(tmpDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as MoltbotConfig,
        provider: "z.ai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("zai:work");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    } finally {
      if (prevStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
