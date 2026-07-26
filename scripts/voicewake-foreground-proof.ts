// Proves Voice Wake migration convergence through two isolated foreground Gateway starts.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  loadVoiceWakeRoutingConfig,
  setVoiceWakeRoutingConfig,
} from "../src/infra/voicewake-routing.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "../src/infra/voicewake.js";
import { redactToolPayloadTextWithConfig } from "../src/logging/redact.js";
import { closeOpenClawStateDatabaseByPath } from "../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";

type GatewayReadiness = {
  failing: string[];
  ready: boolean;
};

type GatewayChild = ChildProcessByStdio<null, Readable, Readable>;

type GatewayProcess = {
  child: GatewayChild;
  logs: () => string;
  spawnError: () => Error | undefined;
};

type ReadinessResult = {
  ready: boolean;
  status: "ready";
};

type ShutdownResult = {
  clean: boolean;
  escalated: boolean;
};

type ProofManifest = {
  candidateSha: string;
  failure?: string;
  fixtures: {
    legacyJson: "conflicting";
    sqlite: "canonical";
  };
  gateway: {
    bind: "loopback";
    port: "ephemeral";
    starts: Array<{
      readiness: ReadinessResult;
      shutdown: ShutdownResult;
    }>;
  };
  isolation: {
    config: "temporary";
    home: "temporary";
    state: "temporary";
  };
  outcome: "pass" | "fail";
  receipts?: Array<{
    mode: "0600";
    name: string;
    sourceRetired: boolean;
  }>;
  sqlite?: {
    routingPreserved: boolean;
    triggersPreserved: boolean;
  };
};

const GATEWAY_READY_TIMEOUT_MS = 60_000;
const GATEWAY_STOP_TIMEOUT_MS = 3_000;
const LOG_TAIL_MAX_CHARS = 2_000;
const PROOF_ARTIFACT_DIR_ENV = "OPENCLAW_VOICEWAKE_PROOF_ARTIFACT_DIR";
const PROOF_CANDIDATE_SHA_ENV = "OPENCLAW_VOICEWAKE_PROOF_CANDIDATE_SHA";
const CANONICAL_TRIGGERS = ["sqlite wake"];
const CANONICAL_ROUTING = {
  defaultTarget: { mode: "current" as const },
  routes: [{ trigger: "sqlite route", target: { agentId: "sqlite-agent" } }],
};
const LEGACY_TRIGGER_FIXTURE = { triggers: ["legacy wake"] };
const LEGACY_ROUTING_FIXTURE = {
  defaultTarget: { agentId: "legacy-agent" },
  routes: [{ trigger: "legacy route", target: { agentId: "legacy-route-agent" } }],
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate loopback port");
  }
  return address.port;
}

function appendLog(log: string, chunk: unknown): string {
  const next = `${log}${String(chunk)}`;
  return next.length <= LOG_TAIL_MAX_CHARS ? next : next.slice(-LOG_TAIL_MAX_CHARS);
}

function sanitizeDiagnostic(value: string, roots: readonly string[]): string {
  let sanitized = value;
  for (const root of roots) {
    if (root) {
      sanitized = sanitized.split(root).join("<temporary-root>");
    }
  }
  return redactToolPayloadTextWithConfig(sanitized).slice(-LOG_TAIL_MAX_CHARS);
}

