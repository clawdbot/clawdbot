// Regression coverage for #116295: the managed signal-cli daemon's SSE endpoint stays
// idle between inbound events, so a live child process is the only other liveness
// signal and a hung daemon looked healthy forever. The heartbeat must (1) re-probe on
// an interval, (2) publish connected/transport-activity status on success, (3) publish
// disconnected status and log on failure so the gateway health monitor can restart it,
// and (4) recover to connected once the daemon answers again — without restart churn
// on an isolated failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signalCheckMock = vi.hoisted(() => vi.fn());
vi.mock("./client-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, signalCheck: signalCheckMock };
});

import { startSignalDaemonHeartbeat } from "./monitor.js";

describe("startSignalDaemonHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signalCheckMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("probes immediately, then republishes connected status on each successful interval", async () => {
    signalCheckMock.mockResolvedValue({ ok: true });
    const setStatus = vi.fn();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const heartbeat = startSignalDaemonHeartbeat({
      baseUrl: "http://127.0.0.1:8080",
      runtime,
      statusSink: setStatus,
    });
    await vi.waitFor(() => expect(signalCheckMock).toHaveBeenCalledTimes(1));
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true, lastError: null }),
    );

    setStatus.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signalCheckMock).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true, lastError: null }),
    );
    expect(runtime.error).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  it("publishes disconnected status and logs when a probe fails, then recovers on the next success", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: false, status: null, error: "timeout" });
    const setStatus = vi.fn();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const heartbeat = startSignalDaemonHeartbeat({
      baseUrl: "http://127.0.0.1:8080",
      runtime,
      statusSink: setStatus,
    });
    await vi.waitFor(() => expect(signalCheckMock).toHaveBeenCalledTimes(1));

    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: false,
        lastError: expect.stringContaining("timeout"),
      }),
    );
    expect(runtime.error).toHaveBeenCalledTimes(1);

    // Recovery: a transient hang must not wedge the daemon as permanently
    // disconnected, and must not itself trigger a restart-churn side effect here -
    // the heartbeat only reports state, the health monitor owns restart decisions.
    signalCheckMock.mockResolvedValueOnce({ ok: true });
    setStatus.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true, lastError: null }),
    );

    heartbeat.stop();
  });

  it("stops probing once stopped", async () => {
    signalCheckMock.mockResolvedValue({ ok: true });
    const setStatus = vi.fn();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const heartbeat = startSignalDaemonHeartbeat({
      baseUrl: "http://127.0.0.1:8080",
      runtime,
      statusSink: setStatus,
    });
    await vi.waitFor(() => expect(signalCheckMock).toHaveBeenCalledTimes(1));
    heartbeat.stop();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(signalCheckMock).toHaveBeenCalledTimes(1);
  });
});
