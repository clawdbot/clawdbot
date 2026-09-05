import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const storeMocks = vi.hoisted(() => ({
  readValue: vi.fn(),
}));

vi.mock("./store/secret-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store/secret-store.js")>();
  return { ...actual, readSecretStoreValue: storeMocks.readValue };
});

const roots: string[] = [];
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

beforeEach(() => {
  storeMocks.readValue.mockReset().mockReturnValue({
    ok: false,
    error: {
      code: "SECRET_STORE_NOT_FOUND",
      message: "Secret store entry was not found.",
    },
  });
});

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

  it("makes an intentionally mutated missing store ref cold instead of retaining its value", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-store-"));
    roots.push(root);
    const ref = { source: "store", provider: "default", id: "SERVICE_API_KEY" } as const;
    const config = asConfig({
      agents: { list: [{ id: "main", default: true }] },
      skills: { entries: { service: { apiKey: ref } } },
    });
    const runtimeOptions = {
      config,
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map(),
    } as const;

    storeMocks.readValue.mockReturnValue({ ok: true, value: "previous-secret" });
    const active = await prepareSecretsRuntimeSnapshot(runtimeOptions);
    const { activateSecretsRuntimeSnapshot } = await import("./runtime.js");
    activateSecretsRuntimeSnapshot(active);
    expect(active.config.skills?.entries?.service?.apiKey).toBe("previous-secret");

    storeMocks.readValue.mockReturnValue({
      ok: false,
      error: {
        code: "SECRET_STORE_NOT_FOUND",
        message: "Secret store entry was not found.",
      },
    });
    const refreshed = await prepareSecretsRuntimeSnapshot({
      ...runtimeOptions,
      forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]),
    });

    expect(refreshed.config.skills?.entries?.service?.apiKey).toEqual(ref);
    expect(refreshed.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "skill:service",
        degradationState: "cold",
      },
    ]);
    expect(JSON.stringify(refreshed)).not.toContain("previous-secret");
  });
});
