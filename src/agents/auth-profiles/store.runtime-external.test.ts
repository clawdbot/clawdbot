import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import { testing as externalAuthTesting } from "./external-auth.js";
import { resolveAuthStatePath, resolveAuthStorePath } from "./paths.js";
import { getRuntimeAuthProfileStoreSnapshot } from "./runtime-snapshots.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const envBackup: Record<string, string | undefined> = {};
const envKeys = ["OPENCLAW_STATE_DIR"];
const tempDirs: string[] = [];

function createRuntimeExternalCredential(): OAuthCredential {
  return {
    type: "oauth",
    provider: "claude-cli",
    access: "external-access-token",
    refresh: "external-refresh-token",
    expires: Date.now() + 60_000,
  };
}

beforeEach(() => {
  for (const key of envKeys) {
    envBackup[key] = process.env[key];
  }
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(async () => {
  for (const key of envKeys) {
    if (envBackup[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envBackup[key];
    }
  }
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("auth profile store runtime external snapshots", () => {
  it("keeps runtime-only external oauth profiles in active snapshots after save", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-external-save-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });

    const externalProfileId = "anthropic:claude-cli";
    const externalCredential = createRuntimeExternalCredential();
    const externalProfiles: ProviderExternalAuthProfile[] = [
      {
        profileId: externalProfileId,
        credential: externalCredential,
        persistence: "runtime-only",
      },
    ];
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => externalProfiles);

    const runtimeStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:static": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-static", // pragma: allowlist secret
        },
        [externalProfileId]: externalCredential,
      },
      order: {
        openai: ["openai:static"],
        "claude-cli": [externalProfileId],
      },
      runtimeExternalProfileIds: [externalProfileId],
    };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: runtimeStore }]);

    saveAuthProfileStore(runtimeStore, agentDir);

    const persisted = JSON.parse(
      await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
    ) as AuthProfileStore;
    const persistedState = JSON.parse(
      await fs.readFile(resolveAuthStatePath(agentDir), "utf8"),
    ) as AuthProfileStore;
    expect(persisted.profiles[externalProfileId]).toBeUndefined();
    expect(persisted.order?.["claude-cli"]).toBeUndefined();
    expect(persistedState.order?.["claude-cli"]).toBeUndefined();

    const snapshot = getRuntimeAuthProfileStoreSnapshot(agentDir);
    expect(snapshot?.profiles[externalProfileId]).toEqual(externalCredential);
    expect(snapshot?.runtimeExternalProfileIds).toEqual([externalProfileId]);
    expect(snapshot?.order?.["claude-cli"]).toEqual([externalProfileId]);
  });
});
