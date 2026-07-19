/** Tests provider-scoped SecretRef failure fan-out across runtime owners. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearSecretsRuntimeSnapshot } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const EXEC_FIXTURE_TIMEOUT_MS = 20_000;

function execFixtureProvider(command: string) {
  return {
    source: "exec" as const,
    command,
    passEnv: ["PATH"],
    timeoutMs: EXEC_FIXTURE_TIMEOUT_MS,
    noOutputTimeoutMs: EXEC_FIXTURE_TIMEOUT_MS,
  };
}

afterEach(() => {
  clearSecretsRuntimeSnapshot();
});

describe("provider-scoped SecretRef failure fan-out", () => {
  it("preserves provider provenance for an unavailable web-search owner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-web-secret-provider-failure-");
    const commandPath = path.join(root, "provider.sh");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 1\n", {
      encoding: "utf8",
      mode: 0o700,
    });
    const ref = { source: "exec" as const, provider: "vault", id: "web/gemini" };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            vault: execFixtureProvider(commandPath),
          },
        },
        tools: { web: { search: { provider: "gemini" } } },
        plugins: {
          entries: {
            google: { config: { webSearch: { apiKey: ref } } },
          },
        },
      }),
      env: { PATH: process.env.PATH ?? "" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.degradedOwners).toContainEqual(
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "web-search:gemini",
        reason: "secret provider failed",
        providerFailures: [{ source: "exec", provider: "vault" }],
      }),
    );
  });

  it("reuses one provider failure across isolated owners", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-owner-secret-provider-failure-");
    const callLogPath = path.join(root, "calls.log");
    const commandPath = path.join(root, "provider.sh");
    await fs.writeFile(
      commandPath,
      `#!/bin/sh\nprintf 'call\\n' >> ${JSON.stringify(callLogPath)}\nexit 1\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    const input = {
      modelRef: { source: "exec" as const, provider: "shared", id: "models/openai" },
      ttsRef: { source: "exec" as const, provider: "shared", id: "tts/elevenlabs" },
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            shared: execFixtureProvider(commandPath),
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: input.modelRef,
              models: [],
            },
          },
        },
        messages: {
          tts: { providers: { elevenlabs: { apiKey: input.ttsRef } } },
        },
      }),
      env: { PATH: process.env.PATH ?? "" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.models?.providers?.openai?.apiKey).toEqual(input.modelRef);
    expect(snapshot.config.messages?.tts?.providers?.elevenlabs?.apiKey).toEqual(input.ttsRef);
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "openai",
        reason: "secret provider failed",
        providerFailures: [{ source: "exec", provider: "shared" }],
      },
      {
        ownerKind: "capability",
        ownerId: "tts",
        reason: "secret provider failed",
        providerFailures: [{ source: "exec", provider: "shared" }],
      },
    ]);
    expect((await fs.readFile(callLogPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("records every failed provider used by one isolated owner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-owner-multi-provider-failure-");
    const command = async (name: string) => {
      const commandPath = path.join(root, `${name}.sh`);
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 1\n", {
        encoding: "utf8",
        mode: 0o700,
      });
      return commandPath;
    };
    const firstCommand = await command("first");
    const secondCommand = await command("second");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            first: execFixtureProvider(firstCommand),
            second: execFixtureProvider(secondCommand),
          },
        },
        models: {
          providers: {
            example: {
              apiKey: { source: "exec", provider: "first", id: "api-key" },
              headers: {
                "X-Secondary": { source: "exec", provider: "second", id: "secondary" },
              },
              models: [],
            },
          },
        },
      }),
      env: { PATH: process.env.PATH ?? "" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "example",
        providerFailures: [
          { source: "exec", provider: "first" },
          { source: "exec", provider: "second" },
        ],
      },
    ]);
  });

  it("retains a ref failure when the same owner also has a provider outage", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-owner-mixed-provider-failure-");
    const providerCommand = path.join(root, "provider.sh");
    const refCommand = path.join(root, "ref.sh");
    await fs.writeFile(providerCommand, "#!/bin/sh\nexit 1\n", {
      encoding: "utf8",
      mode: 0o700,
    });
    const refResponse = JSON.stringify({
      protocolVersion: 1,
      values: {},
      errors: { secondary: { code: "NOT_FOUND" } },
    });
    await fs.writeFile(refCommand, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(refResponse)}\n`, {
      encoding: "utf8",
      mode: 0o700,
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        secrets: {
          providers: {
            unavailable: execFixtureProvider(providerCommand),
            partial: execFixtureProvider(refCommand),
          },
        },
        models: {
          providers: {
            example: {
              apiKey: { source: "exec", provider: "unavailable", id: "api-key" },
              headers: {
                "X-Secondary": { source: "exec", provider: "partial", id: "secondary" },
              },
              models: [],
            },
          },
        },
      }),
      env: { PATH: process.env.PATH ?? "" },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "example",
        reason: "secret reference was not found",
        providerFailures: [{ source: "exec", provider: "unavailable" }],
        refFailureReason: "secret reference was not found",
      },
    ]);
  });
});
