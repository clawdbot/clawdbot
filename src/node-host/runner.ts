import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BridgeInvokeRequestFrame } from "../infra/bridge/server/types.js";
import {
  addAllowlistEntry,
  matchAllowlist,
  recordAllowlistUse,
  requestExecApprovalViaSocket,
  resolveCommandResolution,
  resolveExecApprovals,
} from "../infra/exec-approvals.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { VERSION } from "../version.js";

import { BridgeClient } from "./bridge-client.js";
import {
  ensureNodeHostConfig,
  saveNodeHostConfig,
  type NodeHostGatewayConfig,
} from "./config.js";

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
};

type SystemRunParams = {
  command: string[];
  rawCommand?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
};

type SystemWhichParams = {
  bins: string[];
};

type RunResult = {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
  truncated: boolean;
};

type ExecEventPayload = {
  sessionKey: string;
  runId: string;
  host: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
  success?: boolean;
  output?: string;
  reason?: string;
};

const OUTPUT_CAP = 200_000;
const OUTPUT_EVENT_TAIL = 20_000;

const blockedEnvKeys = new Set([
  "PATH",
  "NODE_OPTIONS",
  "PYTHONHOME",
  "PYTHONPATH",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
]);

const blockedEnvPrefixes = ["DYLD_", "LD_"];

class SkillBinsCache {
  private bins = new Set<string>();
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;
  private readonly fetch: () => Promise<string[]>;

  constructor(fetch: () => Promise<string[]>) {
    this.fetch = fetch;
  }

  async current(force = false): Promise<Set<string>> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const bins = await this.fetch();
      this.bins = new Set(bins);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = new Set();
      }
    }
  }
}

function sanitizeEnv(overrides?: Record<string, string> | null): Record<string, string> | undefined {
  if (!overrides) return undefined;
  const merged = { ...process.env } as Record<string, string>;
  for (const [rawKey, value] of Object.entries(overrides)) {
    const key = rawKey.trim();
    if (!key) continue;
    const upper = key.toUpperCase();
    if (blockedEnvKeys.has(upper)) continue;
    if (blockedEnvPrefixes.some((prefix) => upper.startsWith(prefix))) continue;
    merged[key] = value;
  }
  return merged;
}

