import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  ensureAuthProfileStore,
} from "./auth-profiles.js";

describe("external CLI credential sync", () => {
  it("does not overwrite fresher store oauth with older CLI oauth", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-oauth-no-downgrade-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          // CLI has OAuth credentials expiring in 30 min
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "cli-oauth-access",
                refreshToken: "cli-refresh",
                expiresAt: Date.now() + 30 * 60 * 1000,
              },
            }),
          );

          const authPath = path.join(agentDir, "auth-profiles.json");
          // Store has OAuth credentials expiring in 60 min (later than CLI)
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CLAUDE_CLI_PROFILE_ID]: {
                  type: "oauth",
                  provider: "anthropic",
                  access: "store-oauth-access",
                  refresh: "store-refresh",
                  expires: Date.now() + 60 * 60 * 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);
          // Fresher store oauth should be kept
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe(
            "store-oauth-access",
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
  it("does not downgrade store oauth to token when CLI lacks refresh token", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-cli-no-downgrade-oauth-"),
    );
    try {
      await withTempHome(
        async (tempHome) => {
          const claudeDir = path.join(tempHome, ".claude");
          fs.mkdirSync(claudeDir, { recursive: true });
          // CLI has token-only credentials (no refresh token)
          fs.writeFileSync(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "cli-token-access",
                expiresAt: Date.now() + 30 * 60 * 1000,
              },
            }),
          );

          const authPath = path.join(agentDir, "auth-profiles.json");
          // Store already has OAuth credentials with refresh token
          fs.writeFileSync(
            authPath,
            JSON.stringify({
              version: 1,
              profiles: {
                [CLAUDE_CLI_PROFILE_ID]: {
                  type: "oauth",
                  provider: "anthropic",
                  access: "store-oauth-access",
                  refresh: "store-refresh",
                  expires: Date.now() + 60 * 60 * 1000,
                },
              },
            }),
          );

          const store = ensureAuthProfileStore(agentDir);
          // Keep oauth to preserve auto-refresh capability
          const cliProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
          expect(cliProfile.type).toBe("oauth");
          expect((cliProfile as { access: string }).access).toBe(
            "store-oauth-access",
          );
        },
        { prefix: "clawdbot-home-" },
      );
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
