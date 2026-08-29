import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRelativeBundledPluginPublicModuleId } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createDeferred } from "./promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "./qa-gateway-cleanup.js";

const qaApiModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "qa-lab",
  artifactBasename: "api.js",
});
const qaRuntimeModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "qa-lab",
  artifactBasename: "runtime-api.js",
});

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:child_process");
  vi.doUnmock(qaApiModuleId);
  vi.doUnmock(qaRuntimeModuleId);
  vi.doUnmock("../../src/gateway/client.js");
  vi.doUnmock("../../scripts/e2e/lib/plugin-index-sqlite.mjs");
  vi.doUnmock("../e2e/qa-lab/runtime/otel-test-support.js");
  vi.resetModules();
});

function errorTree(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(errorTree)] : [error];
}

describe("QA gateway fixture error composition", () => {
  it.each(["diagnostic", "rejection"])(
    "stops the WebChat bus after startup fails and owner cleanup reports a %s",
    async (mode) => {
      const startupError = new Error("WebChat gateway startup failed");
      const gatewayError = new Error("WebChat gateway cleanup failed");
      const busError = new Error("WebChat bus cleanup failed");
      const cleaned: string[] = [];
      const bodies: Array<() => Promise<void>> = [];
      const cleanups: Array<() => Promise<void>> = [];
      const start = async () => {
        throw startupError;
      };
      vi.doMock("vitest", () => ({
        afterEach: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
        describe: (_name: string, body: () => void) => body(),
        it: (_name: string, _options: unknown, body: () => Promise<void>) => bodies.push(body),
        expect,
      }));
      vi.doMock(qaApiModuleId, () => ({
        createQaBusState: () => ({}),
        createQaChannelTransport: () => ({}),
        startQaBusServer: async () => ({
          baseUrl: "http://127.0.0.1:43210",
          stop: async () => {
            cleaned.push("bus");
            throw busError;
          },
        }),
      }));
      vi.doMock(qaRuntimeModuleId, () => ({
        createQaLiveLaneGateway: () => ({
          start,
          stop: async () => {
            cleaned.push("gateway");
            if (mode === "rejection") {
              throw gatewayError;
            }
            return { errors: [gatewayError] };
          },
        }),
      }));
      vi.doMock("../../src/gateway/client.js", () => ({ GatewayClient: vi.fn() }));

      await import("../e2e/qa-lab/runtime/webchat-media-artifacts.e2e.test.js");
      expect(bodies).toHaveLength(1);
      expect(cleanups).toHaveLength(1);
      await expect(bodies[0]!()).rejects.toBe(startupError);
      const cleanupError: unknown = await cleanups[0]!().catch((error: unknown) => error);
      expect(cleaned).toEqual(["gateway", "bus"]);
      expect(errorTree(cleanupError)).toEqual(expect.arrayContaining([gatewayError, busError]));
    },
  );

  it("completes a successful body and all cleanup phases", async () => {
    const cleaned: string[] = [];
    await expect(
      runQaGatewayFixture(
        async () => {
          cleaned.push("body");
        },
        () => {
          cleaned.push("gateway");
        },
        () => {
          cleaned.push("provider");
        },
      ),
    ).resolves.toBeUndefined();
    expect(cleaned).toEqual(["body", "gateway", "provider"]);
  });

  it.each(["body", "cleanup"])(
    "retains the original %s-only error and finishes cleanup",
    async (phase) => {
      const failure = new Error(`${phase} failed`);
      const lastCleanup = vi.fn();
      await expect(
        runQaGatewayFixture(
          async () => {
            if (phase === "body") {
              throw failure;
            }
          },
          () => {
            if (phase === "cleanup") {
              throw failure;
            }
          },
          lastCleanup,
        ),
      ).rejects.toBe(failure);
      expect(lastCleanup).toHaveBeenCalledOnce();
    },
  );

  it("settles ordered releases and browser cleanup before stopping every remaining owner", async () => {
    const bodyError = new Error("body failed");
    const releaseError = new Error("patch release failed");
    const contextError = new Error("context close failed");
    const browserError = new Error("browser close failed");
    const gatewayError = new Error("gateway finalization failed");
    const events: string[] = [];
    const contextClosing = createDeferred();
    const releaseContext = createDeferred();
    const result = runQaGatewayFixture(
      async () => {
        throw bodyError;
      },
      () => {
        events.push("release");
        throw releaseError;
      },
      async () => {
        events.push("context-closing");
        contextClosing.resolve();
        await releaseContext.promise;
        events.push("context-settled");
        throw contextError;
      },
      () => {
        events.push("browser");
        throw browserError;
      },
      () => {
        events.push("node");
      },
      () =>
        stopQaGatewayFixture({
          stop: async () => {
            events.push("gateway");
            return { errors: [gatewayError] };
          },
        }),
      () => {
        events.push("provider");
      },
    ).catch((error: unknown) => error);
    await contextClosing.promise;
    const beforeSettlement = [...events];
    releaseContext.resolve();
    const failure = await result;
    expect(beforeSettlement).toEqual(["release", "context-closing"]);
    expect(events).toEqual([
      "release",
      "context-closing",
      "context-settled",
      "browser",
      "node",
      "gateway",
      "provider",
    ]);
    expect(errorTree(failure)).toEqual(
      expect.arrayContaining([bodyError, releaseError, contextError, browserError, gatewayError]),
    );
  });

  it("retains startup and finalization errors through the actual OTel fixture", async () => {
    const startupError = new Error("fixture startup failed");
    const finalizationError = new Error("fixture finalization failed");
    const cleaned: string[] = [];
    const bodies: Array<() => Promise<void>> = [];
    const registry = {
      exitCode: null as number | null,
      kill() {
        cleaned.push("registry");
        registry.exitCode = 0;
        return true;
      },
    };
    let receiverCount = 0;
    vi.doMock("vitest", () => ({
      describe: (_name: string, body: () => void) => body(),
      test: (_name: string, body: () => Promise<void>) => bodies.push(body),
      expect,
    }));
    vi.doMock("node:child_process", () => ({
      execFile: (...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === "function") {
          callback(null, "", "");
        }
      },
      spawn: () => registry,
    }));
    vi.doMock("node:fs/promises", () => ({
      cp: async () => {},
      mkdir: async () => {},
      mkdtemp: async () => "/qa-fixture/scratch",
      readdir: async () => ["diagnostics-otel.tgz"],
      readFile: async (file: string) =>
        file.endsWith("registry-port") ? "43210" : JSON.stringify({ version: "1.0.0" }),
      rm: async () => {
        cleaned.push("scratch");
      },
      symlink: async () => {},
      writeFile: async () => {},
    }));
    vi.doMock(qaApiModuleId, () => ({
      createQaGatewayChild: () => ({
        start: async () => {
          throw startupError;
        },
        stop: async () => {
          cleaned.push("gateway");
          return { errors: [finalizationError] };
        },
      }),
      startQaMockOpenAiServer: async () => ({
        baseUrl: "http://127.0.0.1:43211",
        stop: async () => {
          cleaned.push("provider");
        },
      }),
    }));
    vi.doMock("../../scripts/e2e/lib/plugin-index-sqlite.mjs", () => ({
      readPluginInstallRecords: () => ({}),
    }));
    vi.doMock("../e2e/qa-lab/runtime/otel-test-support.js", () => ({
      startLocalOtlpReceiver: () => {
        const label = `receiver-${receiverCount++}`;
        return {
          listen: async () => 43212,
          close: async () => {
            cleaned.push(label);
          },
        };
      },
    }));

    await import("../e2e/qa-lab/runtime/diagnostics-otel-install-runtime.e2e.test.js");
    expect(bodies).toHaveLength(2);
    const failure: unknown = await bodies[0]!().catch((error: unknown) => error);
    expect(cleaned).toEqual([
      "gateway",
      "provider",
      "registry",
      "receiver-0",
      "receiver-1",
      "scratch",
    ]);
    expect(errorTree(failure)).toContain(startupError);
    expect(errorTree(failure)).toContain(finalizationError);
  });
});
