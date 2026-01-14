import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { withTempHome } from "../../test/helpers/temp-home.js";

describe("normalizeConfigPaths", () => {
  it("expands tilde for path-ish keys only", async () => {
    await withTempHome(async (home) => {
      vi.resetModules();
      const { normalizeConfigPaths } = await import("./normalize-paths.js");

      const cfg = normalizeConfigPaths({
        plugins: { load: { paths: ["~/plugins/a"] } },
        logging: { file: "~/.clawdbot/logs/clawdbot.log" },
        hooks: {
          path: "~/.clawdbot/hooks.json5",
          transformsDir: "~/hooks-xform",
        },
        channels: {
          telegram: {
            accounts: {
              personal: {
                tokenFile: "~/.clawdbot/telegram.token",
              },
            },
          },
          imessage: {
            accounts: { personal: { dbPath: "~/Library/Messages/chat.db" } },
          },
        },
        agents: {
          defaults: { workspace: "~/ws-default" },
          list: [
            {
              id: "main",
              workspace: "~/ws-agent",
              agentDir: "~/.clawdbot/agents/main",
              identity: {
                name: "~not-a-path",
              },
              sandbox: { workspaceRoot: "~/sandbox-root" },
            },
          ],
        },
      });

      expect(cfg.plugins?.load?.paths?.[0]).toBe(
        path.join(home, "plugins", "a"),
      );
      expect(cfg.logging?.file).toBe(
        path.join(home, ".clawdbot", "logs", "clawdbot.log"),
      );
      expect(cfg.hooks?.path).toBe(path.join(home, ".clawdbot", "hooks.json5"));
      expect(cfg.hooks?.transformsDir).toBe(path.join(home, "hooks-xform"));
      expect(cfg.channels?.telegram?.accounts?.personal?.tokenFile).toBe(
        path.join(home, ".clawdbot", "telegram.token"),
      );
      expect(cfg.channels?.imessage?.accounts?.personal?.dbPath).toBe(
        path.join(home, "Library", "Messages", "chat.db"),
      );
      expect(cfg.agents?.defaults?.workspace).toBe(
        path.join(home, "ws-default"),
      );
      expect(cfg.agents?.list?.[0]?.workspace).toBe(
        path.join(home, "ws-agent"),
      );
      expect(cfg.agents?.list?.[0]?.agentDir).toBe(
        path.join(home, ".clawdbot", "agents", "main"),
      );
      expect(cfg.agents?.list?.[0]?.sandbox?.workspaceRoot).toBe(
        path.join(home, "sandbox-root"),
      );

      // Non-path key => do not treat "~" as home expansion.
      expect(cfg.agents?.list?.[0]?.identity?.name).toBe("~not-a-path");
    });
  });
});
