import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  ensureGlobalUndiciStreamTimeouts: vi.fn(),
}));

vi.mock("../../../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: mocks.ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts: mocks.ensureGlobalUndiciStreamTimeouts,
}));

import { configureEmbeddedAttemptHttpRuntime } from "./attempt-http-runtime.js";

describe("runEmbeddedAttempt undici timeout wiring", () => {
  beforeEach(() => {
    mocks.ensureGlobalUndiciEnvProxyDispatcher.mockReset();
    mocks.ensureGlobalUndiciStreamTimeouts.mockReset();
  });

  it("forwards the configured run timeout into global undici stream tuning", () => {
    configureEmbeddedAttemptHttpRuntime({ timeoutMs: 123_456 });

    expect(mocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(mocks.ensureGlobalUndiciStreamTimeouts).toHaveBeenCalledWith({
      timeoutMs: 123_456,
    });
  });
});
