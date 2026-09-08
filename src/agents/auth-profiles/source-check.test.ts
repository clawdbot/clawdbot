import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAuthProfileMigrationDiagnostics } from "./legacy-source-diagnostic.js";
import { hasAuthProfileStoreSourceForProvider } from "./source-check.js";
import { readPersistedAuthProfileStoreRaw, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { loadAuthProfileStoreForRuntime, updateAuthProfileStoreWithLock } from "./store-runtime.js";

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
    writePersistedAuthProfileStoreRaw({ version: 1, profiles }, agentDir);
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
    expect(() => loadAuthProfileStoreForRuntime(agentDir)).toThrow(
      "requires legacy credential migration",
    );
    await fs.rename(path.join(agentDir, "auth.json"), path.join(agentDir, "auth.json.migrated"));
    clearAuthProfileMigrationDiagnostics();
    expect(loadAuthProfileStoreForRuntime(agentDir).profiles).toEqual({});
  });

  it("ignores malformed provider fields instead of throwing", async () => {
    const { agentDir } = await withAgentStore({
      "openai:default": { type: "api_key", key: "sk-test" },
      "openai:other": { type: "api_key", provider: 123, key: "sk-test" },
    });

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(false);
  });

  it("routes structurally unreadable SQLite rows through the fail-closed loader", async () => {
    const { agentDir } = await withAgentStore({});
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: "invalid-profile-map" }, agentDir);

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(true);
    expect(() => loadAuthProfileStoreForRuntime(agentDir)).toThrow("is unreadable");
  });

  it("rejects structurally unreadable rows inside write transactions", async () => {
    const { agentDir } = await withAgentStore({});
    const unreadableStore = { version: 1, profiles: "invalid-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);
    const updater = vi.fn(() => true);

    // The unreadable store names its own remediation; a null return would make
    // callers report generic lock contention instead.
    await expect(updateAuthProfileStoreWithLock({ agentDir, updater })).rejects.toThrow(
      "is unreadable; run openclaw doctor --fix",
    );
    expect(updater).not.toHaveBeenCalled();
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
  });

  it("returns null for classified SQLite lock contention", async () => {
    const { agentDir } = await withAgentStore({});
    const lockError = Object.assign(new Error("database is locked"), { errcode: 5 });

    await expect(
      updateAuthProfileStoreWithLock({
        agentDir,
        updater: () => {
          throw lockError;
        },
      }),
    ).resolves.toBeNull();
  });

  it("detects a legacy credential source that appears after an earlier clean load", async () => {
    const { agentDir } = await withAgentStore({});
    expect(loadAuthProfileStoreForRuntime(agentDir).profiles).toEqual({});

    await fs.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "fake-late-key" } }),
    );

    expect(hasAuthProfileStoreSourceForProvider("openai", agentDir)).toBe(true);
    expect(() => loadAuthProfileStoreForRuntime(agentDir)).toThrow(
      "requires legacy credential migration",
    );
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
