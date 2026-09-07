import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { acquireAgentRuntimePlan, buildAgentRuntimePlan } from "./agent-harness-runtime.js";

function createPlanFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('provider prompt')");
  const registry = createEmptyPluginRegistry();
  const owner = createPluginRegistryResourceOwner(registry, "scoped");
  registerPluginRegistryResourceDisposer(registry, "fixture", {
    id: "database",
    dispose: () => db.close(),
  });
  registry.providers.push({
    pluginId: "fixture",
    source: "synthetic-fixture",
    provider: {
      id: "fixture",
      label: "Fixture",
      auth: [],
      resolveSystemPromptContribution: () => ({
        stablePrefix: String(db.prepare("SELECT value FROM proof").get()?.value),
      }),
    },
  });
  const params = {
    provider: "fixture",
    modelId: "fixture-model",
    preparedAuthPlan: { providerForAuth: "fixture", authProfileProviderForAuth: "fixture" },
  };
  return { db, registry, owner, params };
}

it("keeps a public plan's provider callbacks through accepted work after release", async () => {
  const fixture = createPlanFixture();
  const acquired = withPluginRuntimeRegistryScope(fixture.registry, () =>
    acquireAgentRuntimePlan(fixture.params),
  );
  const finish = createDeferredCore();
  const pending = acquired.run(async () => {
    await finish.promise;
    return acquired.plan.prompt.resolveSystemPromptContribution({
      ...fixture.params,
      promptMode: "minimal",
    });
  });
  const outcome = Promise.allSettled([pending]);
  try {
    fixture.owner.release();
    acquired.release();
    expect(() => acquired.run(() => undefined)).toThrow();
    expect(fixture.db.isOpen).toBe(true);
    finish.resolve();
    await expect(pending).resolves.toMatchObject({ stablePrefix: "provider prompt" });
    await drainPluginRegistryResourceDisposals();
    expect(fixture.db.isOpen).toBe(false);
  } finally {
    finish.resolve();
    acquired.release();
    fixture.owner.release();
    await outcome;
    await drainPluginRegistryResourceDisposals();
  }
});

it("retains a shipped bare plan until its legacy SDK host closes", async () => {
  const fixture = createPlanFixture();
  try {
    const plan = withPluginRuntimeRegistryScope(fixture.registry, () =>
      buildAgentRuntimePlan(fixture.params),
    );
    fixture.owner.release();
    await drainPluginRegistryResourceDisposals();
    for (let index = 0; index < 2; index += 1) {
      expect(
        plan.prompt.resolveSystemPromptContribution({ ...fixture.params, promptMode: "minimal" }),
      ).toMatchObject({ stablePrefix: "provider prompt" });
    }
    expect(fixture.db.isOpen).toBe(true);
  } finally {
    fixture.owner.release();
    await drainGlobalSingletonLifecycleState("restart");
  }
  expect(fixture.db.isOpen).toBe(false);
});
