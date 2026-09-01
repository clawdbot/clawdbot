/** Tests runtime isolation for manifest-owned plugin secrets. */
import fs from "node:fs/promises";
import path from "node:path";
import { assertPluginCapabilitySecretAvailable } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
} from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const BUNDLED_TAVILY_PLUGIN_ORIGINS = new Map([["tavily", "bundled" as const]]);
const TAVILY_TOOL_KEY_PATH = "plugins.entries.tavily.config.webSearch.apiKey";
const TAVILY_TOOL_KEY_REF = {
  source: "exec",
  provider: "tavily-vault",
  id: "tavily/api-key",
} as const;
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearSecretsRuntimeSnapshotState();
});

function tavilyToolSecretConfig(commandPath: string) {
  return asConfig({
    agents: { list: [{ id: "main", default: true }] },
    tools: { web: { search: { enabled: false } } },
    plugins: {
      entries: {
        tavily: {
          enabled: true,
          config: { webSearch: { apiKey: TAVILY_TOOL_KEY_REF } },
        },
      },
    },
    secrets: {
      providers: {
        "tavily-vault": {
          source: "exec",
          command: commandPath,
          passEnv: ["PATH"],
          timeoutMs: 20_000,
          noOutputTimeoutMs: 20_000,
        },
      },
    },
  });
}

async function writeTavilyExecProvider(commandPath: string, available: boolean): Promise<void> {
  const script = available
    ? [
        "#!/bin/sh",
        "cat >/dev/null",
        `printf '%s' '${JSON.stringify({
          protocolVersion: 1,
          values: { [TAVILY_TOOL_KEY_REF.id]: "resolved-tavily-key" },
        })}'`,
      ].join("\n")
    : "#!/bin/sh\nexit 1\n";
  await fs.writeFile(commandPath, script, { encoding: "utf8", mode: 0o700 });
}

function expectTavilyCold(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
): void {
  expect(snapshot.config.plugins?.entries?.tavily?.config).toMatchObject({
    webSearch: { apiKey: TAVILY_TOOL_KEY_REF },
  });
  expect(snapshot.degradedOwners).toMatchObject([
    {
      ownerKind: "capability",
      ownerId: TAVILY_TOOL_KEY_PATH,
      degradationState: "cold",
    },
  ]);
}

function expectTavilyUnavailable(): void {
  expect(() => assertPluginCapabilitySecretAvailable(TAVILY_TOOL_KEY_PATH)).toThrow(
    expect.objectContaining({
      name: "SecretSurfaceUnavailableError",
      ownerKind: "capability",
      ownerId: TAVILY_TOOL_KEY_PATH,
    }),
  );
}

describe("plugin secret owners", () => {
  it("isolates Tavily tools when their exec provider fails at cold start", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-tavily-secret-cold-");
    const commandPath = path.join(root, "provider.sh");
    await writeTavilyExecProvider(commandPath, false);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: tavilyToolSecretConfig(commandPath),
      env: { PATH: process.env.PATH ?? "", TAVILY_API_KEY: "ambient-must-not-be-used" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: BUNDLED_TAVILY_PLUGIN_ORIGINS,
    });

    expectTavilyCold(snapshot);
    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });
    expectTavilyUnavailable();
  });

  it("does not retain a stale Tavily key when its exec provider fails on reload", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-tavily-secret-reload-");
    const commandPath = path.join(root, "provider.sh");
    const config = tavilyToolSecretConfig(commandPath);
    const env = { PATH: process.env.PATH ?? "", TAVILY_API_KEY: "ambient-must-not-be-used" };
    await writeTavilyExecProvider(commandPath, true);
    const active = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: BUNDLED_TAVILY_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });
    expect(active.config.plugins?.entries?.tavily?.config).toMatchObject({
      webSearch: { apiKey: "resolved-tavily-key" },
    });

    await writeTavilyExecProvider(commandPath, false);
    const candidate = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: BUNDLED_TAVILY_PLUGIN_ORIGINS,
    });

    expectTavilyCold(candidate);
    activateSecretsRuntimeSnapshotState({
      snapshot: candidate,
      refreshContext: null,
      refreshHandler: null,
    });
    expectTavilyUnavailable();
  });
});
