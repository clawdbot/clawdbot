import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { decodePairingSetupCode } from "../../pairing/setup-code.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

vi.mock("../../infra/device-bootstrap.js", () => ({
  ensureDevicePairSetupBootstrapToken: vi.fn(async ({ setupId }: { setupId: string }) => ({
    status: "pending",
    token: "bootstrap-token",
    expiresAtMs: 10_000,
    setupId,
  })),
}));

const PUBLIC_ORIGIN = "https://gateway.example.test";
const PLUGIN_PUBLIC_URL = "wss://pairing.example.test";

function createConfig(pluginPublicUrl?: string): OpenClawConfig {
  return {
    gateway: {
      bind: "loopback",
      publicOrigin: PUBLIC_ORIGIN,
      auth: { mode: "token", token: "gateway-token" },
    },
    ...(pluginPublicUrl
      ? {
          plugins: {
            entries: { "device-pair": { config: { publicUrl: pluginPublicUrl } } },
          },
        }
      : {}),
  };
}

describe("worker node enrollment", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-node-enrollment-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    {
      name: "uses gateway.publicOrigin when the plugin has no pairing override",
      config: createConfig(),
      expectedUrl: "wss://gateway.example.test",
    },
    {
      name: "prefers the device-pair plugin publicUrl over gateway.publicOrigin",
      config: createConfig(PLUGIN_PUBLIC_URL),
      expectedUrl: PLUGIN_PUBLIC_URL,
    },
  ])("$name", async ({ config, expectedUrl }) => {
    const record = store.createIntent({
      environmentId: "worker-enrollment",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: "provision:worker-enrollment",
    });
    const manager = createWorkerNodeEnrollmentManager({
      store,
      getConfig: () => config,
      resolveAvailability: async () => ({ available: false }),
    });

    const enrollment = await manager.begin(record);

    expect(enrollment.mode).toBe("connect");
    if (enrollment.mode !== "connect") {
      throw new Error("expected a connect enrollment");
    }
    expect(decodePairingSetupCode(enrollment.setupCode, { nowMs: 0 }).url).toBe(expectedUrl);
  });
});
