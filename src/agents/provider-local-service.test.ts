import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachModelProviderLocalService,
  ensureModelProviderLocalService,
  getModelProviderLocalService,
  stopManagedProviderLocalServicesForTest,
} from "./provider-local-service.js";

async function freePort(): Promise<number> {
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
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("local service still responded after idle stop");
}

describe("provider local service", () => {
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

    expect(lease).toBeDefined();
    expect((await fetch(healthUrl)).ok).toBe(true);
    lease?.release();
    await waitForProbeFailure(healthUrl);
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

    const lease = await ensureModelProviderLocalService(model, {
      Authorization: "Bearer health-secret",
      "X-Tenant": "acme",
    });

    expect(lease).toBeDefined();
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

  it("serializes concurrent cold starts for the same local service", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-service-"));
    const startsPath = path.join(tempDir, "starts.txt");
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-concurrent",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
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
      },
    );

    try {
      const leases = await Promise.all([
        ensureModelProviderLocalService(model),
        ensureModelProviderLocalService(model),
      ]);

      expect(leases).toHaveLength(2);
      expect((await fetch(healthUrl)).ok).toBe(true);
      for (const lease of leases) {
        lease?.release();
      }
      await waitForProbeFailure(healthUrl);
      const starts = (await fs.readFile(startsPath, "utf8")).trim().split("\n");
      expect(starts).toHaveLength(1);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("does not reuse a local service with different env and derived health endpoint", async () => {
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
    const firstModel = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-key",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${firstPort}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args,
        env: { LOCAL_SERVICE_PORT: String(firstPort), STARTS_PATH: startsPath },
        readyTimeoutMs: 5_000,
        idleStopMs: 1,
      },
    );
    const secondModel = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-key",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${secondPort}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args,
        env: { LOCAL_SERVICE_PORT: String(secondPort), STARTS_PATH: startsPath },
        readyTimeoutMs: 5_000,
        idleStopMs: 1,
      },
    );

    try {
      const leases = await Promise.all([
        ensureModelProviderLocalService(firstModel),
        ensureModelProviderLocalService(secondModel),
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
          `const fs=require("node:fs");const http=require("node:http");fs.appendFileSync(${JSON.stringify(
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

      await fs.writeFile(statusPath, "down", "utf8");
      expect((await fetch(healthUrl)).status).toBe(503);

      const secondLease = await ensureModelProviderLocalService(model);
      expect(secondLease).toBeDefined();
      expect((await fetch(healthUrl)).ok).toBe(true);
      secondLease?.release();

      const starts = (await fs.readFile(startsPath, "utf8")).trim().split("\n");
      expect(starts).toHaveLength(2);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("reports a local service startup exit without waiting for readiness timeout", async () => {
    const port = await freePort();
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-fast-exit",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: ["-e", "process.exit(17)"],
        readyTimeoutMs: 60_000,
      },
    );

    const startedAt = Date.now();
    await expect(ensureModelProviderLocalService(model)).rejects.toThrow(
      "local-fast-exit local service exited before readiness with code 17",
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("honors request aborts while waiting for local service readiness", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const controller = new AbortController();
    const model = attachModelProviderLocalService(
      {
        id: "demo",
        provider: "local-abort",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-completions">,
      {
        command: process.execPath,
        args: [
          "-e",
          `const http=require("node:http");setTimeout(()=>{const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));},2000);`,
        ],
        healthUrl,
        readyTimeoutMs: 60_000,
        idleStopMs: 1,
      },
    );

    const startedAt = Date.now();
    const abortTimer = setTimeout(() => controller.abort(new Error("request aborted")), 100);
    abortTimer.unref?.();

    await expect(
      ensureModelProviderLocalService(model, undefined, controller.signal),
    ).rejects.toThrow("request aborted");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await waitForProbeFailure(healthUrl);
  });
});
