import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { closeQaHttpServer, handleQaBusRequest, writeError, writeJson } from "./bus-server.js";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import { createQaRunnerRuntime } from "./harness-runtime.js";
import type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabScenarioRun,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";
import type { QaRunnerModelOption } from "./model-catalog.runtime.js";
import {
  createIdleQaRunnerSnapshot,
  createQaRunOutputDir,
  normalizeQaRunSelection,
} from "./run-config.js";
import { qaChannelPlugin, setQaChannelRuntime, type OpenClawConfig } from "./runtime-api.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { runQaSelfCheckAgainstState, type QaSelfCheckResult } from "./self-check.js";

type QaLabBootstrapDefaults = {
  conversationKind: "direct" | "channel";
  conversationId: string;
  senderId: string;
  senderName: string;
};

export type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabScenarioRun,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";

function countQaLabScenarioRun(scenarios: QaLabScenarioOutcome[]) {
  return {
    total: scenarios.length,
    pending: scenarios.filter((scenario) => scenario.status === "pending").length,
    running: scenarios.filter((scenario) => scenario.status === "running").length,
    passed: scenarios.filter((scenario) => scenario.status === "pass").length,
    failed: scenarios.filter((scenario) => scenario.status === "fail").length,
    skipped: scenarios.filter((scenario) => scenario.status === "skip").length,
  };
}

function withQaLabRunCounts(run: Omit<QaLabScenarioRun, "counts">): QaLabScenarioRun {
  return {
    ...run,
    counts: countQaLabScenarioRun(run.scenarios),
  };
}

