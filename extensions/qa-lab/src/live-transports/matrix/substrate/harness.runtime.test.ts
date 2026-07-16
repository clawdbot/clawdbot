// Qa Lab Matrix tests cover harness behavior.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  MATRIX_QA_CLEANUP_TIMEOUT_MS,
  MATRIX_QA_DEFAULT_PORT,
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
  MATRIX_QA_DEFAULT_PORT,
  MATRIX_QA_SERVICE,
  buildVersionsUrl,
  isMatrixVersionsReachable,
  waitForReachableMatrixBaseUrl,
  writeMatrixQaHarnessFiles,
};

type MatrixQaHarnessDeps = Parameters<typeof startMatrixQaHarness>[1];
type MatrixQaHarnessResult = Awaited<ReturnType<typeof startMatrixQaHarness>>;

async function withStartedMatrixHarness(
  deps: MatrixQaHarnessDeps,
  verify: (params: { outputDir: string; result: MatrixQaHarnessResult }) => Promise<void> | void,
) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-harness-"));

  try {
    const startRecordingProxyImpl =
      deps?.startRecordingProxyImpl ??
      (async ({ targetBaseUrl }: { targetBaseUrl: string }) =>
        ({
          baseUrl: targetBaseUrl,
          buildManifest: vi.fn(),
          records: () => [],
          setScenarioId: vi.fn(),
          stop: vi.fn(async () => {}),
        }) as unknown as MatrixQaRecordingProxy);
    const result = await startMatrixQaHarness(
      {
        outputDir,
        repoRoot: "/repo/openclaw",
        homeserverPort: 28008,
      },
      { ...deps, startRecordingProxyImpl },
    );
    await verify({ outputDir, result });
  } finally {
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

describe("matrix harness runtime", () => {
  it("writes a pinned Tuwunel compose file and redacted manifest", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-harness-"));

    try {
      const result = await testing.writeMatrixQaHarnessFiles({
        outputDir,
        homeserverPort: 28008,
        registrationToken: "secret-token",
        serverName: "matrix-qa.test",
      });

      const compose = await readFile(result.composeFile, "utf8");
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
        image: string;
        serverName: string;
        homeserverPort: number;
        composeFile: string;
      };

      expect(compose).toContain("image: ghcr.io/matrix-construct/tuwunel:v1.5.1");
      expect(compose).toContain('      - "127.0.0.1:28008:8008"');
      expect(compose).toContain('TUWUNEL_ALLOW_ENCRYPTION: "true"');
      expect(compose).toContain('TUWUNEL_ALLOW_REGISTRATION: "true"');
      expect(compose).toContain('TUWUNEL_REGISTRATION_TOKEN: "secret-token"');
      expect(compose).toContain('TUWUNEL_SERVER_NAME: "matrix-qa.test"');
      expect(manifest).toEqual({
        image: "ghcr.io/matrix-construct/tuwunel:v1.5.1",
        serverName: "matrix-qa.test",
        homeserverPort: 28008,
        composeFile: path.join(outputDir, "docker-compose.matrix-qa.yml"),
        dataDir: path.join(outputDir, "data"),
      });
      expect(result.registrationToken).toBe("secret-token");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
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
        resolveHostPortImpl: vi.fn(async (port: number) => port),
      },
      async ({ outputDir, result }) => {
        expect(calls).toEqual([
          `docker compose -f ${outputDir}/docker-compose.matrix-qa.yml down --remove-orphans @/repo/openclaw`,
          `docker compose -f ${outputDir}/docker-compose.matrix-qa.yml up -d @/repo/openclaw`,
          `docker compose -f ${outputDir}/docker-compose.matrix-qa.yml ps --format json matrix-qa-homeserver @/repo/openclaw`,
        ]);
        expect(fetchCalls).toEqual([
          "http://127.0.0.1:28008/_matrix/client/versions",
          "http://127.0.0.1:28008/_matrix/client/versions",
        ]);
        expect(result.baseUrl).toBe("http://127.0.0.1:28008/");
        expect(result.stopCommand).toBe(
          `docker compose -f ${outputDir}/docker-compose.matrix-qa.yml down --remove-orphans`,
        );
        await result.restartService();
        expect(calls).toContain(
          `docker compose -f ${outputDir}/docker-compose.matrix-qa.yml restart matrix-qa-homeserver @/repo/openclaw`,
        );
      },
    );
  });

  it("stops Tuwunel when recorder startup fails", async () => {
    const calls: string[] = [];
    await withTempDir("matrix-qa-harness-", async (outputDir) => {
      await expect(
        startMatrixQaHarness(
          { outputDir, repoRoot: "/repo/openclaw" },
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
            resolveHostPortImpl: vi.fn(async (port: number) => port),
            startRecordingProxyImpl: vi.fn(async () => {
              throw new Error("recorder startup failed");
            }),
          },
        ),
      ).rejects.toThrow("recorder startup failed");
      expect(calls.filter((call) => call.includes("down --remove-orphans"))).toHaveLength(2);
    });
  });

  it("stops Tuwunel when post-start health setup fails", async () => {
    const calls: string[] = [];
    await withTempDir("matrix-qa-harness-", async (outputDir) => {
      await expect(
        startMatrixQaHarness(
          { outputDir, repoRoot: "/repo/openclaw" },
          {
            async runCommand(command, args, cwd) {
              calls.push([command, ...args, `@${cwd}`].join(" "));
              return { stdout: "", stderr: "" };
            },
            sleepImpl: vi.fn(async () => {
              throw new Error("health setup failed");
            }),
            resolveHostPortImpl: vi.fn(async (port: number) => port),
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
        resolveHostPortImpl: vi.fn(async (port: number) => port),
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
    let probeSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_input: string, init?: Pick<RequestInit, "signal">) =>
        await new Promise<never>((_resolve, reject) => {
          probeSignal = init?.signal ?? undefined;
          if (!probeSignal) {
            reject(new Error("versions probe signal missing"));
            return;
          }
          const rejectAborted = () => reject(new Error("versions probe aborted"));
          if (probeSignal.aborted) {
            rejectAborted();
            return;
          }
          probeSignal.addEventListener("abort", rejectAborted, { once: true });
        }),
    );
    const sleepImpl = vi.fn(async () => {});
    const startedAt = Date.now();

    await expect(
      testing.waitForReachableMatrixBaseUrl({
        composeFile: "/tmp/docker-compose.matrix-qa.yml",
        containerBaseUrl: null,
        fetchImpl,
        hostBaseUrl: "http://127.0.0.1:28008/",
        sleepImpl,
        timeoutMs: 25,
        pollMs: 1_000,
      }),
    ).rejects.toThrow("did not become healthy");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(probeSignal?.aborted).toBe(true);
    expect(sleepImpl).not.toHaveBeenCalled();
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
        resolveHostPortImpl: vi.fn(async (port: number) => port),
      },
      ({ outputDir, result }) => {
        expect(result.baseUrl).toBe("http://172.18.0.10:8008/");
        expect(calls).toContain(
          `docker compose -f ${outputDir}/docker-compose.matrix-qa.yml ps -q matrix-qa-homeserver @/repo/openclaw`,
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
        resolveHostPortImpl: vi.fn(async (port: number) => port),
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
        resolveHostPortImpl: vi.fn(async (port: number) => port),
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
