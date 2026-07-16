// Qa Lab plugin module implements lab server behavior.
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  acquireDebugProxyCaptureStore,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import {
  closeQaHttpServer,
  handleQaBusRequest,
  isQaMalformedJsonBodyError,
  readQaJsonBody,
  writeError,
  writeJson,
  writeQaRequestBodyLimitError,
} from "./bus-server.js";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import {
  QaEvidenceGalleryError,
  buildQaEvidenceGalleryModel,
  resolveQaEvidenceArtifactFileByIndex,
  resolveQaEvidenceArtifactFile,
  resolveQaEvidenceProducerFile,
} from "./evidence-gallery.js";
import { createQaRunnerRuntime } from "./harness-runtime.js";
import {
  isCaptureQueryPreset,
  mapCaptureEventForQa,
  probeTcpReachability,
} from "./lab-server-capture.js";
import {
  detectContentType,
  isControlUiProxyPath,
  missingUiHtml,
  proxyHttpRequest,
  proxyUpgradeRequest,
  resolveAdvertisedBaseUrl,
  resolveUiAssetVersion,
  tryResolveUiAsset,
} from "./lab-server-ui.js";
import type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabScenarioRun,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";
import type { QaRunnerModelOption } from "./model-catalog.runtime.js";
import { createQaChannelGatewayConfig } from "./qa-channel-transport.js";
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

function writeQaLabServerError(res: Parameters<typeof writeError>[0], error: unknown): void {
  if (writeQaRequestBodyLimitError(res, error)) {
    return;
  }
  if (isQaMalformedJsonBodyError(error)) {
    writeError(res, 400, error.message);
    return;
  }
  if (error instanceof QaEvidenceGalleryError) {
    writeError(res, error.statusCode, error.message);
    return;
  }
  writeError(res, 500, error);
}

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

function parseQaEvidenceArtifactIndexText(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new QaEvidenceGalleryError("Evidence artifact index is invalid.", 400);
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index) || String(index) !== value) {
    throw new QaEvidenceGalleryError("Evidence artifact index is invalid.", 400);
  }
  return index;
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

const CONTROL_UI_CREDENTIAL_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "devicetoken",
  "id_token",
  "password",
  "refresh_token",
  "token",
]);
const CONTROL_UI_CREDENTIAL_QUERY_PATTERN =
  /([?&])(?:access_token|api_?key|auth|deviceToken|id_token|password|refresh_token|token)=[^&#\s]*&?/gi;

function stripSensitiveQueryParamsFromText(rawUrl: string): string {
  let sanitized = rawUrl;
  for (;;) {
    const next = sanitized
      .replace(CONTROL_UI_CREDENTIAL_QUERY_PATTERN, (match: string, separator: string) =>
        match.endsWith("&") ? separator : "",
      )
      .replace(/[?&]$/, "")
      .replace("?&", "?");
    if (next === sanitized) {
      return next;
    }
    sanitized = next;
  }
}

function stripSensitiveQueryParams(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (CONTROL_UI_CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return stripSensitiveQueryParamsFromText(rawUrl);
  }
}

function sanitizeControlUiPublicUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  const fragmentIndex = url.indexOf("#");
  const withoutFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
  return stripSensitiveQueryParams(withoutFragment);
}

function createQaLabConfig(baseUrl: string): OpenClawConfig {
  return createQaChannelGatewayConfig({ baseUrl });
}

function normalizeQaLabCleanupError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatErrorMessage(error));
}

function detectQaEvidenceArtifactContentType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".webm")) {
    return "video/webm";
  }
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (lower.endsWith(".mov")) {
    return "video/quicktime";
  }
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) {
    return "application/json; charset=utf-8";
  }
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

