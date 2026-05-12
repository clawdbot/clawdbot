import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveAuthStorePath } from "./paths.js";
import { promoteAuthProfileInOrder } from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

function readPersistedTree(rootDir: string): string {
  const chunks: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile()) {
        chunks.push(fs.readFileSync(entryPath, "utf8"));
      }
    }
  };
  visit(rootDir);
  return chunks.join("\n");
}

function findFilesNamed(rootDir: string, basename: string): string[] {
  const matches: string[] = [];
  const visit = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === basename) {
        matches.push(entryPath);
      }
    }
  };
  visit(rootDir);
  return matches;
}

function isPathInsideOrEqual(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function expectOAuthProfileRefId(value: unknown): asserts value is string {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new Error("Expected OAuth profile ref id");
  }
  expect(value).toMatch(/^[a-f0-9]{32}$/);
}

function readPersistedOAuthRefId(agentDir: string, profileId: string): string {
  const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
    profiles: Record<string, { oauthRef?: { id?: string } }>;
  };
  const refId = persisted.profiles[profileId]?.oauthRef?.id;
  expectOAuthProfileRefId(refId);
  return refId;
}

function resolvePersistedOAuthSecretPath(refId: string): string {
  return path.join(resolveOAuthDir(), "auth-profiles", `${refId}.json`);
}

function resolveAuthStoreLockPath(authPath: string): string {
  return `${path.join(fs.realpathSync(path.dirname(authPath)), path.basename(authPath))}.lock`;
}

type ExpectedOAuthCredentialFields = {
  provider: string;
  access?: string;
  refresh?: string;
  idToken?: string;
  expires?: number;
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
};

function expectOAuthCredentialFields(
  value: unknown,
  expected: ExpectedOAuthCredentialFields,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected OAuth credential object");
  }
  const credential = value as Record<string, unknown>;
  expect(credential.type).toBe("oauth");
  expect(credential.provider).toBe(expected.provider);
  for (const field of [
    "access",
    "refresh",
    "idToken",
    "expires",
    "email",
    "accountId",
    "chatgptPlanType",
  ] as const) {
    if (field in expected) {
      expect(credential[field]).toBe(expected[field]);
    }
  }
  return credential;
}

function expectOpenClawCredentialsOAuthRef(
  credential: Record<string, unknown>,
  provider: string,
): void {
  const oauthRef = credential.oauthRef;
  if (!oauthRef || typeof oauthRef !== "object") {
    throw new Error("Expected OAuth credential ref");
  }
  const ref = oauthRef as Record<string, unknown>;
  expect(ref.source).toBe("openclaw-credentials");
  expect(ref.provider).toBe(provider);
  expectOAuthProfileRefId(ref.id);
}

