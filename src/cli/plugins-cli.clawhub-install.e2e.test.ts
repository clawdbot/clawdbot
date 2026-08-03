import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";

const PACKAGE_NAME = "@openclaw/telemetry-demo";
const PACKAGE_VERSION = "1.0.0";
const PLUGIN_ID = "telemetry-demo";
const ENCODED_PACKAGE_NAME = encodeURIComponent(PACKAGE_NAME);

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function spawnOpenClaw(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/entry.ts", ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function buildPluginZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "package/package.json",
    JSON.stringify({
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      type: "module",
      openclaw: { extensions: ["./dist/index.js"] },
    }),
  );
  zip.file(
    "package/openclaw.plugin.json",
    JSON.stringify({
      id: PLUGIN_ID,
      configSchema: { type: "object", properties: {} },
    }),
  );
  zip.file("package/dist/index.js", "export default function register() {}\n");
  return await zip.generateAsync({ type: "nodebuffer" });
}

type TestServerOptions = {
  artifactSha256?: string;
  telemetryStatus?: number;
};

async function startClawHubServer(options: TestServerOptions = {}) {
  const archive = await buildPluginZip();
  const artifactSha256 =
    options.artifactSha256 ?? createHash("sha256").update(archive).digest("hex");
  const telemetryBodies: unknown[] = [];
  const requestLog: string[] = [];

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requestLog.push(`${req.method ?? "GET"} ${url.pathname}`);
    const packagePath = `/api/v1/packages/${ENCODED_PACKAGE_NAME}`;

    if (req.method === "GET" && url.pathname === packagePath) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          package: {
            name: PACKAGE_NAME,
            displayName: "Telemetry Demo",
            family: "code-plugin",
            runtimeId: PLUGIN_ID,
            channel: "community",
            isOfficial: false,
            latestVersion: PACKAGE_VERSION,
            tags: { latest: PACKAGE_VERSION },
            compatibility: {},
          },
          owner: { handle: "openclaw" },
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === `${packagePath}/versions/${PACKAGE_VERSION}/artifact`
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          package: {
            name: PACKAGE_NAME,
            displayName: "Telemetry Demo",
            family: "code-plugin",
          },
          version: {
            version: PACKAGE_VERSION,
            createdAt: 1,
            changelog: "Initial release",
            sha256hash: artifactSha256,
            compatibility: {},
          },
        }),
      );
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === `${packagePath}/versions/${PACKAGE_VERSION}/security`
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          package: {
            name: PACKAGE_NAME,
            displayName: "Telemetry Demo",
            family: "code-plugin",
          },
          release: { version: PACKAGE_VERSION },
          trust: {
            scanStatus: "clean",
            moderationState: null,
            blockedFromDownload: false,
            reasons: [],
            pending: false,
            stale: false,
          },
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === `${packagePath}/download`) {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(archive);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cli/telemetry/install") {
      telemetryBodies.push(JSON.parse(await readRequestBody(req)) as unknown);
      const status = options.telemetryStatus ?? 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ ok: true }) : JSON.stringify({ error: "down" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    registry: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requestLog,
    telemetryBodies,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function buildEnv(stateDir: string, registry: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_CLAWHUB_URL: registry,
    CLAWHUB_TOKEN: "test-token",
    CLAWHUB_DISABLE_TELEMETRY: "",
    CLAWDHUB_DISABLE_TELEMETRY: "",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}

async function readPersistedInstallRecord(stateDir: string) {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  try {
    const records = await loadInstalledPluginIndexInstallRecords();
    return records[PLUGIN_ID];
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
  }
}

describe("openclaw plugins install ClawHub E2E", () => {
  it("reports successful installs and repeat updates after persisting the install record", async () => {
    const testServer = await startClawHubServer();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-telemetry-e2e-"));
    try {
      const env = buildEnv(stateDir, testServer.registry);
      const first = await spawnOpenClaw(
        ["plugins", "install", `clawhub:${PACKAGE_NAME}@${PACKAGE_VERSION}`],
        { cwd: process.cwd(), env },
      );
      expect(first.status, first.stderr || first.stdout).toBe(0);

      const record = await readPersistedInstallRecord(stateDir);
      expect(record).toMatchObject({
        source: "clawhub",
        clawhubPackage: PACKAGE_NAME,
        version: PACKAGE_VERSION,
      });
      expect(testServer.telemetryBodies).toEqual([
        {
          event: "plugin_install",
          packageName: PACKAGE_NAME,
          version: PACKAGE_VERSION,
        },
      ]);

      const repeat = await spawnOpenClaw(
        ["plugins", "install", `clawhub:${PACKAGE_NAME}@${PACKAGE_VERSION}`, "--force"],
        { cwd: process.cwd(), env },
      );
      expect(repeat.status, repeat.stderr || repeat.stdout).toBe(0);
      expect(testServer.telemetryBodies).toHaveLength(2);
      expect(testServer.telemetryBodies[1]).toEqual(testServer.telemetryBodies[0]);
    } finally {
      await testServer.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not report success when plugin installation fails", async () => {
    const testServer = await startClawHubServer({ artifactSha256: "0".repeat(64) });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-telemetry-fail-"));
    try {
      const result = await spawnOpenClaw(
        ["plugins", "install", `clawhub:${PACKAGE_NAME}@${PACKAGE_VERSION}`],
        { cwd: process.cwd(), env: buildEnv(stateDir, testServer.registry) },
      );

      expect(result.status).not.toBe(0);
      expect(testServer.telemetryBodies).toEqual([]);
      await expect(readPersistedInstallRecord(stateDir)).resolves.toBeUndefined();
    } finally {
      await testServer.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps a valid local install successful when telemetry is unavailable", async () => {
    const testServer = await startClawHubServer({ telemetryStatus: 503 });
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-telemetry-down-"));
    try {
      const result = await spawnOpenClaw(
        ["plugins", "install", `clawhub:${PACKAGE_NAME}@${PACKAGE_VERSION}`],
        { cwd: process.cwd(), env: buildEnv(stateDir, testServer.registry) },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      await expect(readPersistedInstallRecord(stateDir)).resolves.toMatchObject({
        source: "clawhub",
        clawhubPackage: PACKAGE_NAME,
        version: PACKAGE_VERSION,
      });
      expect(testServer.telemetryBodies).toHaveLength(1);
    } finally {
      await testServer.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});
