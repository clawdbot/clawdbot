import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenAICodexCliExecution } from "./openai-codex-cli-bridge.js";

describe("prepareOpenAICodexCliExecution", () => {
  const tempDirs: string[] = [];
  const resolveHashedCodexHome = (agentDir: string, profileId: string) =>
    path.join(
      agentDir,
      "cli-auth",
      "codex",
      crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 16),
    );

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes a private CODEX_HOME bridge from canonical OpenClaw oauth", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-bridge-"));
    tempDirs.push(agentDir);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            accountId: "acct-123",
            idToken: "id-token",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );

    const result = await prepareOpenAICodexCliExecution({
      config: undefined,
      workspaceDir: agentDir,
      agentDir,
      provider: "codex-cli",
      modelId: "gpt-5.4",
      authProfileId: "openai-codex:default",
    });

    expect(result).toMatchObject({
      env: {
        CODEX_HOME: expect.stringContaining(path.join(agentDir, "cli-auth", "codex")),
      },
      clearEnv: ["OPENAI_API_KEY"],
    });

    const authFile = JSON.parse(
      await fs.readFile(path.join(result?.env?.CODEX_HOME ?? "", "auth.json"), "utf8"),
    );
    expect(authFile).toEqual({
      auth_mode: "chatgpt",
      tokens: {
        id_token: "id-token",
        access_token: "access-token",
        refresh_token: "refresh-token",
        account_id: "acct-123",
      },
      last_refresh: expect.any(String),
    });
    if (process.platform !== "win32") {
      const authStat = await fs.stat(path.join(result?.env?.CODEX_HOME ?? "", "auth.json"));
      expect(authStat.mode & 0o777).toBe(0o600);
    }
  });

  it("returns null when there is no bridgeable canonical oauth credential", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-bridge-"));
    tempDirs.push(agentDir);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-test",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );

    await expect(
      prepareOpenAICodexCliExecution({
        config: undefined,
        workspaceDir: agentDir,
        agentDir,
        provider: "codex-cli",
        modelId: "gpt-5.4",
        authProfileId: "openai-codex:default",
      }),
    ).resolves.toBeNull();
  });

  it("refuses to overwrite a symlinked codex cli auth bridge file", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-bridge-"));
    tempDirs.push(agentDir);
    const codexHome = resolveHashedCodexHome(agentDir, "openai-codex:default");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.symlink(path.join(agentDir, "outside.txt"), path.join(codexHome, "auth.json"));
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );

    await expect(
      prepareOpenAICodexCliExecution({
        config: undefined,
        workspaceDir: agentDir,
        agentDir,
        provider: "codex-cli",
        modelId: "gpt-5.4",
        authProfileId: "openai-codex:default",
      }),
    ).rejects.toThrow("must not be a symlink");
  });
});
