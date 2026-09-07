/** Tests interactive and noninteractive secrets configure flows. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmMock = vi.hoisted(() => vi.fn());
const selectMock = vi.hoisted(() => vi.fn());
const createSecretsConfigIOMock = vi.hoisted(() => vi.fn());
const loadPersistedAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryMock = vi.hoisted(() => vi.fn());
const runSecretsApplyMock = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  select: (...args: unknown[]) => selectMock(...args),
  text: vi.fn(),
  log: { warn: (...args: unknown[]) => logMock(...args) },
}));

vi.mock("./config-io.js", () => ({
  createSecretsConfigIO: (...args: unknown[]) => createSecretsConfigIOMock(...args),
}));

vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: (...args: unknown[]) => loadPersistedAuthProfileStoreMock(...args),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: (...args: unknown[]) => loadPluginManifestRegistryMock(...args),
}));

vi.mock("./apply.js", () => ({
  runSecretsApply: (...args: unknown[]) => runSecretsApplyMock(...args),
}));

import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

const { runSecretsConfigureInteractive } = await import("./configure.js");

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secrets-configure-"));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

/**
 * Writes the canonical shared auth-profile store payload into the state
 * database (`authProfiles.store` row of `config_machine_state`) and marks the
 * ownership as `state-db` so `readPersistedSharedAuthProfileStoreRaw` resolves
 * the same row configure reads at runtime. Uses the raw row (no normalization)
 * so a stored `key` survives even when a sibling `keyRef` is present.
 */
function writeSharedAuthProfileStoreRaw(env: NodeJS.ProcessEnv, payload: unknown): void {
  noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
  const { db } = openOpenClawStateDatabase({ env });
  try {
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
    ).run("authProfiles.store", JSON.stringify(payload));
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

describe("runSecretsConfigureInteractive", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    confirmMock.mockReset();
    selectMock.mockReset();
    createSecretsConfigIOMock.mockReset();
    loadPersistedAuthProfileStoreMock.mockReset();
    logMock.mockReset();
    loadPluginManifestRegistryMock.mockReset();
    loadPluginManifestRegistryMock.mockReturnValue({ diagnostics: [], plugins: [] });
    runSecretsApplyMock.mockReset();
    runSecretsApplyMock.mockResolvedValue({
      changed: true,
      changedFiles: [],
      warningCount: 0,
      warnings: [],
      checks: { resolvabilityComplete: true },
      skippedExecRefs: 0,
    });
  });

  it("does not load auth-profiles when running providers-only", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    selectMock.mockResolvedValue("continue");
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });
    await expect(runSecretsConfigureInteractive({ providersOnly: true })).rejects.toThrow(
      "No secrets changes were selected.",
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("adds a plugin preset provider through providers-only configure", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const pluginRoot = makeTempDir();
    const resolverPath = path.join(pluginRoot, "vault-secret-ref-resolver.js");
    fs.writeFileSync(resolverPath, "process.stdin.resume();\n");
    fs.chmodSync(resolverPath, 0o600);
    selectMock.mockResolvedValueOnce("preset");
    selectMock.mockResolvedValueOnce("vault:vault:vault");
    selectMock.mockResolvedValueOnce("continue");
    loadPluginManifestRegistryMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "vault",
          name: "Vault",
          origin: "global",
          rootDir: pluginRoot,
          secretProviderIntegrations: {
            vault: {
              providerAlias: "vault",
              displayName: "HashiCorp Vault",
              source: "exec",
              command: "${node}",
              args: ["./vault-secret-ref-resolver.js"],
              passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
              timeoutMs: 5000,
            },
          },
        },
      ],
    });
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });

    const result = await runSecretsConfigureInteractive({
      providersOnly: true,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.plan.targets).toEqual([]);
    expect(result.plan.providerUpserts?.vault).toEqual({
      source: "exec",
      pluginIntegration: {
        pluginId: "vault",
        integrationId: "vault",
      },
    });
    expect(runSecretsApplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          providerUpserts: expect.objectContaining({
            vault: expect.objectContaining({ source: "exec" }),
          }),
        }),
        write: false,
        allowExec: false,
      }),
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("warns when the shared auth-profile store carries plaintext credentials", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    // Shared store carries plaintext `key` values. The first profile is pure
    // plaintext; the second carries `key` AND a sibling `keyRef`, which the
    // normalized loader drops — reading the raw row (as `secrets audit` does)
    // is required to still see that plaintext. `secrets configure` only edits
    // the selected agent's local store, so neither is migratable here.
    const stateDir = makeTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    writeSharedAuthProfileStoreRaw(env, {
      version: 1,
      profiles: {
        "openai:shared": {
          type: "api_key",
          provider: "openai",
          key: "sk-shared-plaintext", // pragma: allowlist secret
        },
        "openai:plaintext-with-ref": {
          type: "api_key",
          provider: "openai",
          key: "sk-leftover-plaintext", // pragma: allowlist secret
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });
    // Agent store empty + no config secret targets → no configurable candidates.
    // The shared-plaintext warning fires before the empty-candidate guard.
    loadPersistedAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {},
    });
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });

    await expect(
      runSecretsConfigureInteractive({
        providersOnly: false,
        skipProviderSetup: true,
        env,
      }),
    ).rejects.toThrow("No configurable secret-bearing fields found for this agent scope.");

    expect(logMock).toHaveBeenCalledTimes(1);
    const message = String(logMock.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("Shared auth-profile store");
    expect(message).toContain("2 plaintext credential(s)");
    expect(message).toContain("cannot migrate shared credentials");
  });

  it("does not warn when shared profiles only carry SecretRef values", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    // Shared store profiles are all references, not plaintext: an explicit
    // `keyRef` object, a `$ENV` shorthand, and a `${ENV}` template. The latter
    // two have no `keyRef`; without sharing audit's `coerceSecretRef` check the
    // counter would miscount them as plaintext.
    const stateDir = makeTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    writeSharedAuthProfileStoreRaw(env, {
      version: 1,
      profiles: {
        "openai:ref": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        "openai:dollar": {
          type: "api_key",
          provider: "openai",
          key: "$OPENAI_API_KEY", // pragma: allowlist secret
        },
        "openai:braced": {
          type: "api_key",
          provider: "openai",
          key: "${OPENAI_API_KEY}", // pragma: allowlist secret
        },
      },
    });
    loadPersistedAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {},
    });
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });

    await expect(
      runSecretsConfigureInteractive({
        providersOnly: false,
        skipProviderSetup: true,
        env,
      }),
    ).rejects.toThrow("No configurable secret-bearing fields found for this agent scope.");

    expect(logMock).not.toHaveBeenCalled();
  });

  it("does not warn when the shared auth-profile store is missing", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    // No shared store row committed → no plaintext to report.
    const stateDir = makeTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    loadPersistedAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {},
    });
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });

    await expect(
      runSecretsConfigureInteractive({
        providersOnly: false,
        skipProviderSetup: true,
        env,
      }),
    ).rejects.toThrow("No configurable secret-bearing fields found for this agent scope.");

    expect(logMock).not.toHaveBeenCalled();
  });
});