async function startQaGatewayLoop(params: { state: QaBusState; baseUrl: string }) {
  const runtime = createQaRunnerRuntime();
  setQaChannelRuntime(runtime);
  const cfg = createQaLabConfig(params.baseUrl);
  const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();
  const task = Promise.resolve().then(
    async () =>
      await qaChannelPlugin.gateway?.startAccount?.({
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
      }),
  );
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
  const captureSettings = resolveDebugProxySettings();
  const captureStoreLease = acquireDebugProxyCaptureStore();
  const captureStore = captureStoreLease.store;
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
  let controlUiProxyToken = params?.controlUiProxyToken?.trim() || null;
  let controlUiUrl = sanitizeControlUiPublicUrl(params?.controlUiUrl?.trim() || null);
  let gateway:
    | {
        cfg: OpenClawConfig;
        stop: () => Promise<void>;
      }
    | undefined;
  const embeddedGatewayEnabled = params?.embeddedGateway !== "disabled";
  let labHandle: QaLabServerHandle | null = null;
  let captureStoreReleased = false;
  let serverListening = false;

  let listenUrl = "";
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
      transportId: "qa-channel",
      outputPath: params?.outputPath,
      repoRoot,
      waitTimeoutMs: params?.selfCheckWaitTimeoutMs,
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

  const server = createServer((req, res) => {
    void (async () => {
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
            authorizationToken: controlUiProxyToken,
          });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/bootstrap") {
          void ensureRunnerModelCatalog();
          const resolvedControlUiUrl = controlUiProxyTarget
            ? `${publicBaseUrl}/control-ui/`
            : controlUiUrl;
          const safeControlUiUrl = sanitizeControlUiPublicUrl(resolvedControlUiUrl);
          writeJson(res, 200, {
            baseUrl: publicBaseUrl,
            latestReport,
            controlUiUrl: safeControlUiUrl,
            controlUiEmbeddedUrl: safeControlUiUrl,
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
          res.end(JSON.stringify({ version: resolveUiAssetVersion(params?.uiDistDir, repoRoot) }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/outcomes") {
          writeJson(res, 200, { run: latestScenarioRun });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/evidence") {
          const evidencePath =
            url.searchParams.get("path")?.trim() || runnerSnapshot.artifacts?.evidencePath;
          if (!evidencePath) {
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(JSON.stringify({ evidence: null }));
            return;
          }
          // Build the model before sending any headers so a thrown QaEvidenceGalleryError
          // still routes through writeQaLabServerError (writing headers first would make the
          // error response throw ERR_HTTP_HEADERS_SENT and reset the connection).
          const evidence = await buildQaEvidenceGalleryModel({ evidencePath, repoRoot });
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ evidence }));
          return;
        }
        if (
          (req.method === "GET" || req.method === "HEAD") &&
          url.pathname === "/api/evidence/artifact"
        ) {
          const evidencePath = url.searchParams.get("evidencePath")?.trim();
          const artifactPath = url.searchParams.get("artifactPath")?.trim();
          const producerFile = url.searchParams.get("producerFile")?.trim();
          const entryIndexText = url.searchParams.get("entryIndex");
          const artifactIndexText = url.searchParams.get("artifactIndex");
          if (
            !evidencePath ||
            (!artifactPath && !producerFile && (!entryIndexText || !artifactIndexText))
          ) {
            writeError(res, 400, "Missing evidencePath and artifact selector");
            return;
          }
          const artifactFile = artifactPath
            ? await resolveQaEvidenceArtifactFile({
                artifactPath,
                evidencePath,
                repoRoot,
              })
            : producerFile
              ? await resolveQaEvidenceProducerFile({
                  evidencePath,
                  producerFile,
                  repoRoot,
                })
              : await resolveQaEvidenceArtifactFileByIndex({
                  artifactIndex: parseQaEvidenceArtifactIndexText(artifactIndexText!),
                  entryIndex: parseQaEvidenceArtifactIndexText(entryIndexText!),
                  evidencePath,
                  repoRoot,
                });
          const artifactStats = await fs.promises.stat(artifactFile);
          res.writeHead(200, {
            "content-type": detectQaEvidenceArtifactContentType(artifactFile),
            "content-length": artifactStats.size,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          fs.createReadStream(artifactFile)
            .on("error", (error) => res.destroy(normalizeQaLabCleanupError(error)))
            .pipe(res);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/sessions") {
          writeJson(res, 200, {
            sessions: captureStore.listSessions(50),
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/startup-status") {
          const proxyUrl = captureSettings.proxyUrl || "http://127.0.0.1:7799";
          const gatewayUrl = controlUiUrl || "http://127.0.0.1:18789/";
          const [proxy, gatewayLocal] = await Promise.all([
            probeTcpReachability(proxyUrl),
            probeTcpReachability(gatewayUrl),
          ]);
          writeJson(res, 200, {
            status: {
              proxy: {
                ...proxy,
                label: "Proxy",
              },
              gateway: {
                ...gatewayLocal,
                label: "Gateway",
              },
              qaLab: {
                label: "QA Lab",
                url: publicBaseUrl,
                ok: true,
              },
            },
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/events") {
          const sessionId = url.searchParams.get("sessionId")?.trim();
          writeJson(res, 200, {
            events: sessionId
              ? captureStore.getSessionEvents(sessionId, 200).map(mapCaptureEventForQa)
              : [],
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/coverage") {
          const sessionId = url.searchParams.get("sessionId")?.trim();
          if (!sessionId) {
            writeError(res, 400, "Missing sessionId");
            return;
          }
          writeJson(res, 200, {
            coverage: captureStore.summarizeSessionCoverage(sessionId),
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/query") {
          const preset = url.searchParams.get("preset")?.trim();
          const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
          if (!preset) {
            writeError(res, 400, "Missing preset");
            return;
          }
          if (!isCaptureQueryPreset(preset)) {
            writeError(res, 400, "Unknown preset");
            return;
          }
          writeJson(res, 200, {
            rows: captureStore.queryPreset(preset, sessionId),
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/capture/blob") {
          const blobId = url.searchParams.get("id")?.trim();
          if (!blobId) {
            writeError(res, 400, "Missing blob id");
            return;
          }
          const content = captureStore.readBlob(blobId);
          if (content == null) {
            writeError(res, 404, "Blob not found");
            return;
          }
          writeJson(res, 200, { id: blobId, content });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/capture/delete-sessions") {
          const body = (await readQaJsonBody(req)) as { sessionIds?: unknown };
          const sessionIds = Array.isArray(body.sessionIds)
            ? body.sessionIds.filter((value): value is string => typeof value === "string")
            : [];
          writeJson(res, 200, {
            result: captureStore.deleteSessions(sessionIds),
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/capture/purge") {
          writeJson(res, 200, {
            result: captureStore.purgeAll(),
          });
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
          const body = await readQaJsonBody(req);
          writeJson(res, 200, {
            message: state.addInboundMessage(
              body as Parameters<QaBusState["addInboundMessage"]>[0],
            ),
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
          const selection = normalizeQaRunSelection(
            await readQaJsonBody(req),
            scenarioCatalog.scenarios,
          );
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
              const { runQaFlowSuite } = await import("./suite.js");
              const result = await runQaFlowSuite({
                lab: labHandle ?? undefined,
                startLab: startQaLabServer,
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
                  evidencePath: result.evidencePath,
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
        writeQaLabServerError(res, error);
      }
    })();
  });

  const releaseCaptureStore = () => {
    if (captureStoreReleased) {
      return;
    }
    captureStoreReleased = true;
    captureStoreLease.release();
  };

  const stopLabServerResources = async (): Promise<Error | undefined> => {
    runnerModelCatalogAbort?.abort();
    await runnerModelCatalogPromise?.catch(() => undefined);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => gateway?.stop()),
      Promise.resolve().then(() => (serverListening ? closeQaHttpServer(server) : undefined)),
      Promise.resolve().then(releaseCaptureStore),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    return failed ? normalizeQaLabCleanupError(failed.reason) : undefined;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(params?.port ?? 0, params?.host ?? "127.0.0.1", () => resolve());
    });
    serverListening = true;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("qa-lab failed to bind");
    }
    listenUrl = resolveAdvertisedBaseUrl({
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
        authorizationToken: controlUiProxyToken,
      });
    });

    const lab = {
      baseUrl: publicBaseUrl,
      listenUrl,
      state,
      setControlUi(next: {
        controlUiUrl?: string | null;
        controlUiProxyToken?: string | null;
        controlUiProxyTarget?: string | null;
      }) {
        controlUiUrl = sanitizeControlUiPublicUrl(next.controlUiUrl?.trim() || null);
        controlUiProxyToken = next.controlUiProxyToken?.trim() || null;
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
        const cleanupError = await stopLabServerResources();
        if (cleanupError) {
          throw cleanupError;
        }
      },
    };
    labHandle = lab;
    return lab;
  } catch (error) {
    await stopLabServerResources().catch(() => undefined);
    throw error;
  }
}

function serializeSelfCheck(result: QaSelfCheckResult) {
  return {
    outputPath: result.outputPath,
    report: result.report,
    checks: result.checks,
    scenario: result.scenarioResult,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
