import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, vi } from "vitest";
import type { startCodexAttemptThread } from "./attempt-startup.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexAppServerSpawnIdentity } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

export type AttemptClientHarness = ReturnType<typeof createClientHarness>;
export const HARNESS_REQUEST_TIMEOUT_MS = 15_000;

export function readHarnessMessages(
  writes: string[],
): Array<{ id?: number; method?: string; params?: unknown }> {
  return writes.map(
    (write) => JSON.parse(write) as { id?: number; method?: string; params?: unknown },
  );
}

export function readHarnessRequestMethods(
  harness: AttemptClientHarness,
): Array<string | undefined> {
  return readHarnessMessages(harness.writes)
    .filter(({ id }) => id !== undefined)
    .map(({ method }) => method);
}

export async function answerInitialize(harness: AttemptClientHarness): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1), {
    interval: 1,
    timeout: HARNESS_REQUEST_TIMEOUT_MS,
  });
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent: "openclaw/0.149.0 (macOS; test)" } });
}

export async function answerPreparedApiKeyLogin(harness: AttemptClientHarness): Promise<void> {
  const login = await waitForRequest(harness, "account/login/start");
  expect(login.params).toEqual({
    type: "apiKey",
    apiKey: "prepared-platform-key",
  });
  harness.send({ id: login.id, result: { type: "apiKey" } });
}

export async function waitForRequest(
  harness: AttemptClientHarness,
  method: string,
): Promise<{ id?: number; method?: string; params?: unknown }> {
  await vi.waitFor(
    () =>
      expect(readHarnessMessages(harness.writes).some((write) => write.method === method)).toBe(
        true,
      ),
    { interval: 1, timeout: HARNESS_REQUEST_TIMEOUT_MS },
  );
  const request = readHarnessMessages(harness.writes).find((write) => write.method === method);
  if (!request) {
    throw new Error(`${method} request was not written`);
  }
  return request;
}

export async function waitForThreadStart(harness: AttemptClientHarness): Promise<{ id?: number }> {
  return waitForRequest(harness, "thread/start");
}

export async function captureExpectedRuntimeArtifact(
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
) {
  const { captureCodexAppServerRuntimeArtifactBeforeStart, finalizeCodexAppServerRuntimeArtifact } =
    await import("./runtime-artifact.js");
  const spawnIdentity = resolveCodexAppServerSpawnIdentity(appServer.start);
  const before = await captureCodexAppServerRuntimeArtifactBeforeStart({
    startOptions: appServer.start,
    spawnIdentity,
  });
  return finalizeCodexAppServerRuntimeArtifact({
    before,
    startOptions: appServer.start,
    spawnIdentity,
    runtimeIdentity: { serverVersion: "0.149.0", userAgent: "openclaw/0.149.0 (macOS; test)" },
  });
}

export function createPairedAttemptRuntime() {
  const channels: Array<{ close: ReturnType<typeof vi.fn>; sessionId: string }> = [];
  const openDuplex = vi.fn<
    NonNullable<Parameters<typeof startCodexAttemptThread>[0]["runtime"]>["nodes"]["openDuplex"]
  >(async (request) => {
    let resolveClosed: (value: unknown) => void = () => undefined;
    const closed = new Promise<unknown>((resolve) => {
      resolveClosed = resolve;
    });
    const channel = {
      send: vi.fn(async () => undefined),
      onMessage: vi.fn(() => () => undefined),
      closed,
      close: vi.fn(() => resolveClosed({ ok: true })),
    };
    channels.push({
      close: channel.close,
      sessionId: (request.params as { sessionId: string }).sessionId,
    });
    return channel;
  });
  return {
    runtime: createPluginRuntimeMock({ nodes: { openDuplex } }),
    channels,
    openDuplex,
  };
}
