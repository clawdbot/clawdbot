import { afterEach, describe, expect, it } from "vitest";
import { loadPluginRegistryHandle } from "./loader.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  isPluginRecordActive,
  isPluginRegistryLifecycleEpochActive,
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  commitStagedPluginRegistry,
  resetPluginRuntimeStateForTest,
  rollbackStagedPluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "./runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function captureActivation(registry: PluginRegistry) {
  const epoch = capturePluginRegistryLifecycleEpoch(registry)!;
  expect(epoch).toBeDefined();
  const signal = capturePluginRegistryLifecycleSignal(registry, epoch)!;
  expect(signal).toBeDefined();
  return { epoch, signal };
}

afterEach(() => resetPluginRuntimeStateForTest());

describe("plugin registry retirement notifications", () => {
  it.each(["retire", "activate"] as const)(
    "notifies a scoped loader handle on %s without inventing an activation epoch",
    (action) => {
      const registry = loadPluginRegistryHandle({ onlyPluginIds: [] });
      const record = createPluginRecord({ id: "scoped-owner" });
      registry.plugins.push(record);
      expect(capturePluginRegistryLifecycleSignal(registry, undefined)).toBeUndefined();
      const { signal, authority } = withPluginRuntimeRegistryScope(registry, () => {
        const scopedRuntime = getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry;
        const epoch = capturePluginRegistryLifecycleEpoch(registry);
        const options = { scopedRuntime };
        return {
          signal: capturePluginRegistryLifecycleSignal(registry, epoch, options)!,
          authority: capturePluginLifecycleAuthority(registry, undefined, options)!,
        };
      });
      expect(signal?.aborted).toBe(false);
      expect(authority()).toBe(true);
      expect(capturePluginRegistryLifecycleEpoch(registry)).toBeUndefined();
      expect(isPluginRecordActive(registry, record)).toBe(false);
      expect(capturePluginRegistryLifecycleSignal(registry, undefined)).toBeUndefined();
      expect(
        capturePluginRegistryLifecycleSignal(registry, undefined, { scopedRuntime: true }),
      ).toBe(signal);
      const observations: boolean[] = [];
      signal.addEventListener("abort", () => observations.push(authority()));

      if (action === "retire") {
        markPluginRegistryRetired(registry);
      } else {
        markPluginRegistryActive(registry);
      }

      expect(observations).toEqual([false]);
      expect(signal.aborted).toBe(true);
      expect(
        capturePluginRegistryLifecycleSignal(registry, undefined, { scopedRuntime: true }),
      ).toBeUndefined();
      markPluginRegistryActive(registry);
      expect(captureActivation(registry).signal.aborted).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(authority()).toBe(false);
      expect(observations).toHaveLength(1);
    },
  );

  it("keeps epoch identity opaque and rejects missing or mismatched activation signals", () => {
    const registry = createEmptyPluginRegistry();
    const other = createEmptyPluginRegistry();
    expect(capturePluginRegistryLifecycleSignal(registry, {})).toBeUndefined();
    expect(capturePluginLifecycleAuthority(registry)).toBeUndefined();
    const scopedAuthority = capturePluginLifecycleAuthority(registry, undefined, {
      scopedRuntime: true,
    });
    expect(scopedAuthority?.()).toBe(true);

    markPluginRegistryActive(registry);
    const { epoch, signal } = captureActivation(registry);
    expect(Object.isFrozen(epoch)).toBe(true);
    for (const property of ["abort", "controller", "signal"]) {
      expect(epoch).not.toHaveProperty(property);
    }
    expect(capturePluginRegistryLifecycleEpoch(registry)).toBe(epoch);
    expect(capturePluginRegistryLifecycleSignal(registry, epoch)).toBe(signal);
    expect(capturePluginRegistryLifecycleSignal(other, epoch)).toBeUndefined();
    expect(capturePluginRegistryLifecycleSignal(registry, { ...epoch })).toBeUndefined();
    expect(scopedAuthority?.()).toBe(false);
  });

  it.each(["retire", "reactivate"] as const)(
    "publishes registry and instance authority before %s listeners run",
    (action) => {
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "lifecycle-owner" });
      registry.plugins.push(record);
      markPluginRegistryActive(registry);
      const { epoch, signal } = captureActivation(registry);
      const registryAuthority = capturePluginLifecycleAuthority(registry)!;
      const authority = capturePluginLifecycleAuthority(registry, record)!;
      expect(isPluginRecordActive(registry, record)).toBe(true);
      expect(authority()).toBe(true);
      const observations: unknown[] = [];
      signal.addEventListener("abort", () => {
        const nextEpoch = capturePluginRegistryLifecycleEpoch(registry);
        observations.push({
          registryActive: isPluginRegistryLifecycleEpochActive(registry, epoch),
          recordActive: isPluginRecordActive(registry, record),
          registryAuthorityActive: registryAuthority(),
          authorityActive: authority(),
          oldSignal: capturePluginRegistryLifecycleSignal(registry, epoch),
          nextActive: nextEpoch ? isPluginRegistryLifecycleEpochActive(registry, nextEpoch) : false,
          nextSignalAborted: nextEpoch
            ? capturePluginRegistryLifecycleSignal(registry, nextEpoch)?.aborted
            : undefined,
        });
      });

      if (action === "retire") {
        markPluginRegistryRetired(registry);
      } else {
        markPluginRegistryActive(registry);
      }

      expect(signal.aborted).toBe(true);
      expect(observations).toEqual([
        {
          registryActive: false,
          recordActive: action === "reactivate",
          registryAuthorityActive: false,
          authorityActive: action === "reactivate",
          oldSignal: undefined,
          nextActive: action === "reactivate",
          nextSignalAborted: action === "reactivate" ? false : undefined,
        },
      ]);
      markPluginRegistryActive(registry);
      const next = captureActivation(registry);
      expect(next.epoch).not.toBe(epoch);
      expect(next.signal.aborted).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(registryAuthority()).toBe(false);
      expect(authority()).toBe(action === "reactivate");
      expect(observations).toHaveLength(1);
    },
  );

  it("does not retire a registry or sibling record when one record is revoked", () => {
    const registry = createEmptyPluginRegistry();
    const first = createPluginRecord({ id: "first-owner" });
    const sibling = createPluginRecord({ id: "sibling-owner" });
    registry.plugins.push(first, sibling);
    markPluginRegistryActive(registry);
    const { epoch, signal } = captureActivation(registry);
    const firstAuthority = capturePluginLifecycleAuthority(registry, first)!;
    const siblingAuthority = capturePluginLifecycleAuthority(registry, sibling)!;

    revokePluginRecord(registry, first);

    expect(firstAuthority()).toBe(false);
    expect(siblingAuthority()).toBe(true);
    expect(isPluginRegistryLifecycleEpochActive(registry, epoch)).toBe(true);
    expect(signal.aborted).toBe(false);
  });

  it.each(["commit", "rollback"] as const)(
    "retires only the abandoned activation after staged %s",
    (action) => {
      const original = createEmptyPluginRegistry();
      const candidate = createEmptyPluginRegistry();
      setActivePluginRegistry(original);
      const first = captureActivation(original);
      const snapshot = captureActivePluginRegistrySnapshot();

      stageActivePluginRegistry(candidate, "candidate", "default");
      const second = captureActivation(candidate);
      expect(first.signal.aborted).toBe(false);

      if (action === "commit") {
        commitStagedPluginRegistry(original, candidate);
      } else {
        rollbackStagedPluginRegistry(snapshot);
      }

      expect(first.signal.aborted).toBe(action === "commit");
      expect(second.signal.aborted).toBe(action === "rollback");
      const retained = action === "commit" ? second : first;
      const current = captureActivation(action === "commit" ? candidate : original);
      expect(current.epoch).toBe(retained.epoch);
      expect(current.signal).toBe(retained.signal);
    },
  );
});