function childExit(
  child: GatewayChild,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function childHasExited(child: GatewayChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalGateway(child: GatewayChild, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  process.kill(-child.pid, signal);
}

async function stopGateway(child: GatewayChild): Promise<ShutdownResult> {
  if (!child.pid) {
    return { clean: false, escalated: false };
  }
  if (childHasExited(child)) {
    return { clean: false, escalated: false };
  }
  const exited = childExit(child);
  try {
    signalGateway(child, "SIGTERM");
  } catch {
    // The child can exit between the readiness check and signal delivery.
  }
  const graceful = await Promise.race([exited, delay(GATEWAY_STOP_TIMEOUT_MS).then(() => null)]);
  if (graceful) {
    return { clean: graceful.code === 0, escalated: false };
  }

  try {
    signalGateway(child, "SIGKILL");
  } catch {
    // The child may have already exited.
  }
  const forced = await Promise.race([exited, delay(GATEWAY_STOP_TIMEOUT_MS).then(() => null)]);
  if (!forced) {
    throw new Error("Gateway did not exit after SIGKILL");
  }
  return { clean: forced.code === 0, escalated: true };
}

async function waitForGatewayReady(params: {
  gateway: GatewayProcess;
  port: number;
  roots: readonly string[];
}): Promise<ReadinessResult> {
  const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
  const url = `http://127.0.0.1:${params.port}/readyz`;
  while (Date.now() < deadline) {
    const spawnError = params.gateway.spawnError();
    if (spawnError) {
      throw new Error(
        `Gateway failed to launch: ${sanitizeDiagnostic(spawnError.message, params.roots)}`,
      );
    }
    if (childHasExited(params.gateway.child)) {
      const detail = sanitizeDiagnostic(params.gateway.logs(), params.roots);
      throw new Error(`Gateway exited before readiness: ${detail}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const readiness = (await response.json()) as GatewayReadiness;
        if (readiness.ready && readiness.failing.length === 0) {
          return { ready: true, status: "ready" };
        }
      }
    } catch {
      // Startup opens the listener before migration readiness settles.
    }
    await delay(100);
  }
  const detail = sanitizeDiagnostic(params.gateway.logs(), params.roots);
  throw new Error(`Gateway readiness timed out: ${detail}`);
}

function createGatewayEnv(params: {
  configPath: string;
  homeDir: string;
  stateDir: string;
}): NodeJS.ProcessEnv {
  return {
    HOME: params.homeDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_GATEWAY_PASSWORD: "",
    OPENCLAW_GATEWAY_TOKEN: "",
    OPENCLAW_HOME: params.homeDir,
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_STATE_DIR: params.stateDir,
    PATH: process.env.PATH,
    USERPROFILE: params.homeDir,
  };
}

function startGateway(params: {
  configPath: string;
  homeDir: string;
  port: number;
  stateDir: string;
}): GatewayProcess {
  let spawnError: Error | undefined;
  let stderr = "";
  let stdout = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("src/entry.ts"),
      "gateway",
      "run",
      "--allow-unconfigured",
      "--auth",
      "none",
      "--bind",
      "loopback",
      "--port",
      String(params.port),
    ],
    {
      cwd: path.resolve("."),
      detached: process.platform !== "win32",
      env: createGatewayEnv(params),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout = appendLog(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendLog(stderr, chunk);
  });
  return {
    child,
    logs: () => `${stdout}\n${stderr}`,
    spawnError: () => spawnError,
  };
}

async function assertMigratedVoiceWakeState(params: {
  stateDir: string;
  triggersPath: string;
  routingPath: string;
}): Promise<ProofManifest["receipts"]> {
  const triggers = await loadVoiceWakeConfig(params.stateDir);
  if (JSON.stringify(triggers.triggers) !== JSON.stringify(CANONICAL_TRIGGERS)) {
    throw new Error("canonical Voice Wake triggers changed during Gateway startup");
  }
  const routing = await loadVoiceWakeRoutingConfig(params.stateDir);
  if (JSON.stringify(routing.defaultTarget) !== JSON.stringify(CANONICAL_ROUTING.defaultTarget)) {
    throw new Error("canonical Voice Wake default routing changed during Gateway startup");
  }
  if (JSON.stringify(routing.routes) !== JSON.stringify(CANONICAL_ROUTING.routes)) {
    throw new Error("canonical Voice Wake routes changed during Gateway startup");
  }

  const receipts = [
    { expectedFixture: "legacy wake", sourcePath: params.triggersPath },
    { expectedFixture: "legacy route", sourcePath: params.routingPath },
  ].map(({ expectedFixture, sourcePath }) => ({
    expectedFixture,
    sourcePath,
    receiptPath: `${sourcePath}.migrated`,
  }));
  for (const { expectedFixture, sourcePath, receiptPath } of receipts) {
    await fs
      .access(sourcePath)
      .then(() => {
        throw new Error(`legacy Voice Wake source still exists: ${path.basename(sourcePath)}`);
      })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
    const [receipt, stat] = await Promise.all([
      fs.readFile(receiptPath, "utf8"),
      fs.stat(receiptPath),
    ]);
    if (!receipt.includes(expectedFixture)) {
      throw new Error(
        `legacy Voice Wake receipt lost its original fixture: ${path.basename(receiptPath)}`,
      );
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error(`legacy Voice Wake receipt is not private: ${path.basename(receiptPath)}`);
    }
  }

  return receipts.map(({ receiptPath }) => ({
    mode: "0600" as const,
    name: path.basename(receiptPath),
    sourceRetired: true,
  }));
}

function renderTranscript(manifest: ProofManifest): string {
  const lines = [
    "# Voice Wake foreground Gateway proof",
    "",
    `- Candidate SHA: \`${manifest.candidateSha}\``,
    "- Gateway bind: loopback-only ephemeral port",
    "- State/config/home: isolated temporary directories",
  ];
  if (manifest.outcome === "pass") {
    lines.push(
      "- Conflicting legacy JSON was retired after canonical SQLite state remained unchanged.",
      "- First foreground Gateway readiness: pass.",
      "- Both receipts are private (`0600`).",
      "- Clean owned-process shutdown: pass.",
      "- Second foreground Gateway readiness on the same state: pass.",
    );
  } else {
    lines.push("- Outcome: fail.", `- Redacted diagnostic: ${manifest.failure ?? "unavailable"}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeArtifact(params: {
  artifactDir: string;
  manifest: ProofManifest;
}): Promise<void> {
  await fs.mkdir(params.artifactDir, { recursive: true });
  await fs.writeFile(
    path.join(params.artifactDir, "voicewake-foreground-proof.json"),
    `${JSON.stringify(params.manifest, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(params.artifactDir, "voicewake-foreground-proof.md"),
    renderTranscript(params.manifest),
    "utf8",
  );
}

async function main(): Promise<void> {
  const artifactDir = path.resolve(requireEnv(PROOF_ARTIFACT_DIR_ENV));
  const candidateSha = requireEnv(PROOF_CANDIDATE_SHA_ENV);
  const temporaryRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voicewake-proof-")),
  );
  const homeDir = path.join(temporaryRoot, "home");
  const stateDir = path.join(homeDir, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const triggersPath = path.join(stateDir, "settings", "voicewake.json");
  const routingPath = path.join(stateDir, "settings", "voicewake-routing.json");
  const env = createGatewayEnv({ configPath, homeDir, stateDir });
  const starts: ProofManifest["gateway"]["starts"] = [];
  let child: GatewayChild | undefined;
  let manifest: ProofManifest = {
    candidateSha,
    fixtures: { legacyJson: "conflicting", sqlite: "canonical" },
    gateway: { bind: "loopback", port: "ephemeral", starts },
    isolation: { config: "temporary", home: "temporary", state: "temporary" },
    outcome: "fail",
  };

  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        gateway: {
          auth: { mode: "none" },
          bind: "loopback",
          mode: "local",
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
        },
        plugins: { enabled: false },
      })}\n`,
      "utf8",
    );
    await setVoiceWakeTriggers(CANONICAL_TRIGGERS, stateDir);
    await setVoiceWakeRoutingConfig(CANONICAL_ROUTING, stateDir);
    await fs.mkdir(path.dirname(triggersPath), { recursive: true });
    await fs.writeFile(triggersPath, `${JSON.stringify(LEGACY_TRIGGER_FIXTURE)}\n`, "utf8");
    await fs.writeFile(routingPath, `${JSON.stringify(LEGACY_ROUTING_FIXTURE)}\n`, "utf8");
    closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const port = await allocateLoopbackPort();
      const gateway = startGateway({ configPath, homeDir, port, stateDir });
      child = gateway.child;
      const readiness = await waitForGatewayReady({
        gateway,
        port,
        roots: [temporaryRoot, path.resolve(".")],
      });
      const receipts = await assertMigratedVoiceWakeState({ stateDir, triggersPath, routingPath });
      closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
      const shutdown = await stopGateway(child);
      child = undefined;
      if (!shutdown.clean || shutdown.escalated) {
        throw new Error("Gateway did not shut down cleanly");
      }
      starts.push({ readiness, shutdown });
      manifest = {
        ...manifest,
        receipts,
        sqlite: { routingPreserved: true, triggersPreserved: true },
      };
    }

    manifest = { ...manifest, outcome: "pass" };
  } catch (error) {
    if (child) {
      await stopGateway(child).catch(() => undefined);
    }
    manifest = {
      ...manifest,
      failure: sanitizeDiagnostic(error instanceof Error ? error.message : String(error), [
        temporaryRoot,
        path.resolve("."),
      ]),
      outcome: "fail",
    };
  } finally {
    let cleanupError: Error | undefined;
    try {
      closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
      await fs.rm(temporaryRoot, { force: true, recursive: true });
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
    if (cleanupError && manifest.outcome === "pass") {
      manifest = {
        ...manifest,
        failure: sanitizeDiagnostic(cleanupError.message, [temporaryRoot, path.resolve(".")]),
        outcome: "fail",
      };
    }
    await writeArtifact({ artifactDir, manifest });
  }

  if (manifest.outcome !== "pass") {
    throw new Error(manifest.failure ?? "Voice Wake foreground proof failed");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