function injectKickoffMessage(params: {
  state: QaBusState;
  defaults: QaLabBootstrapDefaults;
  kickoffTask: string;
}) {
  return params.state.addInboundMessage({
    conversation: {
      id: params.defaults.conversationId,
      kind: params.defaults.conversationKind,
      ...(params.defaults.conversationKind === "channel"
        ? { title: params.defaults.conversationId }
        : {}),
    },
    senderId: params.defaults.senderId,
    senderName: params.defaults.senderName,
    text: params.kickoffTask,
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as unknown) : {};
}

function detectContentType(filePath: string): string {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "text/html; charset=utf-8";
}

function missingUiHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QA Lab UI Missing</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #f5f7fb; margin: 0; display: grid; place-items: center; min-height: 100vh; }
      main { max-width: 42rem; padding: 2rem; background: #171b22; border: 1px solid #283140; border-radius: 18px; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #9ee8d8; }
      h1 { margin-top: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>QA Lab UI not built</h1>
      <p>Build the private debugger bundle, then reload this page.</p>
      <p><code>pnpm qa:lab:build</code></p>
    </main>
  </body>
</html>`;
}

function resolveUiDistDir(overrideDir?: string | null, repoRoot = process.cwd()) {
  if (overrideDir?.trim()) {
    return overrideDir;
  }
  const candidates = [
    path.resolve(repoRoot, "extensions/qa-lab/web/dist"),
    path.resolve(repoRoot, "dist/extensions/qa-lab/web/dist"),
    fileURLToPath(new URL("../web/dist", import.meta.url)),
  ];
  return (
    candidates.find((candidate) => {
      if (!fs.existsSync(candidate)) {
        return false;
      }
      const indexPath = path.join(candidate, "index.html");
      return fs.existsSync(indexPath) && fs.statSync(indexPath).isFile();
    }) ?? candidates[0]
  );
}

function listUiAssetFiles(rootDir: string, currentDir = rootDir): string[] {
  const entries = fs
    .readdirSync(currentDir, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listUiAssetFiles(rootDir, resolved));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push(path.relative(rootDir, resolved));
  }
  return files;
}

function resolveUiAssetVersion(overrideDir?: string | null): string | null {
  try {
    const distDir = resolveUiDistDir(overrideDir);
    const indexPath = path.join(distDir, "index.html");
    if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) {
      return null;
    }
    const hash = createHash("sha1");
    for (const relativeFile of listUiAssetFiles(distDir)) {
      hash.update(relativeFile);
      hash.update("\0");
      hash.update(fs.readFileSync(path.join(distDir, relativeFile)));
      hash.update("\0");
    }
    return hash.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

function resolveAdvertisedBaseUrl(params: {
  bindHost?: string;
  bindPort: number;
  advertiseHost?: string;
  advertisePort?: number;
}) {
  const advertisedHost =
    params.advertiseHost?.trim() ||
    (params.bindHost && params.bindHost !== "0.0.0.0" ? params.bindHost : "127.0.0.1");
  const advertisedPort =
    typeof params.advertisePort === "number" && Number.isFinite(params.advertisePort)
      ? params.advertisePort
      : params.bindPort;
  return `http://${advertisedHost}:${advertisedPort}`;
}

function createBootstrapDefaults(autoKickoffTarget?: string): QaLabBootstrapDefaults {
  if (autoKickoffTarget === "channel") {
    return {
      conversationKind: "channel",
      conversationId: "qa-lab",
      senderId: "qa-operator",
      senderName: "QA Operator",
    };
  }
  return {
    conversationKind: "direct",
    conversationId: "qa-operator",
    senderId: "qa-operator",
    senderName: "QA Operator",
  };
}

function isControlUiProxyPath(pathname: string) {
  return pathname === "/control-ui" || pathname.startsWith("/control-ui/");
}

function rewriteControlUiProxyPath(pathname: string, search: string) {
  const stripped = pathname === "/control-ui" ? "/" : pathname.slice("/control-ui".length) || "/";
  return `${stripped}${search}`;
}

function rewriteEmbeddedControlUiHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[] | number | undefined> {
  const rewritten: Record<string, string | string[] | number | undefined> = { ...headers };
  delete rewritten["x-frame-options"];

  const csp = headers["content-security-policy"];
  if (typeof csp === "string") {
    rewritten["content-security-policy"] = csp.includes("frame-ancestors")
      ? csp.replace(/frame-ancestors\s+[^;]+/i, "frame-ancestors 'self'")
      : `${csp}; frame-ancestors 'self'`;
  }

  return rewritten;
}

async function proxyHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  target: URL;
  pathname: string;
  search: string;
}) {
  const client = params.target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamReq = client(
    {
      protocol: params.target.protocol,
      hostname: params.target.hostname,
      port: params.target.port || (params.target.protocol === "https:" ? 443 : 80),
      method: params.req.method,
      path: rewriteControlUiProxyPath(params.pathname, params.search),
      headers: {
        ...params.req.headers,
        host: params.target.host,
      },
    },
    (upstreamRes) => {
      params.res.writeHead(
        upstreamRes.statusCode ?? 502,
        rewriteEmbeddedControlUiHeaders(upstreamRes.headers),
      );
      upstreamRes.pipe(params.res);
    },
  );

  upstreamReq.on("error", (error) => {
    if (!params.res.headersSent) {
      writeError(params.res, 502, error);
      return;
    }
    params.res.destroy(error);
  });

  if (params.req.method === "GET" || params.req.method === "HEAD") {
    upstreamReq.end();
    return;
  }
  params.req.pipe(upstreamReq);
}

