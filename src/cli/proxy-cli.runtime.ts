import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRuntimeConfig } from "../config/config.js";
import {
  runProxyValidation,
  type ProxyValidationResult,
} from "../infra/net/proxy/proxy-validation.js";
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
import { colorize, isRich, theme } from "../terminal/theme.js";

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

function redactProxyUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "redacted";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid proxy URL>";
  }
}

function redactProxyValidationResult(result: ProxyValidationResult): ProxyValidationResult {
  return {
    ...result,
    config: {
      ...result.config,
      proxyUrl: redactProxyUrl(result.config.proxyUrl),
    },
  };
}

type ProxyValidationTextColors = {
  heading: (value: string) => string;
  success: (value: string) => string;
  error: (value: string) => string;
  muted: (value: string) => string;
  warn: (value: string) => string;
};

function getProxyValidationTextColors(): ProxyValidationTextColors {
  const rich = isRich();
  const apply = (color: (value: string) => string) => (value: string) =>
    colorize(rich, color, value);
  return {
    heading: apply(theme.heading),
    success: apply(theme.success),
    error: apply(theme.error),
    muted: apply(theme.muted),
    warn: apply(theme.warn),
  };
}

function formatProxyCheckLine(
  check: ProxyValidationResult["checks"][number],
  colors: ProxyValidationTextColors,
): string {
  const icon = check.ok ? colors.success("✓") : colors.error("✗");
  const paddedKind = colors.muted(check.kind.padEnd(7, " "));
  const status =
    check.status === undefined
      ? ""
      : ` ${check.ok ? colors.success(`HTTP ${check.status}`) : colors.error(`HTTP ${check.status}`)}`;
  const detail = check.error
    ? ` — ${check.ok ? colors.muted(check.error) : colors.error(check.error)}`
    : "";
  return `  ${icon} ${paddedKind} ${check.url}${status}${detail}`;
}

function formatProxyValidationNextSteps(result: ProxyValidationResult): string[] {
  if (result.ok) {
    return [];
  }
  if (result.config.errors.some((error) => error.includes("proxy.enabled"))) {
    return [
      "Enable proxy.enabled with proxy.proxyUrl or OPENCLAW_PROXY_URL, or pass --proxy-url for an explicit one-off validation.",
    ];
  }
  if (result.config.errors.length > 0) {
    return [
      "Fix proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url so it uses a reachable http:// proxy.",
    ];
  }
  if (result.checks.some((check) => !check.ok && check.kind === "allowed")) {
    return [
      "Confirm the proxy is reachable from this deployment context and permits the allowed destinations.",
    ];
  }
  if (result.checks.some((check) => !check.ok && check.kind === "denied")) {
    return [
      "Update the proxy ACL so denied destinations are blocked, or pass the expected --denied-url values.",
    ];
  }
  return [
    "Review the failed checks above and update proxy configuration or validation destinations.",
  ];
}

function formatProxyValidationText(result: ProxyValidationResult): string {
  const colors = getProxyValidationTextColors();
  const redactedProxyUrl = redactProxyUrl(result.config.proxyUrl);
  const lines = [
    result.ok ? colors.success("Proxy validation passed") : colors.error("Proxy validation failed"),
    "",
    colors.heading("Proxy"),
    `  Source: ${colors.muted(result.config.source)}`,
    `  URL:    ${redactedProxyUrl ?? colors.muted("not configured")}`,
  ];

  if (result.config.errors.length > 0) {
    lines.push("", colors.heading("Problems"));
    for (const error of result.config.errors) {
      lines.push(`  - ${colors.error(error)}`);
    }
  }

  if (result.checks.length > 0) {
    lines.push("", colors.heading("Checks"));
    for (const check of result.checks) {
      lines.push(formatProxyCheckLine(check, colors));
    }
  }

  const nextSteps = formatProxyValidationNextSteps(result);
  if (nextSteps.length > 0) {
    lines.push("", colors.heading("Next steps"));
    for (const nextStep of nextSteps) {
      lines.push(`  ${colors.warn(nextStep)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runProxyValidateCommand(opts: {
  json?: boolean;
  proxyUrl?: string;
  allowedUrls?: string[];
  deniedUrls?: string[];
  apnsReachability?: boolean;
  apnsAuthority?: string;
  timeoutMs?: number;
}) {
  const config = getRuntimeConfig();
  const result = await runProxyValidation({
    config: config?.proxy,
    env: process.env,
    proxyUrlOverride: opts.proxyUrl,
    allowedUrls: opts.allowedUrls,
    deniedUrls: opts.deniedUrls,
    apnsReachability: opts.apnsReachability,
    apnsAuthority: opts.apnsAuthority,
    timeoutMs: opts.timeoutMs,
  });
  const outputResult = redactProxyValidationResult(result);
  process.stdout.write(
    opts.json === true
      ? `${JSON.stringify(outputResult, null, 2)}\n`
      : formatProxyValidationText(outputResult),
  );
  if (!result.ok) {
    process.exitCode = 1;
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
