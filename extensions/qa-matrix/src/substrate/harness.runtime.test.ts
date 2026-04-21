import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { __testing, startMatrixQaHarness, writeMatrixQaHarnessFiles } from "./harness.runtime.js";

type MatrixQaHarnessDeps = Parameters<typeof startMatrixQaHarness>[1];
type MatrixQaHarnessResult = Awaited<ReturnType<typeof startMatrixQaHarness>>;

async function withStartedMatrixHarness(
  deps: MatrixQaHarnessDeps,
  verify: (params: { outputDir: string; result: MatrixQaHarnessResult }) => Promise<void> | void,
) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-harness-"));

  try {
    const result = await startMatrixQaHarness(
      {
        outputDir,
        repoRoot: "/repo/openclaw",
        homeserverPort: 28008,
      },
      deps,
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

describe("matrix harness runtime", () => {
  it("writes a pinned Tuwunel compose file and redacted manifest", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-harness-"));

    try {
      const result = await writeMatrixQaHarnessFiles({
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

      expect(compose).toContain(`image: ${__testing.MATRIX_QA_DEFAULT_IMAGE}`);
      expect(compose).toContain('      - "127.0.0.1:28008:8008"');
      expect(compose).toContain('TUWUNEL_ALLOW_ENCRYPTION: "true"');
      expect(compose).toContain('TUWUNEL_ALLOW_REGISTRATION: "true"');
      expect(compose).toContain('TUWUNEL_REGISTRATION_TOKEN: "secret-token"');
      expect(compose).toContain('TUWUNEL_SERVER_NAME: "matrix-qa.test"');
      expect(manifest).toEqual({
        image: __testing.MATRIX_QA_DEFAULT_IMAGE,
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
          "docker inspect --format {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}} container-123 @/repo/openclaw",
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
              fetchCalls.filter((url) => url === input).length > 1,
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
              fetchCalls.filter((url) => url === input).length > 1,
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
