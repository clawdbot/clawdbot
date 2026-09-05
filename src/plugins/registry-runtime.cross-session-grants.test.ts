import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { markPluginRegistryActive } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { CrossSessionGrant } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const grant: CrossSessionGrant = {
  grantId: "grant-1",
  subjectId: "remote-peer",
  subjectBinding: "peer-key-epoch-1",
  role: "issuer",
  targetSessionKey: "agent:main:shared",
  targetSessionId: "session-1",
  generation: 0,
  standing: false,
  revoked: false,
  revocationPending: false,
};

describe("plugin runtime cross-session grant ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = tempDirs.make("openclaw-runtime-grants-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetPluginStateStoreForTests();
  });

  it("permanently retires a grant runtime retained by a replaced plugin record", () => {
    const registryBuilder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const original = createPluginRecord({ id: "reef", origin: "bundled" });
    const originalApi = registryBuilder.createApi(original, {
      config: {} as OpenClawConfig,
      registrationMode: "full",
    });
    registryBuilder.registry.plugins.push(original);
    markPluginRegistryActive(registryBuilder.registry);

    const retainedParent = originalApi.runtime;
    const retained = retainedParent.crossSessionGrants;
    const signal = new AbortController().signal;
    expect(retained.create(grant, signal)).toBe(true);

    const replacement = createPluginRecord({ id: "reef", origin: "bundled" });
    const replacementApi = registryBuilder.createApi(replacement, {
      config: {} as OpenClawConfig,
      registrationMode: "full",
    });
    registryBuilder.registry.plugins.push(replacement);

    expect(retained.get(grant.grantId, signal)).toBeUndefined();
    expect(retained.create({ ...grant, grantId: "stale-grant" }, signal)).toBe(false);
    expect(
      retainedParent.crossSessionGrants.create({ ...grant, grantId: "stale-parent-grant" }, signal),
    ).toBe(false);
    expect(replacementApi.runtime.crossSessionGrants.get(grant.grantId, signal)).toMatchObject(
      grant,
    );
  });
});
