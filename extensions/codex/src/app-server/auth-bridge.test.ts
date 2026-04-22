import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let bridgeCodexAppServerStartOptions: typeof import("./auth-bridge.js").bridgeCodexAppServerStartOptions;

describe("bridgeCodexAppServerStartOptions", () => {
  const tempDirs: string[] = [];
  const resolveHashedCodexHome = (agentDir: string, profileId: string) =>
    path.join(
      agentDir,
      "harness-auth",
      "codex",
      crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 16),
    );

  async function createAgentDirWithDefaultProfile(
    profile: Record<string, unknown> = {},
  ): Promise<string> {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
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
            ...profile,
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );
    return agentDir;
  }

  beforeAll(async () => {
    ({ bridgeCodexAppServerStartOptions } = await import("./auth-bridge.js"));
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("bridges canonical OpenClaw oauth into an isolated CODEX_HOME", async () => {
    const agentDir = await createAgentDirWithDefaultProfile({
      accountId: "acct-123",
      idToken: "id-token",
    });

    const result = await bridgeCodexAppServerStartOptions({
      startOptions: {
        transport: "stdio",
        command: "codex",
        args: ["app-server"],
        headers: { authorization: "Bearer dev-token" },
        env: { EXISTING: "1" },
        clearEnv: ["FOO"],
      },
      agentDir,
    });

    expect(result).toMatchObject({
      env: {
        EXISTING: "1",
        CODEX_HOME: expect.stringContaining(path.join(agentDir, "harness-auth", "codex")),
      },
      clearEnv: expect.arrayContaining(["FOO", "OPENAI_API_KEY"]),
    });

    const authFile = JSON.parse(
      await fs.readFile(path.join(result.env?.CODEX_HOME ?? "", "auth.json"), "utf8"),
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
      const authStat = await fs.stat(path.join(result.env?.CODEX_HOME ?? "", "auth.json"));
      expect(authStat.mode & 0o777).toBe(0o600);
    }
  });

  it("hydrates Codex-only auth fields from a matching Codex CLI auth file", async () => {
    const sourceCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-source-home-"));
    tempDirs.push(sourceCodexHome);
    await fs.writeFile(
      path.join(sourceCodexHome, "auth.json"),
      `${JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            id_token: "source-id-token",
            access_token: "access-token",
            refresh_token: "refresh-token",
            account_id: "acct-123",
          },
          last_refresh: "2026-04-22T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    const agentDir = await createAgentDirWithDefaultProfile({
      accountId: "acct-123",
    });

    const result = await bridgeCodexAppServerStartOptions({
      startOptions: {
        transport: "stdio",
        command: "codex",
        args: ["app-server"],
        headers: {},
        env: { CODEX_HOME: sourceCodexHome },
      },
      agentDir,
    });

    expect(result.env?.CODEX_HOME).not.toBe(sourceCodexHome);
    const authFile = JSON.parse(
      await fs.readFile(path.join(result.env?.CODEX_HOME ?? "", "auth.json"), "utf8"),
    );
    expect(authFile).toEqual({
      auth_mode: "chatgpt",
      tokens: {
        id_token: "source-id-token",
        access_token: "access-token",
        refresh_token: "refresh-token",
        account_id: "acct-123",
      },
      last_refresh: "2026-04-22T00:00:00.000Z",
    });
  });

  it("keeps the selected profile tokens when hydrating from a same-account Codex CLI auth file", async () => {
    const sourceCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-source-home-"));
    tempDirs.push(sourceCodexHome);
    await fs.writeFile(
      path.join(sourceCodexHome, "auth.json"),
      `${JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            id_token: "source-id-token",
            access_token: "stale-source-access-token",
            refresh_token: "stale-source-refresh-token",
            account_id: "acct-123",
          },
          last_refresh: "2026-04-22T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    const agentDir = await createAgentDirWithDefaultProfile({
      access: "selected-profile-access-token",
      refresh: "selected-profile-refresh-token",
      accountId: "acct-123",
      idToken: "selected-profile-id-token",
    });

    const result = await bridgeCodexAppServerStartOptions({
      startOptions: {
        transport: "stdio",
        command: "codex",
        args: ["app-server"],
        headers: {},
        env: { CODEX_HOME: sourceCodexHome },
      },
      agentDir,
    });

    expect(result.env?.CODEX_HOME).not.toBe(sourceCodexHome);
    const authFile = JSON.parse(
      await fs.readFile(path.join(result.env?.CODEX_HOME ?? "", "auth.json"), "utf8"),
    );
    expect(authFile).toEqual({
      auth_mode: "chatgpt",
      tokens: {
        id_token: "selected-profile-id-token",
        access_token: "selected-profile-access-token",
        refresh_token: "selected-profile-refresh-token",
        account_id: "acct-123",
      },
      last_refresh: "2026-04-22T00:00:00.000Z",
    });
  });

  it("hydrates from inherited CODEX_HOME when start options do not override it", async () => {
    const sourceCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-source-home-"));
    tempDirs.push(sourceCodexHome);
    await fs.writeFile(
      path.join(sourceCodexHome, "auth.json"),
      `${JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            id_token: "source-id-token",
            access_token: "access-token",
            refresh_token: "refresh-token",
            account_id: "acct-123",
          },
          last_refresh: "2026-04-22T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sourceCodexHome;
    try {
      const agentDir = await createAgentDirWithDefaultProfile({
        accountId: "acct-123",
      });

      const result = await bridgeCodexAppServerStartOptions({
        startOptions: {
          transport: "stdio",
          command: "codex",
          args: ["app-server"],
          headers: {},
        },
        agentDir,
      });

      expect(result.env?.CODEX_HOME).not.toBe(sourceCodexHome);
      const authFile = JSON.parse(
        await fs.readFile(path.join(result.env?.CODEX_HOME ?? "", "auth.json"), "utf8"),
      );
      expect(authFile).toEqual({
        auth_mode: "chatgpt",
        tokens: {
          id_token: "source-id-token",
          access_token: "access-token",
          refresh_token: "refresh-token",
          account_id: "acct-123",
        },
        last_refresh: "2026-04-22T00:00:00.000Z",
      });
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("leaves start options unchanged when canonical oauth is unavailable", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    tempDirs.push(agentDir);
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      args: ["app-server"],
      headers: { authorization: "Bearer dev-token" },
    };
    saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, {
      filterExternalAuthProfiles: false,
    });

    await expect(
      bridgeCodexAppServerStartOptions({
        startOptions,
        agentDir,
        authProfileId: "openai-codex:missing",
      }),
    ).resolves.toEqual(startOptions);
  });

  it("refuses to overwrite a symlinked auth bridge file", async () => {
    const agentDir = await createAgentDirWithDefaultProfile();

    const codexHome = resolveHashedCodexHome(agentDir, "openai-codex:default");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.symlink(path.join(agentDir, "outside.txt"), path.join(codexHome, "auth.json"));

    await expect(
      bridgeCodexAppServerStartOptions({
        startOptions: {
          transport: "stdio",
          command: "codex",
          args: ["app-server"],
          headers: {},
        },
        agentDir,
      }),
    ).rejects.toThrow("must not be a symlink");
  });
});