describe("promoteAuthProfileInOrder", () => {
  it("omits inline openai-codex oauth secrets from persisted auth profile files", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-metadata-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "local-access-token",
              refresh: "local-refresh-token",
              idToken: "local-id-token",
              expires,
              email: "dev@example.test",
              accountId: "acct-local",
              chatgptPlanType: "plus",
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      const credential = persisted.profiles[profileId];

      expectOpenClawCredentialsOAuthRef(
        expectOAuthCredentialFields(credential, {
          provider: "openai-codex",
          expires,
          email: "dev@example.test",
          accountId: "acct-local",
          chatgptPlanType: "plus",
        }),
        "openai-codex",
      );
      expect(credential).not.toHaveProperty("access");
      expect(credential).not.toHaveProperty("refresh");
      expect(credential).not.toHaveProperty("idToken");
      expect(JSON.stringify(persisted)).not.toContain("local-access-token");
      expect(JSON.stringify(persisted)).not.toContain("local-refresh-token");
      expect(JSON.stringify(persisted)).not.toContain("local-id-token");
      const persistedStateTree = readPersistedTree(stateDir);
      expect(persistedStateTree).not.toContain("local-access-token");
      expect(persistedStateTree).not.toContain("local-refresh-token");
      expect(persistedStateTree).not.toContain("local-id-token");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "local-access-token",
          refresh: "local-refresh-token",
          idToken: "local-id-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("requires the external oauth profile secret key to recover persisted token material", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-keyed-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = "correct-profile-secret-key";
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "keyed-access-token",
              refresh: "keyed-refresh-token",
              expires,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persistedStateTree = readPersistedTree(stateDir);
      expect(persistedStateTree).not.toContain("keyed-access-token");
      expect(persistedStateTree).not.toContain("keyed-refresh-token");

      process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = "wrong-profile-secret-key";
      clearRuntimeAuthProfileStoreSnapshots();
      {
        const credential = loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[
          profileId
        ] as Record<string, unknown> | undefined;
        expect(credential?.access).not.toBe("keyed-access-token");
        expect(credential?.refresh).not.toBe("keyed-refresh-token");
      }

      process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = "correct-profile-secret-key";
      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "keyed-access-token",
          refresh: "keyed-refresh-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not create fallback oauth key files under the Vitest NODE_ENV test harness", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-test-key-"));
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const homeDir = path.join(rootDir, "home");
    const configDir = path.join(rootDir, "config");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVitest = process.env.VITEST;
    const previousHome = process.env.HOME;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAppData = process.env.APPDATA;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.APPDATA = configDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "test-env-access-token",
              refresh: "test-env-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      expect(findFilesNamed(rootDir, "auth-profile-secret-key")).toEqual([]);
      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "test-env-access-token",
          refresh: "test-env-refresh-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitest;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      if (previousAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = previousAppData;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does not use the hardcoded oauth key for NODE_ENV test outside the harness", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-node-env-test-"));
    const stateDir = path.join(rootDir, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const homeDir = path.join(rootDir, "home");
    const configDir = path.join(rootDir, "config");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVitest = process.env.VITEST;
    const previousHome = process.env.HOME;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAppData = process.env.APPDATA;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.APPDATA = configDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "node-env-test-access-token",
              refresh: "node-env-test-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      expect(findFilesNamed(rootDir, "auth-profile-secret-key")).toHaveLength(1);
      clearRuntimeAuthProfileStoreSnapshots();
      delete process.env.NODE_ENV;
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "node-env-test-access-token",
          refresh: "node-env-test-refresh-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitest;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      if (previousAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = previousAppData;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("persists production oauth profiles on non-macOS without an env secret key", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-prod-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const homeDir = path.join(path.dirname(stateDir), "home");
    const configDir = path.join(path.dirname(stateDir), "external-config");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousHome = process.env.HOME;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAppData = process.env.APPDATA;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.NODE_ENV = "production";
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.APPDATA = configDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "production-access-token",
              refresh: "production-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persistedStateTree = readPersistedTree(stateDir);
      expect(persistedStateTree).not.toContain("production-access-token");
      expect(persistedStateTree).not.toContain("production-refresh-token");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "production-access-token",
          refresh: "production-refresh-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      if (previousAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = previousAppData;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("keeps fallback oauth key material outside an overlapping state tree", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-overlap-"));
    const configDir = path.join(rootDir, "config");
    const stateDir = path.join(configDir, "openclaw");
    const homeDir = path.join(rootDir, "home");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousHome = process.env.HOME;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAppData = process.env.APPDATA;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.NODE_ENV = "production";
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.APPDATA = configDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "overlap-access-token",
              refresh: "overlap-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const keyPaths = findFilesNamed(rootDir, "auth-profile-secret-key");
      expect(keyPaths).toEqual([
        path.join(homeDir, ".openclaw-auth-profile-secrets", "auth-profile-secret-key"),
      ]);
      expect(keyPaths.every((keyPath) => !isPathInsideOrEqual(stateDir, keyPath))).toBe(true);
      const keyValues = keyPaths.map((keyPath) => fs.readFileSync(keyPath, "utf8").trim());
      const persistedStateTree = readPersistedTree(stateDir);
      expect(persistedStateTree).not.toContain("overlap-access-token");
      expect(persistedStateTree).not.toContain("overlap-refresh-token");
      for (const keyValue of keyValues) {
        expect(persistedStateTree).not.toContain(keyValue);
      }
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      if (previousAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = previousAppData;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("adopts an atomically-created fallback oauth key when another writer wins creation", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-key-race-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const homeDir = path.join(path.dirname(stateDir), "home");
    const configDir = path.join(path.dirname(stateDir), "external-config");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousHome = process.env.HOME;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAppData = process.env.APPDATA;
    const previousUserProfile = process.env.USERPROFILE;
    const originalOpenSync = fs.openSync.bind(fs);
    const originalWriteSync = fs.writeSync.bind(fs);
    const originalCloseSync = fs.closeSync.bind(fs);
    let injectedRace = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (
        !injectedRace &&
        flags === "wx" &&
        typeof file === "string" &&
        path.basename(file) === "auth-profile-secret-key"
      ) {
        injectedRace = true;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const fd = originalOpenSync(file, "w", mode);
        try {
          originalWriteSync(fd, "raced-fallback-key\n", undefined, "utf8");
        } finally {
          originalCloseSync(fd);
        }
        const err = new Error("file exists") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      return originalOpenSync(file, flags, mode);
    });
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.NODE_ENV = "production";
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.APPDATA = configDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "race-access-token",
              refresh: "race-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      expect(injectedRace).toBe(true);
      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "race-access-token",
          refresh: "race-refresh-token",
        },
      );
    } finally {
      openSpy.mockRestore();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      if (previousAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = previousAppData;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("preserves access-only openai-codex oauth credentials when persisting refs", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-access-only-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "access-only-token",
              expires,
            } as AuthProfileStore["profiles"][string],
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      const credential = persisted.profiles[profileId];
      expectOpenClawCredentialsOAuthRef(
        expectOAuthCredentialFields(credential, {
          provider: "openai-codex",
          expires,
        }),
        "openai-codex",
      );
      expect(credential).not.toHaveProperty("access");
      expect(credential).not.toHaveProperty("refresh");
      expect(JSON.stringify(persisted)).not.toContain("access-only-token");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "access-only-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("removes detached openai-codex oauth secrets when profiles are deleted", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-delete-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "delete-access-token",
              refresh: "delete-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, { oauthRef?: { id?: string } }>;
      };
      const refId = persisted.profiles[profileId]?.oauthRef?.id;
      expectOAuthProfileRefId(refId);
      const secretPath = resolvePersistedOAuthSecretPath(refId);
      const secretFile = fs.readFileSync(secretPath, "utf8");
      expect(secretFile).not.toContain("delete-access-token");
      expect(secretFile).not.toContain("delete-refresh-token");

      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {},
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      expect(fs.existsSync(secretPath)).toBe(false);
      expect(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")).not.toContain(profileId);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates openai-codex oauth refs for copied profile save targets", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-copy-ref-"));
    const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
    const copiedAgentDir = path.join(stateDir, "agents", "copied", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(copiedAgentDir, { recursive: true });
      const originalProfileId = "openai-codex:default";
      const copiedProfileId = "openai-codex:copied";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [originalProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "copy-access-token",
              refresh: "copy-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
              copyToAgents: true,
            },
          },
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      const originalRefId = readPersistedOAuthRefId(mainAgentDir, originalProfileId);
      const originalCredential =
        loadAuthProfileStoreWithoutExternalProfiles(mainAgentDir).profiles[originalProfileId];
      expect(originalCredential?.type).toBe("oauth");
      if (!originalCredential || originalCredential.type !== "oauth") {
        throw new Error("expected original oauth credential");
      }
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [copiedProfileId]: originalCredential,
          },
        },
        copiedAgentDir,
        { filterExternalAuthProfiles: false },
      );

      const copiedRefId = readPersistedOAuthRefId(copiedAgentDir, copiedProfileId);
      expect(copiedRefId).not.toBe(originalRefId);
      const originalSecretPath = resolvePersistedOAuthSecretPath(originalRefId);
      const copiedSecretPath = resolvePersistedOAuthSecretPath(copiedRefId);
      const copiedSecretFile = fs.readFileSync(copiedSecretPath, "utf8");
      expect(copiedSecretFile).not.toContain("copy-access-token");
      expect(copiedSecretFile).not.toContain("copy-refresh-token");

      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {},
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      expect(fs.existsSync(originalSecretPath)).toBe(false);
      expect(fs.existsSync(copiedSecretPath)).toBe(true);
      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(copiedAgentDir).profiles[copiedProfileId],
        {
          provider: "openai-codex",
          access: "copy-access-token",
          refresh: "copy-refresh-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite inline openai-codex oauth secrets from read-only lookup paths", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-readonly-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      fs.writeFileSync(
        resolveAuthStorePath(agentDir),
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "readonly-access-token",
                refresh: "readonly-refresh-token",
                expires,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const before = fs.readFileSync(resolveAuthStorePath(agentDir), "utf8");

      expectOAuthCredentialFields(findPersistedAuthProfileCredential({ agentDir, profileId }), {
        provider: "openai-codex",
        access: "readonly-access-token",
        refresh: "readonly-refresh-token",
      });
      expect(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")).toBe(before);

      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, { externalCli: { mode: "none" } }).profiles[
          profileId
        ],
        {
          provider: "openai-codex",
          access: "readonly-access-token",
          refresh: "readonly-refresh-token",
        },
      );
      expect(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")).toBe(before);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousReadOnly === undefined) {
        delete process.env.OPENCLAW_AUTH_STORE_READONLY;
      } else {
        process.env.OPENCLAW_AUTH_STORE_READONLY = previousReadOnly;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not repair legacy openai-codex oauth sidecars from read-only lookup paths", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-auth-profile-readonly-sidecar-"),
    );
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    const previousReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = "readonly-sidecar-secret-key";
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "sidecar-access-token",
              refresh: "sidecar-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );
      const secretPath = resolvePersistedOAuthSecretPath(
        readPersistedOAuthRefId(agentDir, profileId),
      );
      const legacySidecar = `${JSON.stringify(
        {
          version: 1,
          profileId,
          provider: "openai-codex",
          access: "legacy-sidecar-access",
          refresh: "legacy-sidecar-refresh",
        },
        null,
        2,
      )}\n`;
      fs.writeFileSync(secretPath, legacySidecar, "utf8");

      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, {
          readOnly: true,
          externalCli: { mode: "none" },
        }).profiles[profileId],
        {
          provider: "openai-codex",
          access: "legacy-sidecar-access",
          refresh: "legacy-sidecar-refresh",
        },
      );
      expect(fs.readFileSync(secretPath, "utf8")).toBe(legacySidecar);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      if (previousReadOnly === undefined) {
        delete process.env.OPENCLAW_AUTH_STORE_READONLY;
      } else {
        process.env.OPENCLAW_AUTH_STORE_READONLY = previousReadOnly;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rewrites existing inline openai-codex oauth secrets during runtime load", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-rewrite-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      fs.writeFileSync(
        resolveAuthStorePath(agentDir),
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "existing-access-token",
                refresh: "existing-refresh-token",
                idToken: "existing-id-token",
                expires,
                accountId: "acct-existing",
              },
            },
            order: {
              "openai-codex": [profileId],
            },
          },
          null,
          2,
        )}\n`,
      );

      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, { externalCli: { mode: "none" } }).profiles[
          profileId
        ],
        {
          provider: "openai-codex",
          access: "existing-access-token",
          refresh: "existing-refresh-token",
          idToken: "existing-id-token",
        },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
        order?: Record<string, string[]>;
      };
      const credential = persisted.profiles[profileId];
      expectOpenClawCredentialsOAuthRef(
        expectOAuthCredentialFields(credential, {
          provider: "openai-codex",
          expires,
          accountId: "acct-existing",
        }),
        "openai-codex",
      );
      expect(persisted.order?.["openai-codex"]).toEqual([profileId]);
      expect(credential).not.toHaveProperty("access");
      expect(credential).not.toHaveProperty("refresh");
      expect(credential).not.toHaveProperty("idToken");
      const persistedStateTree = readPersistedTree(stateDir);
      expect(persistedStateTree).not.toContain("existing-access-token");
      expect(persistedStateTree).not.toContain("existing-refresh-token");
      expect(persistedStateTree).not.toContain("existing-id-token");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "existing-access-token",
          refresh: "existing-refresh-token",
          idToken: "existing-id-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite inline openai-codex oauth secrets while the auth store lock is held", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-auth-profile-locked-rewrite-"),
    );
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    let lockFd: number | undefined;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const authPath = resolveAuthStorePath(agentDir);
      const expires = Date.now() + 60 * 60 * 1000;
      fs.writeFileSync(
        authPath,
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "locked-access-token",
                refresh: "locked-refresh-token",
                expires,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const before = fs.readFileSync(authPath, "utf8");
      const lockPath = resolveAuthStoreLockPath(authPath);
      lockFd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(
        lockFd,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );

      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, { externalCli: { mode: "none" } }).profiles[
          profileId
        ],
        {
          provider: "openai-codex",
          access: "locked-access-token",
          refresh: "locked-refresh-token",
        },
      );

      expect(fs.readFileSync(authPath, "utf8")).toBe(before);
    } finally {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        fs.rmSync(resolveAuthStoreLockPath(resolveAuthStorePath(agentDir)), { force: true });
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-order-promote-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai-codex:bunsthedev@gmail.com";
      const staleProfileId = "openai-codex:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
          order: {
            "openai-codex": [staleProfileId],
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai-codex",
        profileId: newProfileId,
      });

      expect(updated?.order?.["openai-codex"]).toEqual([newProfileId, staleProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai-codex"]).toEqual([
        newProfileId,
        staleProfileId,
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
