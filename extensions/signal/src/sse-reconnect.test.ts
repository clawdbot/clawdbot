import { beforeEach, describe, expect, it, vi } from "vitest";

const streamSignalEvents = vi.hoisted(() => vi.fn());

vi.mock("./client-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("./client-adapter.js")>("./client-adapter.js");
  return { ...actual, streamSignalEvents };
});

import { SignalSseRejectionError } from "./client-adapter.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("runSignalSseLoop lifecycle", () => {
  beforeEach(() => {
    streamSignalEvents.mockReset();
  });

  it("publishes ready on stream open and recovering when the stream ends", async () => {
    const abort = new AbortController();
    const statusSink = vi.fn((patch: { lifecycle?: string }) => {
      if (patch.lifecycle === "recovering") {
        abort.abort();
      }
    });
    streamSignalEvents.mockImplementationOnce(async (params) => {
      params.onStreamOpen?.();
    });

    await runSignalSseLoop({
      baseUrl: "http://signal.test",
      abortSignal: abort.signal,
      runtime: createRuntime(),
      onEvent: vi.fn(),
      statusSink,
    });

    expect(statusSink).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ lifecycle: "ready", connected: true }),
    );
    expect(statusSink).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    );
  });

  it("publishes recovering for stream errors", async () => {
    const abort = new AbortController();
    const statusSink = vi.fn((patch: { lifecycle?: string }) => {
      if (patch.lifecycle === "recovering") {
        abort.abort();
      }
    });
    streamSignalEvents.mockRejectedValueOnce(new Error("stream failed"));

    await runSignalSseLoop({
      baseUrl: "http://signal.test",
      abortSignal: abort.signal,
      runtime: createRuntime(),
      onEvent: vi.fn(),
      statusSink,
    });

    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "recovering", lastError: "Error: stream failed" }),
    );
  });

  it("publishes a distinct terminal status and stops retrying on a 401 rejection", async () => {
    const statusSink = vi.fn();
    streamSignalEvents.mockRejectedValue(new SignalSseRejectionError(401, "Unauthorized"));

    await runSignalSseLoop({
      baseUrl: "http://signal.test",
      runtime: createRuntime(),
      onEvent: vi.fn(),
      statusSink,
    });

    expect(streamSignalEvents).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: "blocked",
        terminalDisconnect: true,
        connected: false,
        lastError: expect.stringMatching(/401 Unauthorized/),
      }),
    );
  });

  it("keeps retrying a plain error that merely mentions 401 in its text", async () => {
    // Regression control: status detection reads SignalSseRejectionError#status, not
    // free-text matching, so a differently-worded or wrapped rejection that happens to
    // mention "401" must not be mistaken for the typed terminal rejection.
    const abort = new AbortController();
    const statusSink = vi.fn((patch: { lifecycle?: string }) => {
      if (patch.lifecycle === "recovering") {
        abort.abort();
      }
    });
    streamSignalEvents.mockRejectedValue(new Error("connection reset (was 401 last time)"));

    await runSignalSseLoop({
      baseUrl: "http://signal.test",
      abortSignal: abort.signal,
      runtime: createRuntime(),
      onEvent: vi.fn(),
      statusSink,
    });

    expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "recovering" }));
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "blocked" }));
  });
});
