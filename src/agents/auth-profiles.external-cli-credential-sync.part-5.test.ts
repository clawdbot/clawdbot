import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
} from "./auth-profiles.js";

describe("external CLI credential sync", () => {
  it("updates codex-cli profile when Codex CLI refresh token changes", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-codex-refresh-sync-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          const codexDir = path.join(tempHome, ".codex");
          fs.mkdirSync(codexDir, { recursive: true });
          const codexAuthPath = path.join(codexDir, "auth.json");
          fs.writeFileSync(
            codexAuthPath,
            JSON.stringify({
              tokens: {
                access_token: "same-access",
                refresh_token: "new-refresh",
              },
            }),
          );
          fs.utimesSync(codexAuthPath, new Date(), new Date());

          const authPath = path.join(agentDir, "auth-profiles.json");
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CODEX_CLI_PROFILE_ID]: {
                  type: "oauth",
                  provider: "openai-codex",
                  access: "same-access",
                  refresh: "old-refresh",
                  expires: Date.now() - 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);
          expect(
            (store.profiles[CODEX_CLI_PROFILE_ID] as { refresh: string })
              .refresh,
          ).toBe("new-refresh");
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
