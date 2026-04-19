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

  beforeAll(async () => {
    ({ bridgeCodexAppServerStartOptions } = await import("./auth-bridge.js"));
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("bridges canonical OpenClaw oauth into an isolated CODEX_HOME", async () => {
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
            accountId: "acct-123",
            idToken: "id-token",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );

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
    });
    if (process.platform !== "win32") {
      const authStat = await fs.stat(path.join(result.env?.CODEX_HOME ?? "", "auth.json"));
      expect(authStat.mode & 0o777).toBe(0o600);
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
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );

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
