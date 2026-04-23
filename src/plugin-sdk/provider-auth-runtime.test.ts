import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "./agent-runtime.js";
import * as providerAuthRuntime from "./provider-auth-runtime.js";

describe("plugin-sdk provider-auth-runtime", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-auth-runtime-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("exports the runtime-ready auth helper", () => {
    expect(typeof providerAuthRuntime.getRuntimeAuthForModel).toBe("function");
  });

  it("exports the Codex auth bridge helper", () => {
    expect(typeof providerAuthRuntime.prepareCodexAuthBridge).toBe("function");
  });

  it("exports OAuth callback helpers", () => {
    expect(typeof providerAuthRuntime.generateOAuthState).toBe("function");
    expect(typeof providerAuthRuntime.parseOAuthCallbackInput).toBe("function");
    expect(typeof providerAuthRuntime.waitForLocalOAuthCallback).toBe("function");
  });

  it("does not write incomplete Codex ChatGPT auth without an id token", async () => {
    const agentDir = await makeTempDir();
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

    const bridge = await providerAuthRuntime.prepareCodexAuthBridge({
      agentDir,
      bridgeDir: "harness-auth",
      profileId: "openai-codex:default",
    });

    expect(bridge).toBeUndefined();
  });

  it("hydrates missing Codex id token from a matching source auth file", async () => {
    const root = await makeTempDir();
    const agentDir = path.join(root, "agent");
    const sourceCodexHome = path.join(root, "codex-home");
    await fs.mkdir(sourceCodexHome, { recursive: true });
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
        },
        null,
        2,
      )}\n`,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            accountId: "acct-123",
            expires: Date.now() + 60_000,
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false },
    );

    const bridge = await providerAuthRuntime.prepareCodexAuthBridge({
      agentDir,
      bridgeDir: "harness-auth",
      profileId: "openai-codex:default",
      sourceCodexHome,
    });

    expect(bridge?.codexHome).toContain(path.join(agentDir, "harness-auth", "codex"));
    const authFile = JSON.parse(
      await fs.readFile(path.join(bridge?.codexHome ?? "", "auth.json"), "utf8"),
    );
    expect(authFile.tokens.id_token).toBe("source-id-token");
  });
});
