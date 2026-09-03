import { fileURLToPath } from "node:url";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import crabboxPlugin from "../../extensions/crabbox/index.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  startPluginServices,
} from "../../src/plugins/services.js";
import { createDeferredCore } from "../../src/shared/deferred.js";

describe("Crabbox service replacement", () => {
  it("settles an active Crabbox heartbeat before strict replacement completes", async () => {
    const started = createDeferredCore();
    const finished = createDeferredCore<processRuntime.SpawnResult>();
    const cleanup = new AbortController();
    const commands: Array<Promise<processRuntime.SpawnResult>> = [];
    const runCommand = processRuntime.runCommandWithTimeout;
    const childScript = `
      process.on("SIGTERM", () => {});
      process.stdout.write("ready");
      setInterval(() => {}, 1000);
    `;
    let output = "";
    let childSettled = false;
    const runner = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        if (argv[1] === "heartbeat") {
          try {
            const command = runCommand([process.execPath, "-e", childScript], {
              ...(typeof options === "number" ? { timeoutMs: options } : options),
              signal: AbortSignal.any([
                cleanup.signal,
                ...(typeof options === "object" && options.signal ? [options.signal] : []),
              ]),
              onOutputChunk: (chunk, stream) => {
                if (stream === "stdout") {
                  output += chunk.toString();
                  if (output === "ready") {
                    started.resolve();
                  }
                }
              },
            });
            commands.push(command);
            const result = await command;
            childSettled = true;
            finished.resolve(result);
            return result;
          } catch (error) {
            finished.reject(error);
            throw error;
          }
        }
        return {
          stdout: JSON.stringify({
            id: "cbx_replacement",
            providerMetadata: { instanceProfileAttached: false },
            host: "worker.example.test",
            sshHost: "worker.example.test",
            sshKey: "/mock/worker-key",
            sshPort: 2222,
            sshUser: "openclaw",
            ready: true,
            state: "running",
          }),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
    const registry = createEmptyPluginRegistry();
    let provider!: WorkerProvider;
    crabboxPlugin.register(
      createTestPluginApi({
        id: "crabbox",
        rootDir: fileURLToPath(new URL("../../extensions/crabbox/", import.meta.url)),
        registerService: (service) => {
          registry.services.push({
            pluginId: "crabbox",
            service,
            source: "test",
            origin: "bundled",
          });
        },
        registerWorkerProvider: (registered) => {
          provider = registered;
        },
      }),
    );
    const handle = await startPluginServices({ registry, config: {} });
    const lease = {
      leaseId: "cbx_replacement",
      profile: { binary: "/mock/crabbox", provider: "aws", idleTimeout: "12s", ttl: "24h" },
    };
    try {
      await provider.inspect(lease);
      await Promise.race([
        started.promise,
        finished.promise.then(() => {
          throw new Error("heartbeat exited before readiness");
        }),
      ]);
      await handle.stop({
        strict: true,
        deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      });
      expect(childSettled).toBe(true);
      const result = await finished.promise;
      expect(result).toMatchObject({ pid: expect.any(Number), termination: "signal" });
      expect(processRuntime.isPidDefinitelyDead(result.pid!)).toBe(true);

      vi.useFakeTimers();
      await provider.inspect(lease);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runner.mock.calls.filter(([argv]) => argv[1] === "heartbeat")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      cleanup.abort();
      await Promise.allSettled([handle.stop(), ...commands]);
      runner.mockRestore();
    }
  });
});
