import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runQaDockerUp } from "./docker-up.runtime.js";

type QaDockerUpDeps = NonNullable<Parameters<typeof runQaDockerUp>[1]>;

async function occupyPortOrAcceptExisting(port: number): Promise<{ close: () => Promise<void> }> {
  const server = createServer();
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => resolve(true));
  });

  return {
    close: async () => {
      if (!listening) {
        return;
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function createHealthyDockerDeps(calls: string[]): QaDockerUpDeps {
  return {
    async runCommand(command, args, cwd) {
      calls.push([command, ...args, `@${cwd}`].join(" "));
      if (args.join(" ").includes("ps --format json openclaw-qa-gateway")) {
        return { stdout: '{"Health":"healthy","State":"running"}\n', stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    fetchImpl: vi.fn(async () => ({ ok: true })),
    sleepImpl: vi.fn(async () => {}),
  };
}

describe("runQaDockerUp", () => {
  it("builds the QA UI, writes the harness, starts compose, and waits for health", async () => {
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const responseQueue = [false, true, true];
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-docker-up-"));

    try {
      const result = await runQaDockerUp(
        {
          repoRoot: "/repo/openclaw",
          outputDir,
          gatewayPort: 18889,
          qaLabPort: 43124,
        },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            if (args.join(" ").includes("ps --format json openclaw-qa-gateway")) {
              return { stdout: '[{"Health":"healthy","State":"running"}]\n', stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async (input: string) => {
            fetchCalls.push(input);
            return { ok: responseQueue.shift() ?? true };
          }),
          sleepImpl: vi.fn(async () => {}),
        },
      );

      expect(calls).toEqual([
        "pnpm qa:lab:build @/repo/openclaw",
        `docker compose -f ${outputDir}/docker-compose.qa.yml down --remove-orphans @/repo/openclaw`,
        expect.stringContaining(
          `docker compose -f ${outputDir}/docker-compose.qa.yml up --build -d @/repo/openclaw`,
        ),
        `docker compose -f ${outputDir}/docker-compose.qa.yml ps --format json openclaw-qa-gateway @/repo/openclaw`,
      ]);
      expect(fetchCalls).toEqual([
        "http://127.0.0.1:43124/healthz",
        "http://127.0.0.1:43124/healthz",
        "http://127.0.0.1:18889/healthz",
      ]);
      expect(result.qaLabUrl).toBe("http://127.0.0.1:43124");
      expect(result.gatewayUrl).toBe("http://127.0.0.1:18889/");
      expect(result.composeFile).toBe(`${outputDir}/docker-compose.qa.yml`);
      expect(result.stopCommand).toBe(`docker compose -f ${outputDir}/docker-compose.qa.yml down`);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("skips UI build and compose --build for prebuilt images", async () => {
    const calls: string[] = [];
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-docker-up-"));

    try {
      await runQaDockerUp(
        {
          repoRoot: "/repo/openclaw",
          outputDir,
          usePrebuiltImage: true,
          bindUiDist: true,
          skipUiBuild: true,
        },
        createHealthyDockerDeps(calls),
      );

      expect(calls).toEqual([
        `docker compose -f ${outputDir}/docker-compose.qa.yml down --remove-orphans @/repo/openclaw`,
        `docker compose -f ${outputDir}/docker-compose.qa.yml up -d @/repo/openclaw`,
        `docker compose -f ${outputDir}/docker-compose.qa.yml ps --format json openclaw-qa-gateway @/repo/openclaw`,
      ]);
      const compose = await readFile(path.join(outputDir, "docker-compose.qa.yml"), "utf8");
      expect(compose).toContain(":/opt/openclaw-qa-lab-ui:ro");
      expect(compose).toContain("      - --ui-dist-dir");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses a repo-root-relative default output dir when none is provided", async () => {
    const calls: string[] = [];
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-docker-root-"));

    try {
      const result = await runQaDockerUp(
        {
          repoRoot,
          usePrebuiltImage: true,
          skipUiBuild: true,
        },
        createHealthyDockerDeps(calls),
      );

      expect(result.outputDir).toBe(path.join(repoRoot, ".artifacts/qa-docker"));
      expect(result.composeFile).toBe(
        path.join(repoRoot, ".artifacts/qa-docker/docker-compose.qa.yml"),
      );
      expect(calls).toEqual([
        `docker compose -f ${path.join(repoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} down --remove-orphans @${repoRoot}`,
        `docker compose -f ${path.join(repoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} up -d @${repoRoot}`,
        `docker compose -f ${path.join(repoRoot, ".artifacts/qa-docker/docker-compose.qa.yml")} ps --format json openclaw-qa-gateway @${repoRoot}`,
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("falls back to free host ports when defaults are already occupied", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-docker-up-"));
    const gatewayPort = 18789;
    const qaLabPort = 43124;
    const resolveHostPort = vi.fn(async (preferredPort: number) => {
      if (preferredPort === gatewayPort) {
        return 28001;
      }
      if (preferredPort === qaLabPort) {
        return 28002;
      }
      return preferredPort;
    });
    const gatewayPortReservation = await occupyPortOrAcceptExisting(18789);
    const qaLabPortReservation = await occupyPortOrAcceptExisting(43124);

    try {
      const result = await runQaDockerUp(
        {
          repoRoot: "/repo/openclaw",
          outputDir,
          gatewayPort,
          qaLabPort,
          skipUiBuild: true,
          usePrebuiltImage: true,
        },
        {
          async runCommand() {
            return {
              stdout: '{"Health":"healthy","State":"running"}\n',
              stderr: "",
            };
          },
          fetchImpl: vi.fn(async () => ({ ok: true })),
          sleepImpl: vi.fn(async () => {}),
          resolveHostPortImpl: resolveHostPort,
        },
      );

      expect(result.gatewayUrl).not.toBe(`http://127.0.0.1:${gatewayPort}/`);
      expect(result.qaLabUrl).not.toBe(`http://127.0.0.1:${qaLabPort}`);
      expect(result.gatewayUrl).toBe("http://127.0.0.1:28001/");
      expect(result.qaLabUrl).toBe("http://127.0.0.1:28002");
    } finally {
      await gatewayPortReservation.close();
      await qaLabPortReservation.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("falls back to the container IP when the host gateway port is unreachable", async () => {
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-docker-up-"));

    try {
      const result = await runQaDockerUp(
        {
          repoRoot: "/repo/openclaw",
          outputDir,
          gatewayPort: 18889,
          qaLabPort: 43124,
          skipUiBuild: true,
          usePrebuiltImage: true,
        },
        {
          async runCommand(command, args, cwd) {
            calls.push([command, ...args, `@${cwd}`].join(" "));
            const joined = args.join(" ");
            if (joined.includes("ps --format json openclaw-qa-gateway")) {
              return { stdout: '{"Health":"healthy","State":"running"}\n', stderr: "" };
            }
            if (joined.includes("ps -q openclaw-qa-gateway")) {
              return { stdout: "gateway-container\n", stderr: "" };
            }
            if (command === "docker" && args[0] === "inspect") {
              return { stdout: "192.168.165.4\n", stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
          fetchImpl: vi.fn(async (input: string) => {
            fetchCalls.push(input);
            return {
              ok:
                input === "http://127.0.0.1:43124/healthz" ||
                input === "http://192.168.165.4:18789/healthz",
            };
          }),
          sleepImpl: vi.fn(async () => {}),
        },
      );

      expect(calls).toEqual([
        `docker compose -f ${outputDir}/docker-compose.qa.yml down --remove-orphans @/repo/openclaw`,
        `docker compose -f ${outputDir}/docker-compose.qa.yml up -d @/repo/openclaw`,
        `docker compose -f ${outputDir}/docker-compose.qa.yml ps --format json openclaw-qa-gateway @/repo/openclaw`,
        `docker compose -f ${outputDir}/docker-compose.qa.yml ps -q openclaw-qa-gateway @/repo/openclaw`,
        "docker inspect --format {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}} gateway-container @/repo/openclaw",
      ]);
      expect(fetchCalls).toEqual([
        "http://127.0.0.1:43124/healthz",
        "http://127.0.0.1:18889/healthz",
        "http://192.168.165.4:18789/healthz",
      ]);
      expect(result.gatewayUrl).toBe("http://192.168.165.4:18789/");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
