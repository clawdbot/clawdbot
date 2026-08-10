/** Gateway startup regression coverage for copied auth stores with omitted SecretRef providers. */
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import {
  deletePersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { getFreePort, installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("Gateway startup copied auth SecretRef isolation", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let agentDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (agentDir) {
      deletePersistedAuthProfileStoreRaw(agentDir);
      agentDir = undefined;
    }
    clearSecretsRuntimeSnapshot();
  });

  it("starts degraded when copied auth state references an omitted SecretRef provider", async () => {
    const profileId = "openai:copied";
    const config: OpenClawConfig = {
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      auth: { order: { openai: [profileId] } },
    };
    agentDir = resolveDefaultAgentDir(config);
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "file", provider: "clawrouter_key", id: "value" },
          },
        },
      },
      agentDir,
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toMatchObject({
      profiles: { [profileId]: { provider: "openai" } },
    });
    await writeConfigFile(config);

    const port = await getFreePort();
    server = await startTestGatewayServer(port, { auth: { mode: "none" } });
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

    expect(ready.status).toBe(200);
    const ownerId = resolveAuthProfileSecretOwnerId({ agentDir, profileId });
    expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
      {
        ownerKind: "account",
        ownerId,
        state: "unavailable",
        reason: "secret provider is not configured",
      },
    ]);
    expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_OWNER_UNAVAILABLE",
          path: `${agentDir}.auth-profiles.${profileId}.key`,
        }),
      ]),
    );
  });
});
