// Qa Lab Matrix tests cover harness behavior.
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  MATRIX_QA_CLEANUP_TIMEOUT_MS,
  MATRIX_QA_SERVICE,
  buildVersionsUrl,
  isMatrixVersionsReachable,
  waitForReachableMatrixBaseUrl,
  writeMatrixQaHarnessFiles,
} from "./harness.runtime-internals.js";
import { startMatrixQaHarness } from "./harness.runtime.js";
import type { MatrixQaRecordingProxy } from "./recording-proxy.js";

const testing = {
  MATRIX_QA_CLEANUP_TIMEOUT_MS,
  MATRIX_QA_SERVICE,
  buildVersionsUrl,
  isMatrixVersionsReachable,
  waitForReachableMatrixBaseUrl,
  writeMatrixQaHarnessFiles,
};

type MatrixQaHarnessDeps = Parameters<typeof startMatrixQaHarness>[1];
type MatrixQaHarnessResult = Awaited<ReturnType<typeof startMatrixQaHarness>>;

function createRecordingProxy(stop: () => Promise<void> = async () => {}): MatrixQaRecordingProxy {
  return {
    baseUrl: "http://127.0.0.1:28008/",
    buildManifest: vi.fn(),
    installFaultRule: vi.fn(() => ({ hits: () => [], remove: vi.fn() })),
    records: () => [],
    setScenarioId: vi.fn(),
    setTargetBaseUrl: vi.fn(),
    stop: vi.fn(stop),
  } as unknown as MatrixQaRecordingProxy;
}

async function withStartedMatrixHarness(
  deps: MatrixQaHarnessDeps,
  verify: (params: { outputDir: string; result: MatrixQaHarnessResult }) => Promise<void> | void,
  options?: { dynamicPort?: boolean },
) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-harness-"));
  let result: MatrixQaHarnessResult | undefined;

  try {
    const startRecordingProxyImpl =
      deps?.startRecordingProxyImpl ??
      (async ({ targetBaseUrl }: { targetBaseUrl: string }) => ({
        ...createRecordingProxy(),
        baseUrl: targetBaseUrl,
      }));
    result = await startMatrixQaHarness(
      {
        repoRoot: "/repo/openclaw",
        ...(options?.dynamicPort ? {} : { homeserverPort: 28008 }),
      },
      { ...deps, startRecordingProxyImpl },
    );
    await verify({ outputDir, result });
  } finally {
    await result?.stop();
    await rm(outputDir, { recursive: true, force: true });
  }
}

