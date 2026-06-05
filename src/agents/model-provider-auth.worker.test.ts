// Verifies provider-auth warm worker input preserves runtime-only profile stores.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles.js";
import { clearCurrentProviderAuthState } from "./model-provider-auth.js";
import { runProviderAuthWarmWorkerInput } from "./model-provider-auth.worker.js";

const tempDirs: string[] = [];

describe("provider auth warm worker", () => {
  afterEach(() => {
    clearCurrentProviderAuthState();
    clearRuntimeAuthProfileStoreSnapshots();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves runtime-only auth profile snapshots in the worker warm input", async () => {
    // Runtime-only profiles are not persisted to disk, so the worker input must
    // carry them explicitly or warming loses provider availability.
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-provider-auth-worker-"));
    tempDirs.push(root);

    await withEnvAsync(
      {
        OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
      },
      async () => {
        const agentDir = path.join(root, "agent");
        const cfg = {
          agents: { list: [{ id: "main", agentDir }] },
          models: {
            providers: {
              "runtime-only": {
                baseUrl: "https://example.com/v1",
                api: "openai",
                models: [{ id: "runtime-model", name: "Runtime Model" }],
              },
            },
          },
        } as unknown as OpenClawConfig;
        const result = await runProviderAuthWarmWorkerInput({
          cfg,
          runtimeAuthStores: [
            {
              agentDir,
              store: {
                version: 1,
                profiles: {
                  "runtime-only:default": {
                    type: "api_key",
                    provider: "runtime-only",
                  },
                },
              },
            },
          ],
        });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") {
          return;
        }
        expect(result.snapshot.agents[0]?.providers).toContainEqual(["runtime-only", true]);
      },
    );
  }, 30_000);
});
