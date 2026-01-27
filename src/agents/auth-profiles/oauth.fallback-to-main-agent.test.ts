import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiKeyForProfile } from "./oauth.js";
import { ensureAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

describe("resolveApiKeyForProfile fallback to main agent", () => {
  const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
  const previousAgentDir = process.env.CLAWDBOT_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tmpDir: string;
  let mainAgentDir: string;
  let secondaryAgentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-fallback-test-"));
    mainAgentDir = path.join(tmpDir, "agents", "main", "agent");
    secondaryAgentDir = path.join(tmpDir, "agents", "kids", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(secondaryAgentDir, { recursive: true });

    // Set environment variables so resolveClawdbotAgentDir() returns mainAgentDir
    process.env.CLAWDBOT_STATE_DIR = tmpDir;
    process.env.CLAWDBOT_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();

    // Restore original environment
    if (previousStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    if (previousAgentDir === undefined) delete process.env.CLAWDBOT_AGENT_DIR;
    else process.env.CLAWDBOT_AGENT_DIR = previousAgentDir;
    if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("falls back to main agent credentials when secondary agent token is expired and refresh fails", async () => {
    const profileId = "anthropic:claude-cli";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000; // 1 hour ago
    const freshTime = now + 60 * 60 * 1000; // 1 hour from now

    // Write expired credentials for secondary agent
    const secondaryStore: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "expired-access-token",
          refresh: "expired-refresh-token",
          expires: expiredTime,
        },
      },
    };
    await fs.writeFile(
      path.join(secondaryAgentDir, "auth-profiles.json"),
      JSON.stringify(secondaryStore),
    );

    // Write fresh credentials for main agent
    const mainStore: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "fresh-access-token",
          refresh: "fresh-refresh-token",
          expires: freshTime,
        },
      },
    };
    await fs.writeFile(path.join(mainAgentDir, "auth-profiles.json"), JSON.stringify(mainStore));

    // Mock fetch to simulate OAuth refresh failure
    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    // Load the secondary agent's store (will merge with main agent's store)
    const loadedSecondaryStore = ensureAuthProfileStore(secondaryAgentDir);

    // Call resolveApiKeyForProfile with the secondary agent's expired credentials
    // This should:
    // 1. Try to refresh the expired token (fails due to mocked fetch)
    // 2. Fall back to main agent's fresh credentials
    // 3. Copy those credentials to the secondary agent
    const result = await resolveApiKeyForProfile({
      store: loadedSecondaryStore,
      profileId,
      agentDir: secondaryAgentDir,
    });

    expect(result).not.toBeNull();
    expect(result?.apiKey).toBe("fresh-access-token");
    expect(result?.provider).toBe("anthropic");

    // Verify the credentials were copied to the secondary agent
    const updatedSecondaryStore = JSON.parse(
      await fs.readFile(path.join(secondaryAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(updatedSecondaryStore.profiles[profileId]).toMatchObject({
      access: "fresh-access-token",
      expires: freshTime,
    });
  });

  it("throws error when both secondary and main agent credentials are expired", async () => {
    const profileId = "anthropic:claude-cli";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000; // 1 hour ago

    // Write expired credentials for both agents
    const expiredStore: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "expired-access-token",
          refresh: "expired-refresh-token",
          expires: expiredTime,
        },
      },
    };
    await fs.writeFile(
      path.join(secondaryAgentDir, "auth-profiles.json"),
      JSON.stringify(expiredStore),
    );
    await fs.writeFile(path.join(mainAgentDir, "auth-profiles.json"), JSON.stringify(expiredStore));

    // Mock fetch to simulate OAuth refresh failure
    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const loadedSecondaryStore = ensureAuthProfileStore(secondaryAgentDir);

    // Should throw because both agents have expired credentials
    await expect(
      resolveApiKeyForProfile({
        store: loadedSecondaryStore,
        profileId,
        agentDir: secondaryAgentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed/);
  });
});