function proxyUpgradeRequest(params: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  target: URL;
}) {
  const requestUrl = new URL(params.req.url ?? "/", "http://127.0.0.1");
  const port = Number(params.target.port || (params.target.protocol === "https:" ? 443 : 80));
  const upstream =
    params.target.protocol === "https:"
      ? tls.connect({
          host: params.target.hostname,
          port,
          servername: params.target.hostname,
        })
      : net.connect({
          host: params.target.hostname,
          port,
        });

  const headerLines: string[] = [];
  for (let index = 0; index < params.req.rawHeaders.length; index += 2) {
    const name = params.req.rawHeaders[index];
    const value = params.req.rawHeaders[index + 1] ?? "";
    if (normalizeLowercaseStringOrEmpty(name) === "host") {
      continue;
    }
    headerLines.push(`${name}: ${value}`);
  }

  upstream.once("connect", () => {
    const requestText = [
      `${params.req.method ?? "GET"} ${rewriteControlUiProxyPath(requestUrl.pathname, requestUrl.search)} HTTP/${params.req.httpVersion}`,
      `Host: ${params.target.host}`,
      ...headerLines,
      "",
      "",
    ].join("\r\n");
    upstream.write(requestText);
    if (params.head.length > 0) {
      upstream.write(params.head);
    }
    upstream.pipe(params.socket);
    params.socket.pipe(upstream);
  });

  const closeBoth = () => {
    if (!params.socket.destroyed) {
      params.socket.destroy();
    }
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  };

  upstream.on("error", () => {
    if (!params.socket.destroyed) {
      params.socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    closeBoth();
  });
  params.socket.on("error", closeBoth);
  params.socket.on("close", closeBoth);
}

function tryResolveUiAsset(
  pathname: string,
  overrideDir?: string | null,
  repoRoot = process.cwd(),
): string | null {
  const distDir = resolveUiDistDir(overrideDir, repoRoot);
  if (!fs.existsSync(distDir)) {
    return null;
  }
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(safePath);
  const candidate = path.normalize(path.join(distDir, decoded));
  if (!candidate.startsWith(distDir)) {
    return null;
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  const fallback = path.join(distDir, "index.html");
  return fs.existsSync(fallback) ? fallback : null;
}

function createQaLabConfig(baseUrl: string): OpenClawConfig {
  return {
    channels: {
      "qa-channel": {
        enabled: true,
        baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: ["*"],
      },
    },
  };
}

async function startQaGatewayLoop(params: { state: QaBusState; baseUrl: string }) {
  const runtime = createQaRunnerRuntime();
  setQaChannelRuntime(runtime);
  const cfg = createQaLabConfig(params.baseUrl);
  const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();
  const task = qaChannelPlugin.gateway?.startAccount?.({
    accountId: account.accountId,
    account,
    cfg,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    abortSignal: abort.signal,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getStatus: () => ({
      accountId: account.accountId,
      configured: true,
      enabled: true,
      running: true,
    }),
    setStatus: () => undefined,
  });
  return {
    cfg,
    async stop() {
      abort.abort();
      await task;
    },
  };
}

export async function startQaLabServer(
  params?: QaLabServerStartParams,
): Promise<QaLabServerHandle> {
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const state = createQaBusState();
  let latestReport: QaLabLatestReport | null = null;
  let latestScenarioRun: QaLabScenarioRun | null = null;
  const scenarioCatalog = readQaBootstrapScenarioCatalog();
  const bootstrapDefaults = createBootstrapDefaults(params?.autoKickoffTarget);
  let runnerModelOptions: QaRunnerModelOption[] = [];
  let runnerModelCatalogStatus: "loading" | "ready" | "failed" = "loading";
  let runnerSnapshot = createIdleQaRunnerSnapshot(scenarioCatalog.scenarios);
  let activeSuiteRun: Promise<void> | null = null;
  let controlUiProxyTarget = params?.controlUiProxyTarget?.trim()
    ? new URL(params.controlUiProxyTarget)
    : null;
  let controlUiUrl = params?.controlUiUrl?.trim() || null;
  let controlUiToken = params?.controlUiToken?.trim() || null;
  let gateway:
    | {
        cfg: OpenClawConfig;
        stop: () => Promise<void>;
      }
    | undefined;
  const embeddedGatewayEnabled = params?.embeddedGateway !== "disabled";
  let labHandle: QaLabServerHandle | null = null;

  let publicBaseUrl = "";
  let runnerModelCatalogPromise: Promise<void> | null = null;
  let runnerModelCatalogAbort: AbortController | null = null;
  const ensureRunnerModelCatalog = () => {
    if (runnerModelCatalogPromise) {
      return runnerModelCatalogPromise;
    }
    runnerModelCatalogAbort = new AbortController();
    runnerModelCatalogPromise = (async () => {
      try {
        const { loadQaRunnerModelOptions } = await import("./model-catalog.runtime.js");
        runnerModelOptions = await loadQaRunnerModelOptions({
          repoRoot,
          signal: runnerModelCatalogAbort?.signal,
        });
        runnerModelCatalogStatus = "ready";
      } catch {
        runnerModelOptions = [];
        runnerModelCatalogStatus = "failed";
      }
    })().finally(() => {
      runnerModelCatalogAbort = null;
    });
    return runnerModelCatalogPromise;
  };

  async function runSelfCheck(): Promise<QaSelfCheckResult> {
    latestScenarioRun = withQaLabRunCounts({
      kind: "self-check",
      status: "running",
      startedAt: new Date().toISOString(),
      scenarios: [
        {
          id: "qa-self-check",
          name: "Synthetic Slack-class roundtrip",
          status: "running",
        },
      ],
    });
    const result = await runQaSelfCheckAgainstState({
      state,
      cfg: gateway?.cfg ?? createQaLabConfig(listenUrl),
      outputPath: params?.outputPath,
      repoRoot,
    });
    latestScenarioRun = withQaLabRunCounts({
      kind: "self-check",
      status: "completed",
      startedAt: latestScenarioRun.startedAt,
      finishedAt: new Date().toISOString(),
      scenarios: [
        {
          id: "qa-self-check",
          name: result.scenarioResult.name,
          status: result.scenarioResult.status,
          details: result.scenarioResult.details,
          steps: result.scenarioResult.steps,
        },
      ],
    });
    latestReport = {
      outputPath: result.outputPath,
      markdown: result.report,
      generatedAt: new Date().toISOString(),
    };
    return result;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (await handleQaBusRequest({ req, res, state })) {
      return;
    }

    try {
      if (controlUiProxyTarget && isControlUiProxyPath(url.pathname)) {
        await proxyHttpRequest({
          req,
          res,
          target: controlUiProxyTarget,
          pathname: url.pathname,
          search: url.search,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        void ensureRunnerModelCatalog();
        const resolvedControlUiUrl = controlUiProxyTarget
          ? `${publicBaseUrl}/control-ui/`
          : controlUiUrl;
        const controlUiEmbeddedUrl =
          resolvedControlUiUrl && controlUiToken
            ? `${resolvedControlUiUrl.replace(/\/?$/, "/")}#token=${encodeURIComponent(controlUiToken)}`
            : resolvedControlUiUrl;
        writeJson(res, 200, {
          baseUrl: publicBaseUrl,
          latestReport,
          controlUiUrl: resolvedControlUiUrl,
          controlUiEmbeddedUrl,
          kickoffTask: scenarioCatalog.kickoffTask,
          scenarios: scenarioCatalog.scenarios,
          defaults: bootstrapDefaults,
          runner: runnerSnapshot,
          runnerCatalog: {
            status: runnerModelCatalogStatus,
            real: runnerModelOptions,
          },
        });
        return;
      }
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(res, 200, { ok: true, status: "live" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        writeJson(res, 200, state.getSnapshot());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/report") {
        writeJson(res, 200, { report: latestReport });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/ui-version") {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ version: resolveUiAssetVersion(params?.uiDistDir) }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/outcomes") {
        writeJson(res, 200, { run: latestScenarioRun });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        if (activeSuiteRun) {
          writeError(res, 409, "QA suite run already in progress");
          return;
        }
        state.reset();
        latestReport = null;
        latestScenarioRun = null;
        runnerSnapshot = {
          ...runnerSnapshot,
          status: "idle",
          artifacts: null,
          error: null,
          startedAt: undefined,
          finishedAt: undefined,
        };
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/inbound/message") {
        const body = await readJson(req);
        writeJson(res, 200, {
          message: state.addInboundMessage(body as Parameters<QaBusState["addInboundMessage"]>[0]),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/kickoff") {
        writeJson(res, 200, {
          message: injectKickoffMessage({
            state,
            defaults: bootstrapDefaults,
            kickoffTask: scenarioCatalog.kickoffTask,
          }),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/scenario/self-check") {
        if (activeSuiteRun) {
          writeError(res, 409, "QA suite run already in progress");
          return;
        }
        const result = await runSelfCheck();
        writeJson(res, 200, serializeSelfCheck(result));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/scenario/suite") {
        if (activeSuiteRun) {
          writeError(res, 409, "QA suite run already in progress");
          return;
        }
        const selection = normalizeQaRunSelection(await readJson(req), scenarioCatalog.scenarios);
        state.reset();
        latestReport = null;
        latestScenarioRun = null;
        const startedAt = new Date().toISOString();
        runnerSnapshot = {
          status: "running",
          selection,
          startedAt,
          finishedAt: undefined,
          artifacts: null,
          error: null,
        };
        activeSuiteRun = (async () => {
          try {
            const { runQaSuite } = await import("./suite.js");
            const result = await runQaSuite({
              lab: labHandle ?? undefined,
              outputDir: createQaRunOutputDir(repoRoot),
              providerMode: selection.providerMode,
              primaryModel: selection.primaryModel,
              alternateModel: selection.alternateModel,
              scenarioIds: selection.scenarioIds,
            });
            runnerSnapshot = {
              status: "completed",
              selection,
              startedAt,
              finishedAt: new Date().toISOString(),
              artifacts: {
                outputDir: result.outputDir,
                reportPath: result.reportPath,
                summaryPath: result.summaryPath,
                watchUrl: result.watchUrl,
              },
              error: null,
            };
          } catch (error) {
            runnerSnapshot = {
              status: "failed",
              selection,
              startedAt,
              finishedAt: new Date().toISOString(),
              artifacts: null,
              error: formatErrorMessage(error),
            };
          } finally {
            activeSuiteRun = null;
          }
        })();
        writeJson(res, 202, {
          ok: true,
          runner: runnerSnapshot,
        });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        writeError(res, 404, "not found");
        return;
      }

      const asset = tryResolveUiAsset(url.pathname, params?.uiDistDir, repoRoot);
      if (!asset) {
        const html = missingUiHtml();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(html);
        return;
      }

      const body = fs.readFileSync(asset);
      res.writeHead(200, {
        "content-type": detectContentType(asset),
        "content-length": body.byteLength,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(body);
    } catch (error) {
      writeError(res, 500, error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params?.port ?? 0, params?.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("qa-lab failed to bind");
  }
  const listenUrl = resolveAdvertisedBaseUrl({
    bindHost: params?.host ?? "127.0.0.1",
    bindPort: address.port,
  });
  publicBaseUrl = resolveAdvertisedBaseUrl({
    bindHost: params?.host ?? "127.0.0.1",
    bindPort: address.port,
    advertiseHost: params?.advertiseHost,
    advertisePort: params?.advertisePort,
  });
  if (embeddedGatewayEnabled) {
    gateway = await startQaGatewayLoop({ state, baseUrl: listenUrl });
  }
  if (params?.sendKickoffOnStart) {
    injectKickoffMessage({
      state,
      defaults: bootstrapDefaults,
      kickoffTask: scenarioCatalog.kickoffTask,
    });
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!controlUiProxyTarget || !isControlUiProxyPath(url.pathname)) {
      socket.destroy();
      return;
    }
    proxyUpgradeRequest({
      req,
      socket,
      head,
      target: controlUiProxyTarget,
    });
  });

  const lab = {
    baseUrl: publicBaseUrl,
    listenUrl,
    state,
    setControlUi(next: {
      controlUiUrl?: string | null;
      controlUiToken?: string | null;
      controlUiProxyTarget?: string | null;
    }) {
      controlUiUrl = next.controlUiUrl?.trim() || null;
      controlUiToken = next.controlUiToken?.trim() || null;
      controlUiProxyTarget = next.controlUiProxyTarget?.trim()
        ? new URL(next.controlUiProxyTarget)
        : null;
    },
    setScenarioRun(next: Omit<QaLabScenarioRun, "counts"> | null) {
      latestScenarioRun = next ? withQaLabRunCounts(next) : null;
    },
    setLatestReport(next: QaLabLatestReport | null) {
      latestReport = next;
    },
    runSelfCheck,
    async stop() {
      runnerModelCatalogAbort?.abort();
      await runnerModelCatalogPromise?.catch(() => undefined);
      await gateway?.stop();
      await closeQaHttpServer(server);
    },
  };
  labHandle = lab;
  return lab;
}

function serializeSelfCheck(result: QaSelfCheckResult) {
  return {
    outputPath: result.outputPath,
    report: result.report,
    checks: result.checks,
    scenario: result.scenarioResult,
  };
}
