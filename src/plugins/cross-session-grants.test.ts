import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createCrossSessionGrantRuntime } from "./cross-session-grants.js";
import type { CrossSessionGrant } from "./runtime/types.js";

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

function authority(signal: AbortSignal, overrides: Partial<typeof grant> = {}) {
  return {
    grantId: overrides.grantId ?? grant.grantId,
    subjectId: overrides.subjectId ?? grant.subjectId,
    subjectBinding: overrides.subjectBinding ?? grant.subjectBinding,
    targetSessionId: overrides.targetSessionId ?? grant.targetSessionId,
    generation: overrides.generation ?? grant.generation,
    signal,
  };
}

describe("cross-session grant runtime", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let stateDir = "";
  let env: NodeJS.ProcessEnv;
  let live = true;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = tempDirs.make("openclaw-cross-session-grants-");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    live = true;
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("persists exact grants and rejects stale or closed lifecycle authority", () => {
    const runtime = createCrossSessionGrantRuntime("reef", () => live, env);
    const controller = new AbortController();

    expect(runtime.create(grant, controller.signal)).toBe(true);
    expect(runtime.authorize(authority(controller.signal))).toMatchObject(grant);
    expect(
      runtime.authorize(authority(controller.signal, { subjectBinding: "rotated-key" })),
    ).toBeUndefined();

    controller.abort();
    expect(runtime.allowStanding(authority(controller.signal))).toBe(false);
    expect(runtime.get(grant.grantId, controller.signal)).toBeUndefined();
    expect(runtime.list(controller.signal)).toEqual([]);
    expect(runtime.create({ ...grant, grantId: "closed-grant" }, controller.signal)).toBe(false);
    expect(
      runtime.revoke({
        grantId: grant.grantId,
        expectedGeneration: grant.generation,
        signal: controller.signal,
      }),
    ).toBeUndefined();

    const nextLifecycle = new AbortController();
    expect(runtime.get(grant.grantId, nextLifecycle.signal)?.standing).toBe(false);
    expect(runtime.allowStanding(authority(nextLifecycle.signal))).toBe(true);
    expect(
      createCrossSessionGrantRuntime("reef", () => live, env).get(
        grant.grantId,
        nextLifecycle.signal,
      ),
    ).toMatchObject({ standing: true, generation: 0 });

    live = false;
    expect(runtime.authorize(authority(nextLifecycle.signal))).toBeUndefined();
  });

  it("accepts exact grant redelivery without allowing identifier rebinding", () => {
    const runtime = createCrossSessionGrantRuntime("reef", () => live, env);
    const signal = new AbortController().signal;

    expect(runtime.create(grant, signal)).toBe(true);
    expect(runtime.create(grant, signal)).toBe(true);
    expect(runtime.create({ ...grant, targetSessionId: "other-session" }, signal)).toBe(false);
    expect(runtime.list(signal)).toHaveLength(1);
  });

  it("counts revoked grants against the subject quota until replay state expires", () => {
    const runtime = createCrossSessionGrantRuntime("reef", () => live, env);
    const signal = new AbortController().signal;
    for (let index = 0; index < 32; index += 1) {
      const grantId = `grant-${index}`;
      expect(runtime.create({ ...grant, grantId }, signal)).toBe(true);
      expect(runtime.revoke({ grantId, expectedGeneration: 0, signal })).toMatchObject({
        revoked: true,
      });
    }
    expect(runtime.create({ ...grant, grantId: "grant-overflow" }, signal)).toBe(false);
    expect(
      runtime.create({ ...grant, grantId: "other-subject", subjectId: "other-peer" }, signal),
    ).toBe(true);
  });

  it("revokes issuer grants and binds holder revocation to the exact subject", () => {
    const runtime = createCrossSessionGrantRuntime("reef", () => live, env);
    const signal = new AbortController().signal;
    expect(runtime.create(grant, signal)).toBe(true);

    expect(runtime.revoke({ grantId: grant.grantId, expectedGeneration: 0, signal })).toMatchObject(
      {
        generation: 1,
        standing: false,
        revoked: true,
        revocationPending: true,
      },
    );
    expect(runtime.acknowledgeRevocation({ grantId: grant.grantId, generation: 1, signal })).toBe(
      true,
    );
    expect(runtime.get(grant.grantId, signal)).toMatchObject({ revocationPending: false });
    expect(runtime.authorize(authority(signal))).toBeUndefined();

    const holder = { ...grant, grantId: "holder-1", role: "holder" as const };
    expect(runtime.create(holder, signal)).toBe(true);
    expect(
      runtime.applyRevocation(
        authority(signal, { ...holder, subjectId: "other-peer", generation: 1 }),
      ),
    ).toBe(false);
    expect(runtime.applyRevocation(authority(signal, { ...holder, generation: 1 }))).toBe(true);
    expect(runtime.get(holder.grantId, signal)).toMatchObject({ generation: 1, revoked: true });
  });
});
