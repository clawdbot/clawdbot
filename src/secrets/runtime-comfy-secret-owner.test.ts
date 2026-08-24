import { describe, expect, it } from "vitest";
import { assertSecretOwnerAvailable } from "./runtime-degraded-state.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const origins = new Map([["comfy", "bundled" as const]]);

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function comfyConfig(options: {
  baseUrl?: string;
  refId?: string;
  promptNodeId?: string;
  mode?: "cloud" | "local";
}) {
  return asConfig({
    agents: { list: [{ id: "main", default: true }] },
    models: {
      providers: {
        healthy: {
          apiKey: envRef("COMFY_HEALTHY_SIBLING_KEY"),
          baseUrl: "https://healthy.example.invalid/v1",
          models: [],
        },
      },
    },
    plugins: {
      entries: {
        comfy: {
          enabled: true,
          config: {
            mode: options.mode ?? "cloud",
            baseUrl: options.baseUrl ?? "https://first.example.invalid",
            apiKey: envRef(options.refId ?? "COMFY_OWNER_KEY"),
            image: {
              workflow: { "6": { inputs: { text: "" } } },
              promptNodeId: options.promptNodeId ?? "6",
            },
          },
        },
      },
    },
  });
}

async function prepareComfySnapshot(
  options: Parameters<typeof comfyConfig>[0],
  env: NodeJS.ProcessEnv,
) {
  return prepareSecretsRuntimeSnapshot({
    config: comfyConfig(options),
    env,
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: origins,
  });
}

function activate(snapshot: Awaited<ReturnType<typeof prepareComfySnapshot>>) {
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext: null,
    refreshHandler: null,
  });
}

describe("Comfy plugin-provider secret ownership", () => {
  it("isolates its cold owner while an unrelated provider remains healthy", async () => {
    const snapshot = await prepareComfySnapshot(
      {},
      { COMFY_HEALTHY_SIBLING_KEY: "healthy-sibling-key" },
    );

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "plugin-provider",
        ownerId: "comfy:comfy",
        degradationState: "cold",
        paths: ["plugins.entries.comfy.config.apiKey"],
      },
    ]);
    expect(snapshot.config.models?.providers?.healthy?.apiKey).toBe("healthy-sibling-key");
    activate(snapshot);
    expect(() => assertSecretOwnerAvailable("plugin-provider", "comfy:comfy")).toThrow(
      "plugin-provider:comfy:comfy",
    );
    expect(() => assertSecretOwnerAvailable("provider", "healthy")).not.toThrow();
  });

  it("retains unchanged last-known-good credentials without blocking cloud execution", async () => {
    activate(
      await prepareComfySnapshot(
        {},
        { COMFY_OWNER_KEY: "last-known-good", COMFY_HEALTHY_SIBLING_KEY: "old-sibling" },
      ),
    );

    const stale = await prepareComfySnapshot(
      {},
      { COMFY_HEALTHY_SIBLING_KEY: "refreshed-sibling" },
    );

    expect(stale.degradedOwners).toMatchObject([
      { ownerKind: "plugin-provider", ownerId: "comfy:comfy", degradationState: "stale" },
    ]);
    expect(stale.config.plugins?.entries?.comfy?.config?.apiKey).toBe("last-known-good");
    expect(stale.config.models?.providers?.healthy?.apiKey).toBe("refreshed-sibling");
    activate(stale);
    expect(() => assertSecretOwnerAvailable("plugin-provider", "comfy:comfy")).not.toThrow();
  });

  it.each([
    { change: "destination", options: { baseUrl: "https://changed.example.invalid" } },
    { change: "workflow settings", options: { promptNodeId: "7" } },
    { change: "SecretRef identity", options: { refId: "COMFY_CHANGED_OWNER_KEY" } },
  ])("refuses stale credentials after the $change changes", async ({ options }) => {
    activate(
      await prepareComfySnapshot(
        {},
        { COMFY_OWNER_KEY: "old-credential", COMFY_HEALTHY_SIBLING_KEY: "old-sibling" },
      ),
    );

    const cold = await prepareComfySnapshot(options, {
      COMFY_HEALTHY_SIBLING_KEY: "refreshed-sibling",
    });

    expect(cold.degradedOwners).toMatchObject([
      { ownerKind: "plugin-provider", ownerId: "comfy:comfy", degradationState: "cold" },
    ]);
    expect(cold.config.plugins?.entries?.comfy?.config?.apiKey).toMatchObject({ source: "env" });
    expect(cold.config.models?.providers?.healthy?.apiKey).toBe("refreshed-sibling");
    activate(cold);
    expect(() => assertSecretOwnerAvailable("plugin-provider", "comfy:comfy")).toThrow(
      "plugin-provider:comfy:comfy",
    );
  });
});
