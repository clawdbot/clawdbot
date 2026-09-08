import path from "node:path";
import { expect, it } from "vitest";
import {
  getCachedPluginModuleLoader,
  getPluginModuleLoaderStats,
} from "../plugins/plugin-module-loader-cache.js";
import {
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler,
} from "./session-event-wake.js";

it("shares the installed wake owner with a source-transformed runtime module", async () => {
  const modulePath = path.resolve("src/infra/session-event-wake.ts");
  const before = getPluginModuleLoaderStats();
  const load = getCachedPluginModuleLoader({
    modulePath,
    importerUrl: import.meta.url,
    tryNative: false,
  });
  const transformed = load(modulePath) as typeof import("./session-event-wake.js");
  expect(getPluginModuleLoaderStats().sourceTransformForced).toBeGreaterThan(
    before.sourceTransformForced,
  );

  const observed: string[] = [];
  const dispose = setSessionEventWakeHandler(async (request) => {
    observed.push(request.reason ?? "");
    return { status: "ran", durationMs: 0 };
  });
  const request = {
    source: "other" as const,
    intent: "immediate" as const,
    agentId: "main",
    sessionKey: "agent:main:main",
    coalesceMs: 0,
  };
  try {
    expect(
      await requestSessionEventWakeAndWait(
        { ...request, reason: "native" },
        { abortSignal: AbortSignal.timeout(1_000) },
      ),
    ).toMatchObject({ status: "ran" });
    expect(
      await transformed.requestSessionEventWakeAndWait(
        { ...request, reason: "transformed" },
        { abortSignal: AbortSignal.timeout(1_000) },
      ),
    ).toMatchObject({ status: "ran" });
    expect(observed).toEqual(["native", "transformed"]);
  } finally {
    // Drain the separate pre-fix queue too, without mutating private owner metadata.
    const disposeDrain = transformed.setSessionEventWakeHandler(async () => ({
      status: "skipped",
      reason: "test-cleanup",
    }));
    await transformed.requestSessionEventWakeAndWait(request, {
      abortSignal: AbortSignal.timeout(1_000),
    });
    dispose();
    disposeDrain();
  }
});
