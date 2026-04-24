import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS: 30 * 60 * 1000,
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  ensureGlobalUndiciStreamTimeouts: vi.fn(),
}));

vi.mock("../../../infra/net/undici-global-dispatcher.js", () => ({
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS: mocks.DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
  ensureGlobalUndiciEnvProxyDispatcher: mocks.ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts: mocks.ensureGlobalUndiciStreamTimeouts,
}));

import { configureEmbeddedAttemptHttpRuntime } from "./attempt-http-runtime.js";

describe("runEmbeddedAttempt undici timeout wiring", () => {
  beforeEach(() => {
    mocks.ensureGlobalUndiciEnvProxyDispatcher.mockReset();
    mocks.ensureGlobalUndiciStreamTimeouts.mockReset();
  });

  it("does not lower global undici stream tuning below the shared default", () => {
    configureEmbeddedAttemptHttpRuntime({ timeoutMs: 123_456 });

    expect(mocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(mocks.ensureGlobalUndiciStreamTimeouts).toHaveBeenCalledWith({
      timeoutMs: mocks.DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
    });
  });

  it("preserves run timeouts above the shared default", () => {
    const timeoutMs = mocks.DEFAULT_UNDICI_STREAM_TIMEOUT_MS + 1_000;

    configureEmbeddedAttemptHttpRuntime({ timeoutMs });

    expect(mocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(mocks.ensureGlobalUndiciStreamTimeouts).toHaveBeenCalledWith({
      timeoutMs,
    });
  });
});
