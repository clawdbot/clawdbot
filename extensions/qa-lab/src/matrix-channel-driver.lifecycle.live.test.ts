import path from "node:path";
import { pathToFileURL } from "node:url";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { QaChannelDriverRuntime } from "./channel-driver-lifecycle.js";
import type { QaTransportDriver } from "./qa-transport-registry.js";

const EXPECTED_SCENARIOS = ["cold-start", "idempotent-start", "restart", "stop", "resume"];
const MATRIX_ROOM_ID = "!matrix-lifecycle:matrix.test";
const MATRIX_CHANNEL_DRIVERS = ["live", "crabline"] as const satisfies readonly QaTransportDriver[];

type QaLabRuntimeApi = typeof import("../runtime-api.js");

async function loadQaLabRuntimeApi(): Promise<QaLabRuntimeApi> {
  const runtimeApiPath = path.join(process.cwd(), "dist", "extensions", "qa-lab", "runtime-api.js");
  return (await import(pathToFileURL(runtimeApiPath).href)) as QaLabRuntimeApi;
}

async function withChannelDriverOutputDir(
  driver: QaTransportDriver,
  run: (outputDir: string) => Promise<void>,
) {
  let runError: Error | undefined;
  try {
    await withTempDir(`matrix-${driver}-lifecycle-`, async (outputDir) => {
      try {
        await run(outputDir);
      } catch (error) {
        runError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    });
  } catch (error) {
    if (runError) {
      throw runError;
    }
    if ((error as NodeJS.ErrnoException).code !== "EACCES") {
      throw error;
    }
  }
}

function sendMatrixLifecycleProbe(runtime: QaChannelDriverRuntime, sequence: number) {
  return runtime.adapter.sendInbound({
    conversation: { id: MATRIX_ROOM_ID, kind: "group" },
    senderId: "@lifecycle-driver:matrix.test",
    senderName: "Matrix Lifecycle Driver",
    text: `Matrix lifecycle probe ${sequence}`,
  });
}

describe.each(MATRIX_CHANNEL_DRIVERS)("Matrix %s channel driver lifecycle", (driver) => {
  it("passes all five scenarios through the selected QA transport adapter", async () => {
    await withChannelDriverOutputDir(driver, async (outputDir) => {
      const runtimeApi = await loadQaLabRuntimeApi();
      const lifecycle = runtimeApi.createQaChannelDriverLifecycle({
        channelId: "matrix",
        driver,
        outputDir,
      });
      let sequence = 0;

      try {
        const results = await runtimeApi.runQaChannelDriverLifecycleScenarios({
          async assertStopped(runtime) {
            await expect(sendMatrixLifecycleProbe(runtime, ++sequence)).rejects.toThrow();
          },
          lifecycle,
          async probe(runtime) {
            await sendMatrixLifecycleProbe(runtime, ++sequence);
          },
        });

        expect(results).toEqual(EXPECTED_SCENARIOS);
      } finally {
        await lifecycle.stop();
      }
    });
  }, 240_000);
});
