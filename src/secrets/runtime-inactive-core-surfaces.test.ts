/** Tests inactive core SecretRefs remain unresolved and diagnostic-only. */
import { describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function expectWarningPaths(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
  expectedPaths: string[],
): void {
  const warningPaths = new Set(snapshot.warnings.map((warning) => warning.path));
  for (const expectedPath of expectedPaths) {
    expect(warningPaths.has(expectedPath)).toBe(true);
  }
}

describe("secrets runtime snapshot inactive core surfaces", () => {
  it("skips inactive core refs and emits diagnostics", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        memory: {
          search: {
            enabled: false,
            remote: {
              apiKey: { source: "env", provider: "default", id: "DISABLED_MEMORY_API_KEY" },
            },
          },
        },
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
              docker: {
                env: {
                  DATABASE_URL: { source: "env", provider: "default", id: "DATABASE_URL" },
                },
              },
            },
          },
          entries: {
            worker: {
              sandbox: {
                mode: "all",
                backend: "ssh",
                docker: {
                  env: {
                    API_TOKEN: {
                      source: "env",
                      provider: "default",
                      id: "WORKER_API_TOKEN",
                    },
                  },
                },
              },
            },
          },
        },
        gateway: {
          auth: {
            mode: "token",
            password: { source: "env", provider: "default", id: "DISABLED_GATEWAY_PASSWORD" },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expectWarningPaths(snapshot, [
      "memory.search.remote.apiKey",
      "agents.defaults.sandbox.docker.env.DATABASE_URL",
      "agents.entries.worker.sandbox.docker.env.API_TOKEN",
      "gateway.auth.password",
    ]);
  });
});
