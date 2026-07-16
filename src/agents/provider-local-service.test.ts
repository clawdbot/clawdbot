// Verifies managed local provider services start, lease, probe, and stop safely.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { killPidIfAlive, readPidFile, waitForPidToExit } from "../test-utils/process-tree.js";
import {
  attachModelProviderLocalService,
  createConfiguredProviderLocalServiceAcquirer,
  ensureModelProviderLocalService,
  ensureProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
  getModelProviderLocalService,
  hasLocalServiceProcessExited,
  stopManagedProviderLocalServicesForTest,
} from "./provider-local-service.js";

async function freePort(): Promise<number> {
  // Allocate a real loopback port to exercise child process health probes.
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("missing test port"));
        }
      });
    });
  });
}

async function waitForProbeFailure(url: string): Promise<void> {
  // Idle-stop assertions wait until the local service no longer responds.
  try {
    await expect
      .poll(
        async () => {
          try {
            await fetch(url);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 2_000, interval: 50 },
      )
      .toBe(true);
  } catch {
    throw new Error("local service still responded after idle stop");
  }
}

describe("provider local service", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    stopManagedProviderLocalServicesForTest();
  });

  it("attaches local service metadata to model objects", () => {
    const model = attachModelProviderLocalService(
      { id: "demo", provider: "local", baseUrl: "http://127.0.0.1:1/v1" },
      { command: process.execPath, args: ["--version"] },
    );

    expect(getModelProviderLocalService(model)).toEqual({
      command: process.execPath,
      args: ["--version"],
    });
  });

  it("treats signaled local service children as exited", () => {
    expect(hasLocalServiceProcessExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(hasLocalServiceProcessExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasLocalServiceProcessExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it("starts an on-demand local service and stops it after idle", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-demo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: [
          "-e",
          `const http=require("http");http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');}).listen(${port},"127.0.0.1");`,
        ],
        healthUrl,
        readyTimeoutMs: 5_000,
        idleStopMs: 1,
      },
    );

    const lease = await ensureModelProviderLocalService(model);

    if (!lease) {
      throw new Error("Expected provider local service lease");
    }
    expect((await fetch(healthUrl)).ok).toBe(true);
    lease.release();
    await waitForProbeFailure(healthUrl);
  });

  it("resolves process configuration from the host config", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const acquire = createConfiguredProviderLocalServiceAcquirer(
      () =>
        ({
          models: {
            providers: {
              "gpu-spark": {
                baseUrl: "",
                baseURL: `127.0.0.1:${port}/v1`,
                models: [],
                localService: {
                  command: process.execPath,
                  args: [
                    "-e",
                    `const http=require("http");http.createServer((req,res)=>{res.writeHead(200);res.end("ok");}).listen(${port},"127.0.0.1");`,
                  ],
                  healthUrl,
                  readyTimeoutMs: 5_000,
                  idleStopMs: 1,
                },
              },
            },
          },
        }) as OpenClawConfig,
    );

    const lease = await acquire({
      providerId: "gpu-spark",
      baseUrl: `http://127.0.0.1:${port}`,
      service: { command: "caller-controlled" },
    } as Parameters<typeof acquire>[0]);

    expect(lease).toBeDefined();
    expect((await fetch(healthUrl)).ok).toBe(true);
    lease?.release();
    await waitForProbeFailure(healthUrl);
  });

  it("allows a default loopback endpoint when provider baseUrl is empty", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const acquire = createConfiguredProviderLocalServiceAcquirer(() => ({
      models: {
        providers: {
          "gpu-default": {
            baseUrl: "",
            models: [],
            localService: {
              command: process.execPath,
              args: [
                "-e",
                `const http=require("http");http.createServer((req,res)=>{res.writeHead(200);res.end("ok");}).listen(${port},"127.0.0.1");`,
              ],
              healthUrl,
              readyTimeoutMs: 5_000,
              idleStopMs: 1,
            },
          },
        },
      },
    }));

    const lease = await acquire({
      providerId: "gpu-default",
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    expect(lease).toBeDefined();
    lease?.release();
    await waitForProbeFailure(healthUrl);
  });

  it("rejects plugin-selected local service probe hosts", async () => {
    const acquire = createConfiguredProviderLocalServiceAcquirer(() => ({
      models: {
        providers: {
          "gpu-spark": {
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [],
            localService: {
              command: process.execPath,
              args: ["--version"],
            },
          },
        },
      },
    }));

    await expect(
      acquire({
        providerId: "gpu-spark",
        baseUrl: "http://169.254.169.254/latest/meta-data",
      }),
    ).rejects.toThrow("must match models.providers.gpu-spark.baseUrl");
  });

  it("rejects a remote endpoint when provider baseUrl is empty", async () => {
    const acquire = createConfiguredProviderLocalServiceAcquirer(() => ({
      models: {
        providers: {
          "gpu-default": {
            baseUrl: "",
            models: [],
            localService: {
              command: process.execPath,
              args: ["--version"],
            },
          },
        },
      },
    }));

    await expect(
      acquire({
        providerId: "gpu-default",
        baseUrl: "http://memory.example/v1",
      }),
    ).rejects.toThrow("must match models.providers.gpu-default.baseUrl");
  });

  it("caps oversized local service idle stop timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-huge-idle",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: [
          "-e",
          `const http=require("http");const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`,
        ],
        healthUrl,
        readyTimeoutMs: 5_000,
        idleStopMs: Number.MAX_SAFE_INTEGER,
      },
    );

    try {
      const lease = await ensureModelProviderLocalService(model);

      if (!lease) {
        throw new Error("Expected provider local service lease");
      }
      lease.release();

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("sends provider request headers on local service health probes", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-auth",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: [
          "-e",
          `const http=require("http");http.createServer((req,res)=>{if(req.headers.authorization!=="Bearer health-secret"||req.headers["x-tenant"]!=="acme"){res.writeHead(401);res.end("unauthorized");return;}res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');}).listen(${port},"127.0.0.1");`,
        ],
        readyTimeoutMs: 5_000,
        idleStopMs: 1,
      },
    );

    const sentinel = mintSecretSentinel("health-secret", { label: "local-health-probe" });
    const lease = await ensureModelProviderLocalService(model, {
      Authorization: `Bearer ${sentinel}`,
      "X-Tenant": "acme",
    });

    if (!lease) {
      throw new Error("Expected provider local service lease");
    }
    expect((await fetch(healthUrl)).status).toBe(401);
    expect(
      (
        await fetch(healthUrl, {
          headers: { Authorization: "Bearer health-secret", "X-Tenant": "acme" },
        })
      ).ok,
    ).toBe(true);
    lease?.release();
    await waitForProbeFailure(healthUrl);
  });

  it("rejects unknown sentinels before starting a local service", async () => {
    const port = await freePort();
    const unknown = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-unknown-auth",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: ["--version"],
        readyTimeoutMs: 1_000,
      },
    );

    await expect(
      ensureModelProviderLocalService(model, { Authorization: `Bearer ${unknown}` }),
    ).rejects.toThrow(
      `Secret sentinel ${unknown} is not registered in this process; refusing to probe local model provider health`,
    );
  });

  it("cancels local service health probe response bodies", async () => {
    let socketClosed = false;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        sockets.delete(socket);
        socketClosed = true;
      });
      socket.write(
        ["HTTP/1.1 200 OK", "Content-Type: application/json", "", '{"ok":true}'].join("\r\n"),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test server port");
    }
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-body-cleanup",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: ["--version"],
        healthUrl: `http://127.0.0.1:${address.port}/v1/models`,
        readyTimeoutMs: 1_000,
        idleStopMs: 1,
      },
    );

    try {
      await expect(ensureModelProviderLocalService(model)).resolves.toBeUndefined();
      await expect.poll(() => socketClosed, { timeout: 1000, interval: 20 }).toBe(true);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("serializes concurrent chat and embedding starts with independent leases", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-service-"));
    const startsPath = path.join(tempDir, "starts.txt");
    const service = {
      command: process.execPath,
      args: [
        "-e",
        `const fs=require("node:fs");const http=require("node:http");fs.appendFileSync(${JSON.stringify(
          startsPath,
        )},"start\\n");setTimeout(()=>{const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));},100);`,
      ],
      healthUrl,
      readyTimeoutMs: 5_000,
      idleStopMs: 1,
    };
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-concurrent",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      service,
    );

    try {
      const [chatLease, embeddingLease] = await Promise.all([
        ensureModelProviderLocalService(model),
        ensureProviderLocalService({
          providerId: "local-concurrent",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          service,
        }),
      ]);

      expect(chatLease).toBeDefined();
      expect(embeddingLease).toBeDefined();
      expect((await fetch(healthUrl)).ok).toBe(true);
      embeddingLease?.release();
      expect((await fetch(healthUrl)).ok).toBe(true);
      chatLease?.release();
      await waitForProbeFailure(healthUrl);
      const starts = (await fs.readFile(startsPath, "utf8")).trim().split("\n");
      expect(starts).toHaveLength(1);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps configured provider aliases on different local endpoints independent", async () => {
    const firstPort = await freePort();
    const secondPort = await freePort();
    const firstHealthUrl = `http://127.0.0.1:${firstPort}/v1/models`;
    const secondHealthUrl = `http://127.0.0.1:${secondPort}/v1/models`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-service-key-"));
    const startsPath = path.join(tempDir, "starts.txt");
    const args = [
      "-e",
      `const fs=require("node:fs");const http=require("node:http");fs.appendFileSync(process.env.STARTS_PATH,process.env.LOCAL_SERVICE_PORT+"\\n");const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(Number(process.env.LOCAL_SERVICE_PORT),"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`,
    ];
    const firstService = {
      command: process.execPath,
      args,
      env: { LOCAL_SERVICE_PORT: String(firstPort), STARTS_PATH: startsPath },
      readyTimeoutMs: 5_000,
      idleStopMs: 1,
    };
    const secondService = {
      command: process.execPath,
      args,
      env: { LOCAL_SERVICE_PORT: String(secondPort), STARTS_PATH: startsPath },
      readyTimeoutMs: 5_000,
      idleStopMs: 1,
    };

    try {
      const leases = await Promise.all([
        ensureProviderLocalService({
          providerId: "ollama-spark",
          baseUrl: `http://127.0.0.1:${firstPort}/v1`,
          service: firstService,
        }),
        ensureProviderLocalService({
          providerId: "ollama-studio",
          baseUrl: `http://127.0.0.1:${secondPort}/v1`,
          service: secondService,
        }),
      ]);

      expect((await fetch(firstHealthUrl)).ok).toBe(true);
      expect((await fetch(secondHealthUrl)).ok).toBe(true);
      for (const lease of leases) {
        lease?.release();
      }
      await Promise.all([
        waitForProbeFailure(firstHealthUrl),
        waitForProbeFailure(secondHealthUrl),
      ]);
      const starts = (await fs.readFile(startsPath, "utf8")).trim().split("\n").toSorted();
      expect(starts).toEqual([String(firstPort), String(secondPort)].toSorted());
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("restarts an OpenClaw-managed local service when its health endpoint is down", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-service-restart-"));
    const startsPath = path.join(tempDir, "starts.txt");
    const statusPath = path.join(tempDir, "status.txt");
    const forkedPidPath = path.join(tempDir, "forked.pid");
    let firstForkedPid: number | undefined;
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-restart",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: [
          "-e",
          `const fs=require("node:fs");const http=require("node:http");const {spawn}=require("node:child_process");const fork=spawn(process.execPath,["-e","setInterval(() => {}, 1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(
            forkedPidPath,
          )},String(fork.pid));fs.appendFileSync(${JSON.stringify(
            startsPath,
          )},"start\\n");fs.writeFileSync(${JSON.stringify(
            statusPath,
          )},"ok");const server=http.createServer((req,res)=>{const status=fs.readFileSync(${JSON.stringify(
            statusPath,
          )},"utf8");if(status.trim()!=="ok"){res.writeHead(503);res.end("not ready");return;}res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`,
        ],
        healthUrl,
        readyTimeoutMs: 5_000,
        idleStopMs: 0,
      },
    );

    try {
      const firstLease = await ensureModelProviderLocalService(model);
      firstLease?.release();
      expect((await fetch(healthUrl)).ok).toBe(true);
      firstForkedPid = await readPidFile(forkedPidPath);

      await fs.writeFile(statusPath, "down", "utf8");
      expect((await fetch(healthUrl)).status).toBe(503);

      const secondLease = await ensureModelProviderLocalService(model);
      if (!secondLease) {
        throw new Error("Expected restarted provider local service lease");
      }
      expect((await fetch(healthUrl)).ok).toBe(true);
      expect(await waitForPidToExit(firstForkedPid)).toBe(true);
      secondLease.release();

      const starts = (await fs.readFile(startsPath, "utf8")).trim().split("\n");
      expect(starts).toHaveLength(2);
    } finally {
      killPidIfAlive(firstForkedPid);
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("reports a local service startup exit without waiting for readiness timeout", async () => {
    const port = await freePort();
    const target = {
      providerId: "local-fast-exit",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      service: {
        command: process.execPath,
        args: ["-e", "process.exit(17)"],
        readyTimeoutMs: 60_000,
      },
    };

    const startedAt = Date.now();
    await expect(ensureProviderLocalService(target)).rejects.toThrow(
      "local-fast-exit local service exited before readiness with code 17",
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("preserves UTF-8 split across local service startup diagnostic chunks", async () => {
    const port = await freePort();
    const expected = "startup-😀-failure";
    const serviceScript = [
      `const bytes=Buffer.from(${JSON.stringify(expected)},"utf8");`,
      `const split=Buffer.byteLength("startup-","utf8")+2;`,
      `process.stderr.write(bytes.subarray(0,split));`,
      `setTimeout(()=>process.stderr.write(bytes.subarray(split),()=>process.exit(17)),75);`,
    ].join("");
    const target = {
      providerId: "local-utf8-exit",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      service: {
        command: process.execPath,
        args: ["-e", serviceScript],
        readyTimeoutMs: 60_000,
      },
    };

    await expect(ensureProviderLocalService(target)).rejects.toThrow(
      `local-utf8-exit local service exited before readiness with code 17; stderr: ${expected}`,
    );
  });

  it("reports a local service startup signal exit without waiting for readiness timeout", async () => {
    const port = await freePort();
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-signal-exit",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
        readyTimeoutMs: 60_000,
      },
    );

    const startedAt = Date.now();
    await expect(ensureModelProviderLocalService(model)).rejects.toThrow(
      "local-signal-exit local service exited before readiness with signal SIGTERM",
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("does not keep one-shot hosts alive through diagnostic pipes", async () => {
    const port = await freePort();
    const tempDir = tempDirs.make("openclaw-local-service-unref-");
    const servicePidPath = path.join(tempDir, "service.pid");
    const moduleUrl = new URL("./provider-local-service.ts", import.meta.url).href;
    const script = [
      `import fs from "node:fs/promises";`,
      `import { ensureProviderLocalService, getManagedProviderLocalServiceDiagnosticsForTest } from ${JSON.stringify(moduleUrl)};`,
      `const port = ${port};`,
      `const lease = await ensureProviderLocalService({`,
      `  providerId: "local-unref",`,
      `  baseUrl: "http://127.0.0.1:" + port + "/v1",`,
      `  service: {`,
      `    command: process.execPath,`,
      `    args: ["-e", ${JSON.stringify(
        `const http=require("node:http");const server=http.createServer((req,res)=>{res.writeHead(200);res.end("ok");});server.listen(${port},"127.0.0.1");setInterval(()=>process.stderr.write("tick\\\\n"),10);`,
      )}],`,
      `    readyTimeoutMs: 5000,`,
      `  },`,
      `});`,
      `const [diagnostics] = getManagedProviderLocalServiceDiagnosticsForTest();`,
      `if (diagnostics.stdoutTail || diagnostics.stderrTail) throw new Error("runtime output was retained");`,
      `await fs.writeFile(${JSON.stringify(servicePidPath)}, String(diagnostics.pid));`,
      `lease?.release();`,
    ].join("\n");
    const parent = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    parent.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    let servicePid: number | undefined;
    let exitTimeout: NodeJS.Timeout | undefined;

    try {
      const result = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          parent.once("exit", (code, signal) => resolve({ code, signal }));
        }),
        new Promise<"timeout">((resolve) => {
          exitTimeout = setTimeout(() => resolve("timeout"), 5_000);
        }),
      ]);
      clearTimeout(exitTimeout);
      expect(result, stderr).toEqual({ code: 0, signal: null });
      servicePid = await readPidFile(servicePidPath);
      expect(await waitForPidToExit(servicePid)).toBe(true);
    } finally {
      clearTimeout(exitTimeout);
      killPidIfAlive(parent.pid);
      if (servicePid === undefined) {
        servicePid = await readPidFile(servicePidPath).catch(() => undefined);
      }
      killPidIfAlive(servicePid);
    }
  });

  it("does not keep failed one-shot hosts alive through diagnostic pipes", async () => {
    const port = await freePort();
    const tempDir = tempDirs.make("openclaw-local-service-failed-unref-");
    const servicePidPath = path.join(tempDir, "service.pid");
    const moduleUrl = new URL("./provider-local-service.ts", import.meta.url).href;
    const serviceScript = [
      `const fs=require("node:fs");`,
      `fs.writeFileSync(${JSON.stringify(servicePidPath)},String(process.pid));`,
      `process.on("SIGTERM",()=>{});`,
      `setInterval(()=>process.stderr.write("tick\\n"),10);`,
    ].join("");
    const script = [
      `import { ensureProviderLocalService } from ${JSON.stringify(moduleUrl)};`,
      `try {`,
      `  await ensureProviderLocalService({`,
      `    providerId: "local-failed-unref",`,
      `    baseUrl: "http://127.0.0.1:${port}/v1",`,
      `    service: {`,
      `      command: process.execPath,`,
      `      args: ["-e", ${JSON.stringify(serviceScript)}],`,
      `      readyTimeoutMs: 100,`,
      `    },`,
      `  });`,
      `} catch {}`,
    ].join("\n");
    const parent = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    let servicePid: number | undefined;
    let exitTimeout: NodeJS.Timeout | undefined;

    try {
      const result = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          parent.once("exit", (code, signal) => resolve({ code, signal }));
        }),
        new Promise<"timeout">((resolve) => {
          exitTimeout = setTimeout(() => resolve("timeout"), 5_000);
        }),
      ]);
      clearTimeout(exitTimeout);
      expect(result).toEqual({ code: 0, signal: null });
      servicePid = await readPidFile(servicePidPath);
    } finally {
      clearTimeout(exitTimeout);
      killPidIfAlive(parent.pid);
      if (servicePid === undefined) {
        servicePid = await readPidFile(servicePidPath).catch(() => undefined);
      }
      killPidIfAlive(servicePid);
    }
  });

  it("honors request aborts while waiting for local service readiness", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const controller = new AbortController();
    const target = {
      providerId: "local-abort",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      service: {
        command: process.execPath,
        args: [
          "-e",
          `const http=require("node:http");setTimeout(()=>{const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));},2000);`,
        ],
        healthUrl,
        readyTimeoutMs: 60_000,
        idleStopMs: 1,
      },
    };

    const startedAt = Date.now();
    const abortTimer = setTimeout(() => controller.abort(new Error("request aborted")), 100);
    abortTimer.unref?.();

    await expect(ensureProviderLocalService(target, controller.signal)).rejects.toThrow(
      "request aborted",
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await waitForProbeFailure(healthUrl);
  });

  it("reports only bounded redacted startup diagnostics", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const diagnosticSecret = "local-service-diagnostic-secret";
    const inheritedDiagnosticSecret = "inherited-local-service-diagnostic-secret";
    const headerDiagnosticSecret = "header-local-service-diagnostic-secret";
    const argumentDiagnosticSecret = "argument-local-service-diagnostic-secret";
    let startupError: Error | undefined;
    vi.stubEnv("INHERITED_DIAGNOSTIC_TOKEN", inheritedDiagnosticSecret);

    try {
      await ensureProviderLocalService({
        providerId: "local-diagnostics",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        headers: {
          Authorization: `Bearer ${headerDiagnosticSecret}`,
        },
        service: {
          command: process.execPath,
          args: [
            "-e",
            `const http=require("node:http");const noise="x".repeat(9000);const server=http.createServer((req,res)=>{process.stderr.write(noise+" "+process.env.DIAGNOSTIC_SECRET+" "+process.env.INHERITED_DIAGNOSTIC_TOKEN+" "+process.argv[1]+" "+req.headers.authorization);res.writeHead(503,{"connection":"close"});res.end("not ready");server.close();setTimeout(()=>process.exit(17),20);});server.listen(${port},"127.0.0.1");`,
            argumentDiagnosticSecret,
          ],
          env: { DIAGNOSTIC_SECRET: diagnosticSecret },
          healthUrl,
          readyTimeoutMs: 5_000,
          idleStopMs: 1,
        },
      });
    } catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error));
    } finally {
      vi.unstubAllEnvs();
    }

    expect(startupError?.message).toContain(
      "local-diagnostics local service exited before readiness with code 17",
    );
    expect(startupError?.message).toContain("[redacted]");
    expect(startupError?.message).not.toContain(diagnosticSecret);
    expect(startupError?.message).not.toContain(inheritedDiagnosticSecret);
    expect(startupError?.message).not.toContain(headerDiagnosticSecret);
    expect(startupError?.message).not.toContain(argumentDiagnosticSecret);
    expect(Buffer.byteLength(startupError?.message ?? "")).toBeLessThanOrEqual(8 * 1024 + 256);
    expect(getManagedProviderLocalServiceDiagnosticsForTest()).toEqual([]);
  });

  it("does not spawn a local service after its last startup caller aborts", async () => {
    const tempDir = tempDirs.make("openclaw-local-service-abort-");
    const pidPath = path.join(tempDir, "child.pid");
    const controller = new AbortController();
    let probeCount = 0;
    let childPid: number | undefined;
    const server = http.createServer((_request, response) => {
      probeCount += 1;
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("not ready");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test server port");
    }
    const port = address.port;
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-abort-before-spawn",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`,
        ],
        healthUrl,
        readyTimeoutMs: 60_000,
      },
    );
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await realFetch(...args);
      if (response.status === 503 && !controller.signal.aborted) {
        controller.abort(new Error("request aborted after unhealthy probe"));
      }
      return response;
    });

    try {
      await expect(
        ensureModelProviderLocalService(model, undefined, controller.signal),
      ).rejects.toThrow("request aborted after unhealthy probe");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      childPid = await readPidFile(pidPath).catch(() => undefined);

      expect(probeCount).toBe(1);
      expect(childPid).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
      childPid ??= await readPidFile(pidPath).catch(() => undefined);
      killPidIfAlive(childPid);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
