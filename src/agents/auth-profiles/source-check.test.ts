import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasAuthProfileStoreSourceForProvider } from "./source-check.js";

describe("hasAuthProfileStoreSourceForProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function withAgentStore(profiles: Record<string, unknown>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-source-"));
    const stateDir = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles }),
    );
    return { agentDir };
  }

  async function withLegacyAuthStore(profiles: Record<string, unknown>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-source-"));
    const stateDir = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(profiles));
    return { agentDir };
  }

  it("counts provider-specific usable credentials", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(true);
  });

  it("counts legacy auth stores with alias fields and fallback providers", async () => {
    const { agentDir } = await withLegacyAuthStore({
      openai: { mode: "apiKey", apiKey: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(true);
  });

  it("ignores malformed provider fields instead of throwing", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", key: "sk-test" },
      "openai:other": { type: "api_key", provider: 123, key: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("does not count profile ids that are bound to a different credential provider", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("honors configured profile order constraints", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
      "openai:expired": {
        type: "token",
        provider: "openai",
        token: "expired-token",
        expires: Date.now() - 1000,
      },
    });

    expect(
      hasAuthProfileStoreSourceForProvider("openai", agentDir, {
        profileIds: ["openai:expired"],
      }),
    ).toBe(false);
    expect(
      hasAuthProfileStoreSourceForProvider("openai", agentDir, {
        profileIds: ["openai:default"],
      }),
    ).toBe(true);
  });

  it("treats explicit empty profile order as no usable profile", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
    });

    expect(
      hasAuthProfileStoreSourceForProvider("openai", agentDir, {
        profileIds: [],
      }),
    ).toBe(false);
  });

  it("does not count empty provider profiles as credential evidence", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", provider: "openai" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("does not count expired token profiles as credential evidence", async () => {
    const { agentDir } = await withAgentStore({
      "openai:token": {
        type: "token",
        provider: "openai",
        token: "expired-token",
        expires: Date.now() - 1000,
      },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });
});