function createContainerNetworkRunCommand(calls?: string[]) {
  return async function runCommand(command: string, args: string[], cwd?: string) {
    calls?.push([command, ...args, `@${cwd}`].join(" "));
    const rendered = args.join(" ");
    if (rendered.includes("ps --format json")) {
      return { stdout: '{"State":"running"}\n', stderr: "" };
    }
    if (rendered.includes("ps -q")) {
      return { stdout: "container-123\n", stderr: "" };
    }
    if (rendered.includes("inspect --format")) {
      return { stdout: "172.18.0.10\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

function createStalledVersionsFetch() {
  const probeSignals: AbortSignal[] = [];
  const fetchImpl = vi.fn(
    async (_input: string, init?: Pick<RequestInit, "signal">) =>
      await new Promise<never>((_resolve, reject) => {
        const probeSignal = init?.signal ?? undefined;
        if (!probeSignal) {
          reject(new Error("versions probe signal missing"));
          return;
        }
        probeSignals.push(probeSignal);
        const rejectAborted = () => reject(new Error("versions probe aborted"));
        if (probeSignal.aborted) {
          rejectAborted();
          return;
        }
        probeSignal.addEventListener("abort", rejectAborted, { once: true });
      }),
  );
  return { fetchImpl, probeSignals };
}

describe("matrix harness runtime", () => {
  it("writes a pinned Tuwunel compose file", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-harness-"));

    try {
      const result = await testing.writeMatrixQaHarnessFiles({
        runtimeDir,
        homeserverPort: 28008,
        registrationToken: "secret-token",
        serverName: "matrix-qa.test",
      });

      const compose = await readFile(result.composeFile, "utf8");
      expect(compose).toContain(
        "image: ghcr.io/matrix-construct/tuwunel:v1.8.3@sha256:699fa9971c174e01c884abad8d1a3cfb2fe518e1a71f1fa16ea9dedf11873d74",
      );
      expect(compose).toContain('      - "127.0.0.1:28008:8008"');
      expect(compose).toContain('TUWUNEL_ALLOW_ENCRYPTION: "true"');
      expect(compose).toContain('TUWUNEL_ALLOW_REGISTRATION: "true"');
      expect(compose).toContain('TUWUNEL_REGISTRATION_TOKEN: "secret-token"');
      expect(compose).toContain('TUWUNEL_SERVER_NAME: "matrix-qa.test"');
      expect(result.registrationToken).toBe("secret-token");
    } finally {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  it("keeps registration credentials and Tuwunel data out of publishable artifacts", async () => {
    let runtimeDir: string | undefined;

    await withStartedMatrixHarness(
      {
        async runCommand(_command, args) {
          if (args.join(" ").includes("ps --format json")) {
            return { stdout: '[{"State":"running"}]\n', stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        fetchImpl: vi.fn(async () => ({ ok: true })),
        sleepImpl: vi.fn(async () => {}),
      },
      async ({ outputDir, result }) => {
        runtimeDir = path.dirname(result.composeFile);
        expect(path.relative(outputDir, result.composeFile)).toMatch(/^\.\./);
        expect(path.relative(outputDir, path.join(runtimeDir, "data"))).toMatch(/^\.\./);
        expect(await readdir(outputDir)).toEqual([]);
        await expect(
          access(path.join(outputDir, "docker-compose.matrix-qa.yml")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(path.join(outputDir, "data"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(result.composeFile, "utf8")).toContain(result.registrationToken);
      },
    );

    expect(runtimeDir).toBeDefined();
    await expect(access(runtimeDir as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts the harness, waits for versions, and exposes a stop command", async () => {
    const calls: string[] = [];
    const fetchCalls: string[] = [];

    await withStartedMatrixHarness(
      {
        async runCommand(command, args, cwd) {
          calls.push([command, ...args, `@${cwd}`].join(" "));
          if (args.join(" ").includes("ps --format json")) {
            return { stdout: '[{"State":"running"}]\n', stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        fetchImpl: vi.fn(async (input: string) => {
          fetchCalls.push(input);
          return { ok: true };
        }),
        sleepImpl: vi.fn(async () => {}),
      },
      async ({ result }) => {
        expect(calls).toEqual([
          `docker compose -f ${result.composeFile} down --remove-orphans @/repo/openclaw`,
          `docker compose -f ${result.composeFile} up -d @/repo/openclaw`,
          `docker compose -f ${result.composeFile} ps --format json matrix-qa-homeserver @/repo/openclaw`,
        ]);
        expect(fetchCalls).toEqual([
          "http://127.0.0.1:28008/_matrix/client/versions",
          "http://127.0.0.1:28008/_matrix/client/versions",
        ]);
        expect(result.baseUrl).toBe("http://127.0.0.1:28008/");
        expect(result.stopCommand).toBe(
          `docker compose -f ${result.composeFile} down --remove-orphans`,
        );
        await result.restartService();
        expect(calls).toContain(
          `docker compose -f ${result.composeFile} restart matrix-qa-homeserver @/repo/openclaw`,
        );
      },
    );
  });

  it("bounds the full homeserver restart and readiness phase", async () => {
    vi.useFakeTimers();
    try {
      await withStartedMatrixHarness(
        {
          async runCommand(_command, args) {
            const rendered = args.join(" ");
            if (rendered.includes("restart matrix-qa-homeserver")) {
              return await new Promise<never>(() => {});
            }
            if (rendered.includes("ps --format json")) {
              return { stdout: '[{"State":"running"}]\n', stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async () => ({ ok: true })),
          sleepImpl: vi.fn(async () => {}),
        },
        async ({ result }) => {
          const restarting = result.restartService();
          const rejection = expect(restarting).rejects.toThrow(
            `Matrix homeserver restart timed out after ${MATRIX_QA_CLEANUP_TIMEOUT_MS}ms`,
          );
          await vi.advanceTimersByTimeAsync(MATRIX_QA_CLEANUP_TIMEOUT_MS);
          await rejection;
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets Docker atomically assign an unpinned loopback port", async () => {
    const calls: string[] = [];
    const setTargetBaseUrl = vi.fn();
    let portReadCount = 0;
    await withStartedMatrixHarness(
      {
        async runCommand(command, args, cwd) {
          calls.push([command, ...args, `@${cwd}`].join(" "));
          const rendered = args.join(" ");
          if (rendered.includes("port matrix-qa-homeserver 8008")) {
            portReadCount += 1;
            return { stdout: `127.0.0.1:${portReadCount === 1 ? 49_152 : 49_153}\n`, stderr: "" };
          }
          if (rendered.includes("ps --format json")) {
            return { stdout: '[{"State":"running"}]\n', stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        fetchImpl: vi.fn(async () => ({ ok: true })),
        sleepImpl: vi.fn(async () => {}),
        startRecordingProxyImpl: vi.fn(async ({ targetBaseUrl }) => ({
          baseUrl: targetBaseUrl,
          buildManifest: vi.fn(),
          createExchangeContext: vi.fn(),
          installFaultRule: vi.fn(() => ({ hits: () => [], remove: vi.fn() })),
          onExchange: vi.fn(),
          records: () => [],
          setScenarioId: vi.fn(),
          setTargetBaseUrl,
          stop: vi.fn(async () => {}),
        })),
      },
      async ({ result }) => {
        expect(result.homeserverPort).toBe(49152);
        expect(result.baseUrl).toBe("http://127.0.0.1:49152/");
        expect(calls).toContain(
          `docker compose -f ${result.composeFile} port matrix-qa-homeserver 8008 @/repo/openclaw`,
        );
        const compose = await readFile(result.composeFile, "utf8");
        expect(compose).toContain("      - target: 8008\n        host_ip: 127.0.0.1");
        await result.restartService();
        expect(setTargetBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:49153/");
      },
      { dynamicPort: true },
    );
  });

  it("stops Tuwunel when recorder startup fails", async () => {
    const calls: string[] = [];
    let runtimeDir: string | undefined;
    await withTempDir("matrix-qa-harness-", async (_outputDir) => {
      await expect(
        startMatrixQaHarness(
          { repoRoot: "/repo/openclaw", homeserverPort: 28008 },
          {
            async runCommand(command, args, cwd) {
              calls.push([command, ...args, `@${cwd}`].join(" "));
              if (args.join(" ").includes("ps --format json")) {
                return { stdout: '[{"State":"running"}]\n', stderr: "" };
              }
              return { stdout: "", stderr: "" };
            },
            fetchImpl: vi.fn(async () => ({ ok: true })),
            sleepImpl: vi.fn(async () => {}),
            startRecordingProxyImpl: vi.fn(async () => {
              throw new Error("recorder startup failed");
            }),
            removeRuntimeDirImpl: async (candidateRuntimeDir) => {
              runtimeDir = candidateRuntimeDir;
              await rm(candidateRuntimeDir, { force: true, recursive: true });
            },
          },
        ),
      ).rejects.toThrow("recorder startup failed");
      expect(calls.filter((call) => call.includes("down --remove-orphans"))).toHaveLength(2);
      expect(runtimeDir).toBeDefined();
      await expect(access(runtimeDir as string)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("removes the runtime directory when startup and Docker cleanup both fail", async () => {
    const startupError = new Error("recorder startup failed");
    const dockerError = new Error("docker cleanup failed");
    let downCount = 0;
    let runtimeDir: string | undefined;

    const failure = await startMatrixQaHarness(
      { repoRoot: "/repo/openclaw", homeserverPort: 28008 },
      {
        async runCommand(_command, args) {
          const rendered = args.join(" ");
          if (rendered.includes("down --remove-orphans")) {
            downCount += 1;
            if (downCount === 2) {
              throw dockerError;
            }
          }
          if (rendered.includes("ps --format json")) {
            return { stdout: '[{"State":"running"}]\n', stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        fetchImpl: vi.fn(async () => ({ ok: true })),
        sleepImpl: vi.fn(async () => {}),
        startRecordingProxyImpl: vi.fn(async () => {
          throw startupError;
        }),
        removeRuntimeDirImpl: async (candidateRuntimeDir) => {
          runtimeDir = candidateRuntimeDir;
          await rm(candidateRuntimeDir, { force: true, recursive: true });
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startupError, dockerError]);
    expect(runtimeDir).toBeDefined();
    await expect(access(runtimeDir as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["recorder", "docker", "multiple"] as const)(
    "preserves a single %s cleanup failure after removing the runtime directory",
    async (failureOwner) => {
      const cleanupError = new Error(`${failureOwner} cleanup failed`);
      const removalError = new Error("runtime removal failed");
      let downCount = 0;
      const result = await startMatrixQaHarness(
        { repoRoot: "/repo/openclaw", homeserverPort: 28008 },
        {
          async runCommand(_command, args) {
            const rendered = args.join(" ");
            if (rendered.includes("down --remove-orphans") && ++downCount === 2) {
              if (failureOwner === "docker") {
                throw cleanupError;
              }
            }
            if (rendered.includes("ps --format json")) {
              return { stdout: '[{"State":"running"}]\n', stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async () => ({ ok: true })),
          removeRuntimeDirImpl:
            failureOwner === "multiple"
              ? vi.fn(async () => {
                  throw removalError;
                })
              : undefined,
          sleepImpl: vi.fn(async () => {}),
          startRecordingProxyImpl: vi.fn(async () =>
            createRecordingProxy(async () => {
              if (failureOwner !== "docker") {
                throw cleanupError;
              }
            }),
          ),
        },
      );
      const runtimeDir = path.dirname(result.composeFile);

      const failure = await result.stop().catch((error: unknown) => error);
      if (failureOwner === "multiple") {
        expect(failure).toMatchObject({
          cause: cleanupError,
          errors: [cleanupError, removalError],
          message: "Matrix QA harness cleanup failed",
        });
        await rm(runtimeDir, { force: true, recursive: true });
      } else {
        expect(failure).toBe(cleanupError);
        await expect(access(runtimeDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each(["normal stop", "startup rollback"] as const)(
    "waits for Docker settlement before runtime removal during %s",
    async (phase) => {
      let downCount = 0;
      const order: string[] = [];
      let settleDocker: (() => void) | undefined;
      const dockerSettled = new Promise<void>((resolve) => {
        settleDocker = resolve;
      });
      const removeRuntimeDirImpl = vi.fn(async () => {
        order.push("removal");
      });
      const startupError = new Error("recorder startup failed");
      const starting = startMatrixQaHarness(
        { repoRoot: "/repo/openclaw", homeserverPort: 28008 },
        {
          async runCommand(_command, args) {
            const rendered = args.join(" ");
            if (rendered.includes("down --remove-orphans") && ++downCount === 2) {
              order.push("docker");
              await dockerSettled;
            }
            if (rendered.includes("ps --format json")) {
              return { stdout: '[{"State":"running"}]\n', stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async () => ({ ok: true })),
          removeRuntimeDirImpl,
          sleepImpl: vi.fn(async () => {}),
          startRecordingProxyImpl: vi.fn(async () => {
            if (phase === "startup rollback") {
              throw startupError;
            }
            return createRecordingProxy(async () => {
              order.push("recorder");
            });
          }),
        },
      );

      const operation =
        phase === "normal stop"
          ? (await starting).stop()
          : starting.catch((error: unknown) => error);
      await vi.waitFor(() => expect(downCount).toBe(2));
      expect(removeRuntimeDirImpl).not.toHaveBeenCalled();
      settleDocker?.();
      const outcome = await operation;
      if (phase === "startup rollback") {
        expect(outcome).toBe(startupError);
      }
      expect(removeRuntimeDirImpl).toHaveBeenCalledOnce();
      expect(order).toEqual(
        phase === "normal stop" ? ["recorder", "docker", "removal"] : ["docker", "removal"],
      );
    },
  );

  it("stops Tuwunel when post-start health setup fails", async () => {
    const calls: string[] = [];
    await withTempDir("matrix-qa-harness-", async (_outputDir) => {
      await expect(
        startMatrixQaHarness(
          { repoRoot: "/repo/openclaw", homeserverPort: 28008 },
          {
            async runCommand(command, args, cwd) {
              calls.push([command, ...args, `@${cwd}`].join(" "));
              return { stdout: "", stderr: "" };
            },
            sleepImpl: vi.fn(async () => {
              throw new Error("health setup failed");
            }),
          },
        ),
      ).rejects.toThrow("health setup failed");
      expect(calls.filter((call) => call.includes("down --remove-orphans"))).toHaveLength(2);
    });
  });

  it("treats empty Docker health fields as a fallback to running state", async () => {
    await withStartedMatrixHarness(
      {
        async runCommand(_command, args) {
          if (args.join(" ").includes("ps --format json")) {
            return { stdout: '{"Health":"","State":"running"}\n', stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        fetchImpl: vi.fn(async () => ({ ok: true })),
        sleepImpl: vi.fn(async () => {}),
      },
      ({ result }) => {
        expect(result.baseUrl).toBe("http://127.0.0.1:28008/");
      },
    );
  });

  it("cancels Matrix versions probe response bodies", async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({ ok: true, body: { cancel } }));

    await expect(
      testing.isMatrixVersionsReachable("http://127.0.0.1:28008/", fetchImpl),
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:28008/_matrix/client/versions", {
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled versions probe by the remaining discovery deadline", async () => {
    vi.useFakeTimers();
    const requestTimeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(requestTimeout.signal);
    try {
      const { fetchImpl, probeSignals } = createStalledVersionsFetch();
      const sleepImpl = vi.fn(async () => {});
      const startedAt = Date.now();
      const waiting = testing.waitForReachableMatrixBaseUrl({
        composeFile: "/tmp/docker-compose.matrix-qa.yml",
        containerBaseUrl: null,
        fetchImpl,
        hostBaseUrl: "http://127.0.0.1:28008/",
        sleepImpl,
        timeoutMs: 25,
        pollMs: 1_000,
      });
      const rejection = expect(waiting).rejects.toThrow("did not become healthy");

      await vi.advanceTimersByTimeAsync(25);
      await rejection;

      expect(Date.now() - startedAt).toBe(25);
      expect(probeSignals).toHaveLength(1);
      expect(probeSignals[0]?.aborted).toBe(true);
      expect(sleepImpl).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not re-poll when the request timeout wins at the discovery deadline", async () => {
    vi.useFakeTimers();
    const requestTimeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(requestTimeout.signal);
    try {
      const { fetchImpl } = createStalledVersionsFetch();
      const startedAt = Date.now();
      const sleepImpl = vi.fn(async (ms: number) => {
        vi.setSystemTime(Date.now() + ms);
      });
      const waiting = testing.waitForReachableMatrixBaseUrl({
        composeFile: "/tmp/docker-compose.matrix-qa.yml",
        containerBaseUrl: null,
        fetchImpl,
        hostBaseUrl: "http://127.0.0.1:28008/",
        sleepImpl,
        timeoutMs: 25,
        pollMs: 1_000,
      });

      vi.setSystemTime(startedAt + 24);
      requestTimeout.abort(new DOMException("request timed out", "TimeoutError"));
      await expect(waiting).rejects.toThrow("did not become healthy");

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleepImpl).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("probes the container fallback when the host versions probe stalls", async () => {
    let hostProbeSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (input: string, init?: Pick<RequestInit, "signal">) => {
      if (input.startsWith("http://172.18.0.10:8008/")) {
        return { ok: true };
      }
      return await new Promise<never>((_resolve, reject) => {
        hostProbeSignal = init?.signal ?? undefined;
        if (!hostProbeSignal) {
          reject(new Error("versions probe signal missing"));
          return;
        }
        const rejectAborted = () => reject(new Error("versions probe aborted"));
        if (hostProbeSignal.aborted) {
          rejectAborted();
          return;
        }
        hostProbeSignal.addEventListener("abort", rejectAborted, { once: true });
      });
    });

    await expect(
      testing.waitForReachableMatrixBaseUrl({
        composeFile: "/tmp/docker-compose.matrix-qa.yml",
        containerBaseUrl: "http://172.18.0.10:8008/",
        fetchImpl,
        hostBaseUrl: "http://127.0.0.1:28008/",
        sleepImpl: vi.fn(async () => {}),
        timeoutMs: 25,
      }),
    ).resolves.toBe("http://172.18.0.10:8008/");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(hostProbeSignal?.aborted).toBe(true);
  });

  it("returns the host without waiting for a stalled container versions probe", async () => {
    let containerProbeSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (input: string, init?: Pick<RequestInit, "signal">) => {
      if (input.startsWith("http://127.0.0.1:28008/")) {
        return { ok: true };
      }
      return await new Promise<never>((_resolve, reject) => {
        containerProbeSignal = init?.signal ?? undefined;
        if (!containerProbeSignal) {
          reject(new Error("versions probe signal missing"));
          return;
        }
        const rejectAborted = () => reject(new Error("versions probe aborted"));
        if (containerProbeSignal.aborted) {
          rejectAborted();
          return;
        }
        containerProbeSignal.addEventListener("abort", rejectAborted, { once: true });
      });
    });

    await expect(
      testing.waitForReachableMatrixBaseUrl({
        composeFile: "/tmp/docker-compose.matrix-qa.yml",
        containerBaseUrl: "http://172.18.0.10:8008/",
        fetchImpl,
        hostBaseUrl: "http://127.0.0.1:28008/",
        sleepImpl: vi.fn(async () => {}),
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("http://127.0.0.1:28008/");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(containerProbeSignal?.aborted).toBe(true);
  });

  it("falls back to the container IP when the host port is unreachable", async () => {
    const calls: string[] = [];

    await withStartedMatrixHarness(
      {
        runCommand: createContainerNetworkRunCommand(calls),
        fetchImpl: vi.fn(async (input: string) => ({
          ok: input.startsWith("http://172.18.0.10:8008/"),
        })),
        sleepImpl: vi.fn(async () => {}),
      },
      ({ result }) => {
        expect(result.baseUrl).toBe("http://172.18.0.10:8008/");
        expect(calls).toContain(
          `docker compose -f ${result.composeFile} ps -q matrix-qa-homeserver @/repo/openclaw`,
        );
        expect(calls).toContain(
          "docker inspect --format {{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}} container-123 @/repo/openclaw",
        );
      },
    );
  });

  it("keeps the host URL when the container IP is also unreachable", async () => {
    const fetchCalls: string[] = [];

    await withStartedMatrixHarness(
      {
        runCommand: createContainerNetworkRunCommand(),
        fetchImpl: vi.fn(async (input: string) => {
          fetchCalls.push(input);
          return {
            ok:
              input === "http://127.0.0.1:28008/_matrix/client/versions" &&
              countMatching(fetchCalls, (url) => url === input) > 1,
          };
        }),
        sleepImpl: vi.fn(async () => {}),
      },
      ({ result }) => {
        expect(result.baseUrl).toBe("http://127.0.0.1:28008/");
        expect(fetchCalls).toEqual([
          "http://127.0.0.1:28008/_matrix/client/versions",
          "http://127.0.0.1:28008/_matrix/client/versions",
          "http://172.18.0.10:8008/_matrix/client/versions",
          "http://127.0.0.1:28008/_matrix/client/versions",
        ]);
      },
    );
  });

  it("keeps probing the container URL until it becomes reachable", async () => {
    const fetchCalls: string[] = [];

    await withStartedMatrixHarness(
      {
        runCommand: createContainerNetworkRunCommand(),
        fetchImpl: vi.fn(async (input: string) => {
          fetchCalls.push(input);
          return {
            ok:
              input === "http://172.18.0.10:8008/_matrix/client/versions" &&
              countMatching(fetchCalls, (url) => url === input) > 1,
          };
        }),
        sleepImpl: vi.fn(async () => {}),
      },
      ({ result }) => {
        expect(result.baseUrl).toBe("http://172.18.0.10:8008/");
        expect(fetchCalls).toEqual([
          "http://127.0.0.1:28008/_matrix/client/versions",
          "http://127.0.0.1:28008/_matrix/client/versions",
          "http://172.18.0.10:8008/_matrix/client/versions",
          "http://127.0.0.1:28008/_matrix/client/versions",
          "http://172.18.0.10:8008/_matrix/client/versions",
          "http://172.18.0.10:8008/_matrix/client/versions",
        ]);
      },
    );
  });
});
