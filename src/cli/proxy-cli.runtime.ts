import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { ensureDebugProxyCa } from "../proxy-capture/ca.js";
import { buildDebugProxyCoverageReport } from "../proxy-capture/coverage.js";
import { resolveDebugProxySettings, applyDebugProxyEnv } from "../proxy-capture/env.js";
import { startDebugProxyServer } from "../proxy-capture/proxy-server.js";
import {
  finalizeDebugProxyCapture,
  initializeDebugProxyCapture,
} from "../proxy-capture/runtime.js";
import {
  closeDebugProxyCaptureStore,
  getDebugProxyCaptureStore,
} from "../proxy-capture/store.sqlite.js";
import type { CaptureQueryPreset } from "../proxy-capture/types.js";

export async function runDebugProxyStartCommand(opts: { host?: string; port?: number }) {
  const settings = resolveDebugProxySettings();
  const store = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir);
  store.upsertSession({
    id: settings.sessionId,
    startedAt: Date.now(),
    mode: "proxy-start",
    sourceScope: "openclaw",
    sourceProcess: "openclaw",
    proxyUrl: settings.proxyUrl,
    dbPath: settings.dbPath,
    blobDir: settings.blobDir,
  });
  initializeDebugProxyCapture("proxy-start", settings);
  const ca = await ensureDebugProxyCa(settings.certDir);
  const server = await startDebugProxyServer({
    host: opts.host,
    port: opts.port,
    settings,
  });
  process.stdout.write(`Debug proxy: ${server.proxyUrl}\n`);
  process.stdout.write(`CA cert: ${ca.certPath}\n`);
  process.stdout.write(`Capture DB: ${settings.dbPath}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");
  const shutdown = async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await server.stop();
    if (settings.enabled) {
      finalizeDebugProxyCapture(settings);
    } else {
      store.endSession(settings.sessionId);
      closeDebugProxyCaptureStore();
    }
    process.exit(0);
  };
  const onSignal = () => {
    void shutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await new Promise(() => undefined);
}

export async function runDebugProxyRunCommand(opts: {
  host?: string;
  port?: number;
  commandArgs: string[];
}) {
  if (opts.commandArgs.length === 0) {
    throw new Error("proxy run requires a command after --");
  }
  const sessionId = randomUUID();
  const baseSettings = resolveDebugProxySettings();
  const settings = {
    ...baseSettings,
    sessionId,
  };
  getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).upsertSession({
    id: sessionId,
    startedAt: Date.now(),
    mode: "proxy-run",
    sourceScope: "openclaw",
    sourceProcess: "openclaw",
    proxyUrl: undefined,
    dbPath: settings.dbPath,
    blobDir: settings.blobDir,
  });
  const server = await startDebugProxyServer({
    host: opts.host,
    port: opts.port,
    settings,
  });
  const [command, ...args] = opts.commandArgs;
  const childEnv = applyDebugProxyEnv(process.env, {
    proxyUrl: server.proxyUrl,
    sessionId,
    dbPath: settings.dbPath,
    blobDir: settings.blobDir,
    certDir: settings.certDir,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: "inherit",
        env: childEnv,
        cwd: process.cwd(),
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        process.exitCode = signal ? 1 : (code ?? 1);
        resolve();
      });
    });
  } finally {
    await server.stop();
    getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).endSession(sessionId);
  }
}

export async function runDebugProxySessionsCommand(opts: { limit?: number }) {
  const settings = resolveDebugProxySettings();
  const sessions = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).listSessions(
    opts.limit ?? 20,
  );
  process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
  closeDebugProxyCaptureStore();
}

export async function runDebugProxyQueryCommand(opts: {
  preset: CaptureQueryPreset;
  sessionId?: string;
}) {
  const settings = resolveDebugProxySettings();
  const rows = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).queryPreset(
    opts.preset,
    opts.sessionId,
  );
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  closeDebugProxyCaptureStore();
}

export async function runDebugProxyCoverageCommand() {
  process.stdout.write(`${JSON.stringify(buildDebugProxyCoverageReport(), null, 2)}\n`);
  closeDebugProxyCaptureStore();
}

export async function runDebugProxyPurgeCommand() {
  const settings = resolveDebugProxySettings();
  const result = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).purgeAll();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  closeDebugProxyCaptureStore();
}

export async function readDebugProxyBlobCommand(opts: { blobId: string }) {
  const settings = resolveDebugProxySettings();
  const content = getDebugProxyCaptureStore(settings.dbPath, settings.blobDir).readBlob(
    opts.blobId,
  );
  if (content == null) {
    closeDebugProxyCaptureStore();
    throw new Error(`Unknown blob: ${opts.blobId}`);
  }
  process.stdout.write(content);
  closeDebugProxyCaptureStore();
}