function formatCommand(argv: string[]): string {
  return argv
    .map((arg) => {
      const trimmed = arg.trim();
      if (!trimmed) return "\"\"";
      const needsQuotes = /\s|"/.test(trimmed);
      if (!needsQuotes) return trimmed;
      return `"${trimmed.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

function truncateOutput(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  return { text: `... (truncated) ${raw.slice(raw.length - maxChars)}`, truncated: true };
}

async function runCommand(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
): Promise<RunResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (outputLen >= OUTPUT_CAP) {
        truncated = true;
        return;
      }
      const remaining = OUTPUT_CAP - outputLen;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      const str = slice.toString("utf8");
      outputLen += slice.length;
      if (target === "stdout") stdout += str;
      else stderr += str;
      if (chunk.length > remaining) truncated = true;
    };

    child.stdout?.on("data", (chunk) => onChunk(chunk as Buffer, "stdout"));
    child.stderr?.on("data", (chunk) => onChunk(chunk as Buffer, "stderr"));

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    const finalize = (exitCode?: number, error?: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        success: exitCode === 0 && !timedOut && !error,
        stdout,
        stderr,
        error: error ?? null,
        truncated,
      });
    };

    child.on("error", (err) => {
      finalize(undefined, err.message);
    });
    child.on("exit", (code) => {
      finalize(code === null ? undefined : code, null);
    });
  });
}

function resolveEnvPath(env?: Record<string, string>): string[] {
  const raw =
    env?.PATH ??
    (env as Record<string, string>)?.Path ??
    process.env.PATH ??
    process.env.Path ??
    "";
  return raw.split(path.delimiter).filter(Boolean);
}

function resolveExecutable(bin: string, env?: Record<string, string>) {
  if (bin.includes("/") || bin.includes("\\")) return null;
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((ext) => ext.toLowerCase())
      : [""];
  for (const dir of resolveEnvPath(env)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function handleSystemWhich(params: SystemWhichParams, env?: Record<string, string>) {
  const bins = params.bins
    .map((bin) => bin.trim())
    .filter(Boolean);
  const found: Record<string, string> = {};
  for (const bin of bins) {
    const path = resolveExecutable(bin, env);
    if (path) found[bin] = path;
  }
  return { bins: found };
}

function buildExecEventPayload(payload: ExecEventPayload): ExecEventPayload {
  if (!payload.output) return payload;
  const trimmed = payload.output.trim();
  if (!trimmed) return payload;
  const { text } = truncateOutput(trimmed, OUTPUT_EVENT_TAIL);
  return { ...payload, output: text };
}

export async function runNodeHost(opts: NodeHostRunOptions): Promise<void> {
  const config = await ensureNodeHostConfig();
  const nodeId = opts.nodeId?.trim() || config.nodeId;
  if (nodeId !== config.nodeId) {
    config.nodeId = nodeId;
    config.token = undefined;
  }
  const displayName =
    opts.displayName?.trim() || config.displayName || (await getMachineDisplayName());
  config.displayName = displayName;
  const gateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls === true,
    tlsFingerprint: opts.gatewayTlsFingerprint,
  };
  config.gateway = gateway;
  await saveNodeHostConfig(config);

  let disconnectResolve: (() => void) | null = null;
  let disconnectSignal = false;
  const waitForDisconnect = () =>
    new Promise<void>((resolve) => {
      if (disconnectSignal) {
        disconnectSignal = false;
        resolve();
        return;
      }
      disconnectResolve = resolve;
    });

  const client = new BridgeClient({
    host: gateway.host ?? "127.0.0.1",
    port: gateway.port ?? 18790,
    tls: gateway.tls,
    tlsFingerprint: gateway.tlsFingerprint,
    nodeId,
    token: config.token,
    displayName,
    platform: process.platform,
    version: VERSION,
    deviceFamily: os.platform(),
    modelIdentifier: os.hostname(),
    caps: ["system"],
    commands: ["system.run", "system.which"],
    onPairToken: async (token) => {
      config.token = token;
      await saveNodeHostConfig(config);
    },
    onAuthReset: async () => {
      if (!config.token) return;
      config.token = undefined;
      await saveNodeHostConfig(config);
    },
    onInvoke: async (frame) => {
      await handleInvoke(frame, client, skillBins);
    },
    onDisconnected: () => {
      if (disconnectResolve) {
        disconnectResolve();
        disconnectResolve = null;
      } else {
        disconnectSignal = true;
      }
    },
  });

  const skillBins = new SkillBinsCache(async () => {
    const res = await client.request("skills.bins", {});
    const bins = Array.isArray(res?.bins)
      ? res.bins.map((bin: unknown) => String(bin))
      : [];
    return bins;
  });

  while (true) {
    try {
      await client.connect();
      await waitForDisconnect();
    } catch {
      // ignore connect errors; retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function handleInvoke(
  frame: BridgeInvokeRequestFrame,
  client: BridgeClient,
  skillBins: SkillBinsCache,
) {
  const command = String(frame.command ?? "");
  if (command === "system.which") {
    try {
      const params = decodeParams<SystemWhichParams>(frame.paramsJSON);
      if (!Array.isArray(params.bins)) {
        throw new Error("INVALID_REQUEST: bins required");
      }
      const env = sanitizeEnv(undefined);
      const payload = await handleSystemWhich(params, env);
      client.sendInvokeResponse({
        type: "invoke-res",
        id: frame.id,
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      client.sendInvokeResponse({
        type: "invoke-res",
        id: frame.id,
        ok: false,
        error: { code: "INVALID_REQUEST", message: String(err) },
      });
    }
    return;
  }

  if (command !== "system.run") {
    client.sendInvokeResponse({
      type: "invoke-res",
      id: frame.id,
      ok: false,
      error: { code: "UNAVAILABLE", message: "command not supported" },
    });
    return;
  }

  let params: SystemRunParams;
  try {
    params = decodeParams<SystemRunParams>(frame.paramsJSON);
  } catch (err) {
    client.sendInvokeResponse({
      type: "invoke-res",
      id: frame.id,
      ok: false,
      error: { code: "INVALID_REQUEST", message: String(err) },
    });
    return;
  }

  if (!Array.isArray(params.command) || params.command.length === 0) {
    client.sendInvokeResponse({
      type: "invoke-res",
      id: frame.id,
      ok: false,
      error: { code: "INVALID_REQUEST", message: "command required" },
    });
    return;
  }

  const argv = params.command.map((item) => String(item));
  const rawCommand = typeof params.rawCommand === "string" ? params.rawCommand.trim() : "";
  const cmdText = rawCommand || formatCommand(argv);
  const agentId = params.agentId?.trim() || undefined;
  const approvals = resolveExecApprovals(agentId);
  const security = approvals.agent.security;
  const ask = approvals.agent.ask;
  const askFallback = approvals.agent.askFallback;
  const autoAllowSkills = approvals.agent.autoAllowSkills;
  const sessionKey = params.sessionKey?.trim() || "node";
  const runId = crypto.randomUUID();
  const env = sanitizeEnv(params.env ?? undefined);
  const resolution = resolveCommandResolution(cmdText, params.cwd ?? undefined, env);
  const allowlistMatch =
    security === "allowlist" ? matchAllowlist(approvals.allowlist, resolution) : null;
  const bins = autoAllowSkills ? await skillBins.current() : new Set<string>();
  const skillAllow =
    autoAllowSkills && resolution?.executableName ? bins.has(resolution.executableName) : false;

  if (security === "deny") {
    client.sendEvent(
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "security=deny",
      }),
    );
    client.sendInvokeResponse({
      type: "invoke-res",
      id: frame.id,
      ok: false,
      error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DISABLED: security=deny" },
    });
    return;
  }

  const requiresAsk =
    ask === "always" ||
    (ask === "on-miss" && security === "allowlist" && !allowlistMatch && !skillAllow);

  let approvedByAsk = false;
  if (requiresAsk) {
    const decision = await requestExecApprovalViaSocket({
      socketPath: approvals.socketPath,
      token: approvals.token,
      request: {
        command: cmdText,
        cwd: params.cwd ?? undefined,
        host: "node",
        security,
        ask,
        agentId,
        resolvedPath: resolution?.resolvedPath ?? null,
      },
    });
    if (decision === "deny") {
      client.sendEvent(
        "exec.denied",
        buildExecEventPayload({
          sessionKey,
          runId,
          host: "node",
          command: cmdText,
          reason: "user-denied",
        }),
      );
      client.sendInvokeResponse({
        type: "invoke-res",
        id: frame.id,
        ok: false,
        error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: user denied" },
      });
      return;
    }
    if (!decision) {
      if (askFallback === "full") {
        approvedByAsk = true;
      } else if (askFallback === "allowlist") {
        if (allowlistMatch || skillAllow) {
          approvedByAsk = true;
        } else {
          client.sendEvent(
            "exec.denied",
            buildExecEventPayload({
              sessionKey,
              runId,
              host: "node",
              command: cmdText,
              reason: "approval-required",
            }),
          );
          client.sendInvokeResponse({
            type: "invoke-res",
            id: frame.id,
            ok: false,
            error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
          });
          return;
        }
      } else {
        client.sendEvent(
          "exec.denied",
          buildExecEventPayload({
            sessionKey,
            runId,
            host: "node",
            command: cmdText,
            reason: "approval-required",
          }),
        );
        client.sendInvokeResponse({
          type: "invoke-res",
          id: frame.id,
          ok: false,
          error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
        });
        return;
      }
    }
    if (decision === "allow-once") {
      approvedByAsk = true;
    }
    if (decision === "allow-always") {
      approvedByAsk = true;
      if (security === "allowlist") {
        const pattern = resolution?.resolvedPath ?? resolution?.rawExecutable ?? argv[0] ?? "";
        if (pattern) addAllowlistEntry(approvals.file, agentId, pattern);
      }
    }
  }

  if (security === "allowlist" && !allowlistMatch && !skillAllow && !approvedByAsk) {
    client.sendEvent(
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "allowlist-miss",
      }),
    );
    client.sendInvokeResponse({
      type: "invoke-res",
      id: frame.id,
      ok: false,
      error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: allowlist miss" },
    });
    return;
  }

  if (allowlistMatch) {
    recordAllowlistUse(approvals.file, agentId, allowlistMatch, cmdText, resolution?.resolvedPath);
  }

  if (params.needsScreenRecording === true) {
    client.sendEvent(
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "permission:screenRecording",
      }),
    );
    client.sendInvokeResponse({
      type: "invoke-res",
      id: frame.id,
      ok: false,
      error: { code: "UNAVAILABLE", message: "PERMISSION_MISSING: screenRecording" },
    });
    return;
  }

  client.sendEvent(
    "exec.started",
    buildExecEventPayload({
      sessionKey,
      runId,
      host: "node",
      command: cmdText,
    }),
  );

  const result = await runCommand(
    argv,
    params.cwd?.trim() || undefined,
    env,
    params.timeoutMs ?? undefined,
  );
  if (result.truncated) {
    const suffix = "... (truncated)";
    if (result.stderr.trim().length > 0) {
      result.stderr = `${result.stderr}\n${suffix}`;
    } else {
      result.stdout = `${result.stdout}\n${suffix}`;
    }
  }
  const combined = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
  client.sendEvent(
    "exec.finished",
    buildExecEventPayload({
      sessionKey,
      runId,
      host: "node",
      command: cmdText,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success: result.success,
      output: combined,
    }),
  );

  client.sendInvokeResponse({
    type: "invoke-res",
    id: frame.id,
    ok: true,
    payloadJSON: JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ?? null,
    }),
  });
}

function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  return JSON.parse(raw) as T;
}
