import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(() => [
    { agentDir: "/tmp/main", authPath: "/tmp/main/auth-profiles.json" },
  ]),
  loadStore: vi.fn<() => AuthProfileStore | null>(() => null),
  resolveExternalCliAuthProfiles: vi.fn<() => unknown[]>(() => []),
  runTransaction: vi.fn((_agentDir, callback) => callback({})),
  saveStore: vi.fn(),
}));

vi.mock("./doctor-auth-legacy-paths.js", () => ({
  listAuthProfileRepairCandidates: mocks.listCandidates,
}));
vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: mocks.loadStore,
}));
vi.mock("../agents/auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: mocks.resolveExternalCliAuthProfiles,
}));
vi.mock("../agents/auth-profiles/sqlite.js", () => ({
  runAuthProfileWriteTransaction: mocks.runTransaction,
}));
vi.mock("../agents/auth-profiles/store.js", () => ({ saveAuthProfileStore: mocks.saveStore }));

import { maybeMigrateExternalCliProfileMetadata } from "./doctor-external-cli-profiles.js";

afterEach(() => vi.clearAllMocks());

describe("external CLI auth profile doctor migration", () => {
  it("leaves legacy MiniMax metadata outside the Claude migration scope", () => {
    const profileId = "minimax-portal:minimax-cli";
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "minimax", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "minimax", mode: "token" });
    expect(mocks.resolveExternalCliAuthProfiles).not.toHaveBeenCalled();
    expect(mocks.saveStore).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], configChanged: false });
  });

  it("persists the CLI credential before canonicalizing legacy Claude metadata", () => {
    const profileId = "anthropic:claude-cli";
    mocks.resolveExternalCliAuthProfiles.mockReturnValueOnce([
      {
        profileId,
        persistence: "persisted",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 30 * 60_000,
          email: "stored@example.com",
        },
      },
    ]);
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "claude-cli", mode: "oauth" });
    expect(mocks.resolveExternalCliAuthProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ profiles: {} }),
      expect.objectContaining({ profileIds: [profileId], allowKeychainPrompt: false }),
    );
    expect(mocks.saveStore).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: expect.objectContaining({
          [profileId]: expect.objectContaining({ type: "oauth" }),
        }),
      }),
      "/tmp/main",
      { syncExternalCli: false },
      {},
    );
    expect(result).toMatchObject({ configChanged: true, warnings: [] });
  });

  it("keeps legacy metadata when the imported CLI credential has no identity", () => {
    const profileId = "anthropic:claude-cli";
    mocks.resolveExternalCliAuthProfiles.mockReturnValueOnce([
      {
        profileId,
        persistence: "persisted",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 30 * 60_000,
        },
      },
    ]);
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "anthropic", mode: "token" });
    expect(mocks.saveStore).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: expect.objectContaining({
          [profileId]: expect.objectContaining({ type: "oauth" }),
        }),
      }),
      "/tmp/main",
      { syncExternalCli: false },
      {},
    );
    expect(result).toMatchObject({ configChanged: false });
    expect(result.warnings).toContain(
      "Kept legacy external CLI metadata for anthropic:claude-cli: identity-complete OAuth credentials were not saved for every auth profile store.",
    );
  });

  it("keeps legacy metadata when no current CLI credential can be persisted", () => {
    const profileId = "anthropic:claude-cli";
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "anthropic", mode: "token" });
    expect(mocks.saveStore).not.toHaveBeenCalled();
    expect(result).toMatchObject({ configChanged: false });
    expect(result.warnings).toContain(
      "Kept legacy external CLI metadata for anthropic:claude-cli: identity-complete OAuth credentials were not saved for every auth profile store.",
    );
  });

  it("canonicalizes legacy metadata for an already-valid persisted CLI credential", () => {
    const profileId = "anthropic:claude-cli";
    mocks.loadStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "claude-cli",
          access: "stored-access",
          refresh: "stored-refresh",
          expires: Date.now() + 30 * 60_000,
          email: "stored@example.com",
        },
      },
    });
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "claude-cli", mode: "oauth" });
    expect(mocks.saveStore).not.toHaveBeenCalled();
    expect(result).toMatchObject({ configChanged: true, warnings: [] });
  });

  it("keeps legacy metadata when the credential store write fails", () => {
    const profileId = "anthropic:claude-cli";
    mocks.resolveExternalCliAuthProfiles.mockReturnValueOnce([
      {
        profileId,
        persistence: "persisted",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 60_000,
        },
      },
    ]);
    mocks.runTransaction.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "anthropic", mode: "token" });
    expect(result).toMatchObject({ configChanged: false });
    expect(result.warnings).toContain(
      "Could not persist external CLI OAuth credentials for /tmp/main: database unavailable",
    );
  });
});
