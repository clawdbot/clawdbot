import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpRuntimeError } from "./errors.js";
import {
  __testing,
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "./registry.js";
import type { AcpRuntime } from "./types.js";

function createRuntimeStub(): AcpRuntime {
  return {
    async ensureSession(input) {
      return {
        sessionKey: input.sessionKey,
        backend: "stub",
        runtimeSessionName: `${input.sessionKey}:runtime`,
      };
    },
    async *runTurn() {
      // no-op stream
    },
    async cancel() {},
    async close() {},
  };
}

describe("acp runtime registry", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  afterEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  it("registers and resolves backends by id", () => {
    const runtime = createRuntimeStub();
    registerAcpRuntimeBackend({ id: "acpx", runtime });

    const backend = getAcpRuntimeBackend("acpx");
    expect(backend?.id).toBe("acpx");
    expect(backend?.runtime).toBe(runtime);
  });

  it("prefers a healthy backend when resolving without explicit id", () => {
    const unhealthyRuntime = createRuntimeStub();
    const healthyRuntime = createRuntimeStub();

    registerAcpRuntimeBackend({
      id: "unhealthy",
      runtime: unhealthyRuntime,
      healthy: () => false,
    });
    registerAcpRuntimeBackend({
      id: "healthy",
      runtime: healthyRuntime,
      healthy: () => true,
    });

    const backend = getAcpRuntimeBackend();
    expect(backend?.id).toBe("healthy");
  });

  it("throws a typed missing-backend error when no backend is registered", () => {
    expect(() => requireAcpRuntimeBackend()).toThrowError(AcpRuntimeError);
    expect(() => requireAcpRuntimeBackend()).toThrowError(/ACP runtime backend is not configured/i);
  });

  it("resolves the first healthy backend when requireAcpRuntimeBackend has no explicit id", () => {
    const unhealthyRuntime = createRuntimeStub();
    const healthyRuntime = createRuntimeStub();

    registerAcpRuntimeBackend({
      id: "unhealthy",
      runtime: unhealthyRuntime,
      healthy: () => false,
    });
    registerAcpRuntimeBackend({
      id: "healthy",
      runtime: healthyRuntime,
      healthy: () => true,
    });

    const backend = requireAcpRuntimeBackend();
    expect(backend.id).toBe("healthy");
    expect(backend.runtime).toBe(healthyRuntime);
  });

  it("throws a typed unavailable error when the requested backend is unhealthy", () => {
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: createRuntimeStub(),
      healthy: () => false,
    });

    try {
      requireAcpRuntimeBackend("acpx");
      throw new Error("expected requireAcpRuntimeBackend to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AcpRuntimeError);
      expect((err as AcpRuntimeError).code).toBe("ACP_BACKEND_UNAVAILABLE");
    }
  });

  it("unregisters a backend by id", () => {
    registerAcpRuntimeBackend({ id: "acpx", runtime: createRuntimeStub() });
    unregisterAcpRuntimeBackend("acpx");
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("keeps backend state on a global registry for cross-loader access", () => {
    const runtime = createRuntimeStub();
    const sharedState = __testing.getAcpRuntimeRegistryGlobalStateForTests();

    sharedState.backendsById.set("acpx", {
      id: "acpx",
      runtime,
    });

    const backend = getAcpRuntimeBackend("acpx");
    expect(backend?.runtime).toBe(runtime);
  });
});
