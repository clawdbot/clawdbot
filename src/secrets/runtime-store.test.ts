import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const roots: string[] = [];
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("store SecretRef runtime degradation", () => {
  it("isolates a missing store-backed skill instead of failing gateway startup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-store-"));
    roots.push(root);
    const ref = { source: "store", provider: "default", id: "MISSING_SKILL_API_KEY" } as const;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: { list: [{ id: "main", default: true }] },
        skills: { entries: { unavailable: { apiKey: ref } } },
      }),
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.skills?.entries?.unavailable?.apiKey).toEqual(ref);
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "skill:unavailable",
        state: "unavailable",
        reason: "secret reference was not found",
      },
    ]);
  });
});
