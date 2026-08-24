import { afterEach, describe, expect, it } from "vitest";
import { assertSecretOwnerAvailable } from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
} from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const webhookOrigins = new Map([["webhooks", "bundled" as const]]);

afterEach(() => clearSecretsRuntimeSnapshotState());

describe("webhook SecretRef owner isolation", () => {
  it("keeps unchanged routes stale across sibling edits but makes changed owners cold", async () => {
    const ref = (id: string) => ({ source: "env" as const, provider: "default", id });
    const firstSecret = ref("FIRST_WEBHOOK_SECRET");
    const secondSecret = ref("SECOND_WEBHOOK_SECRET");
    const route = (id: string, secret: ReturnType<typeof ref>, changes: Record<string, unknown>) =>
      ({
        enabled: true,
        path: `/proof/${id}`,
        sessionKey: `agent:main:${id}`,
        secret,
        controllerId: `proof/${id}`,
        description: `${id} route`,
        ...changes,
      }) as const;
    const prepare = (first: Record<string, unknown>, second: Record<string, unknown>, env = {}) =>
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              webhooks: {
                enabled: true,
                config: {
                  routes: {
                    first: route("first", firstSecret, first),
                    second: route("second", secondSecret, second),
                  },
                },
              },
            },
          },
        }),
        env,
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: webhookOrigins,
      });
    const activate = (snapshot: Awaited<ReturnType<typeof prepare>>) =>
      activateSecretsRuntimeSnapshotState({ snapshot, refreshContext: null, refreshHandler: null });
    const ownerId = "webhooks:routes.first.secret";

    activate(
      await prepare(
        {},
        {},
        {
          FIRST_WEBHOOK_SECRET: "first-known-good",
          SECOND_WEBHOOK_SECRET: "second-original",
        },
      ),
    );

    const firstDescription = { description: "updated operator note" };
    const updatedSecond = {
      path: "/proof/second-updated",
      secret: ref("ROTATED_SECOND_WEBHOOK_SECRET"),
      description: "updated sibling",
    };
    const env = { ROTATED_SECOND_WEBHOOK_SECRET: "second-rotated" };
    const stale = await prepare(firstDescription, updatedSecond, env);

    expect(stale.degradedOwners).toMatchObject([
      { ownerKind: "plugin-route", ownerId, degradationState: "stale" },
    ]);
    expect(stale.config.plugins?.entries?.webhooks?.config).toMatchObject({
      routes: { first: { secret: "first-known-good" }, second: { secret: "second-rotated" } },
    });
    activate(stale);
    expect(() => assertSecretOwnerAvailable("plugin-route", ownerId)).not.toThrow();

    for (const changedOwner of [
      { enabled: false },
      { path: "/proof/first-updated" },
      { sessionKey: "agent:main:elsewhere" },
      { controllerId: "proof/first-updated" },
      { secret: ref("REPLACED_FIRST_WEBHOOK_SECRET") },
    ]) {
      const cold = await prepare({ ...firstDescription, ...changedOwner }, updatedSecond, env);

      expect(cold.degradedOwners).toMatchObject([
        { ownerKind: "plugin-route", ownerId, degradationState: "cold" },
      ]);
      expect(cold.config.plugins?.entries?.webhooks?.config).toMatchObject({
        routes: {
          first: { secret: "secret" in changedOwner ? changedOwner.secret : firstSecret },
          second: { secret: "second-rotated" },
        },
      });
    }
  });
});
