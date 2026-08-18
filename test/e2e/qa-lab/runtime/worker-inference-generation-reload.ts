import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import {
  QA_EVIDENCE_FILENAME,
  startQaGatewayChild,
  startQaMockOpenAiServer,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  MODEL_REF as DEFAULT_MOCK_MODEL_REF,
  PROOF_TIMEOUT_MS,
  waitFor,
} from "./cloud-worker-midturn-loss-fixture.js";
import workerGenerationProviderFixture from "./fixtures/worker-inference-generation-provider/index.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  type PairedNodeWorkerHost,
  type PublishedWireWorkspace,
  type WireGateway,
  wireMessageText,
} from "./paired-node-worker-wire-fixture.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "worker-inference-generation-reload";
const VERDICT_FILE = `${SCENARIO_ID}-verdict.json`;
const PLUGIN_ID = "qa-worker-generation";
const PROVIDER_ID = PLUGIN_ID;
const MODEL_ID = "qa-worker-generation-model";
const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;
const SESSION_KEY = "agent:qa:worker-inference-generation-reload";
const SOURCE_CREDENTIAL_PREFIX = "qa-worker-source";
const GENERATION_A_REPLY = "WORKER-GENERATION-A-OK";
const GENERATION_B_REPLY = "WORKER-GENERATION-B-OK";
const GENERATION_C_REPLY = "WORKER-GENERATION-C-OK";
const OWNERSHIP_STAGES = ["factory", "policy", "wrapper", "execution"] as const;

type Generation = "A" | "B" | "C";
type ProducerOptions = { artifactBase: string; repoRoot: string };
type TraceEvent = {
  event: string;
  generation: Generation;
  at: number;
  waited?: boolean;
  authPresent?: boolean;
  baseUrlMatchesGeneration?: boolean;
  modelGenerationMatches?: boolean;
  sourceAuthMatchesGeneration?: boolean;
  streamPresent?: boolean;
};
type TurnResult = { runId?: string; status?: string; summary?: string };

function parseOptions(argv: readonly string[]): ProducerOptions {
  const index = argv.indexOf("--artifact-base");
  const artifactBase = index >= 0 ? argv[index + 1] : undefined;
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(artifactBase), repoRoot: process.cwd() };
}

async function readTrace(tracePath: string): Promise<TraceEvent[]> {
  return await fs
    .readFile(tracePath, "utf8")
    .then((text) =>
      text
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TraceEvent),
    )
    .catch(() => []);
}

function classifyAuthorization(value: string | undefined): Generation | "unknown" {
  const credential = value?.replace(/^Bearer\s+/iu, "");
  for (const generation of ["A", "B", "C"] as const) {
    if (credential === `qa-worker-runtime-${generation}`) {
      return generation;
    }
  }
  return "unknown";
}

async function startAuthInspectingProxy(targetBaseUrl: string) {
  const authGenerations: Array<Generation | "unknown"> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const body = Buffer.concat(chunks);
      if (request.method === "POST") {
        authGenerations.push(classifyAuthorization(request.headers.authorization));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || ["connection", "content-length", "host"].includes(name)) {
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const upstream = await fetch(new URL(request.url ?? "/", targetBaseUrl), {
        method: request.method,
        headers,
        ...(body.length > 0 ? { body } : {}),
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!["connection", "content-length", "transfer-encoding"].includes(name)) {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, responseHeaders);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch((error) => {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("worker auth inspection proxy did not bind");
  }
  return {
    authGenerations,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function buildGenerationConfig(params: {
  config: OpenClawConfig;
  generation: Generation;
  pluginDir: string;
  tracePath: string;
  barrierPath: string;
  mockProviderBaseUrl: string;
}): OpenClawConfig {
  const { config, generation, pluginDir, tracePath, barrierPath, mockProviderBaseUrl } = params;
  const providerConfig = config.models?.providers?.[PROVIDER_ID];
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), pluginDir])],
      },
      entries: {
        ...config.plugins?.entries,
        [PLUGIN_ID]: {
          ...config.plugins?.entries?.[PLUGIN_ID],
          enabled: true,
          config: {
            generation,
            tracePath,
            barrierPath,
            mockProviderBaseUrl,
          },
        },
      },
    },
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        [PROVIDER_ID]: {
          ...providerConfig,
          api: "openai-responses",
          apiKey: `${SOURCE_CREDENTIAL_PREFIX}-${generation}`,
          baseUrl: mockProviderBaseUrl,
          request: { ...providerConfig?.request, allowPrivateNetwork: true },
          models: [
            {
              id: MODEL_ID,
              name: "QA worker generation model",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_768,
              contextTokens: 32_768,
              maxTokens: 256,
            },
          ],
        },
      },
    },
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        model: { primary: MODEL_REF, fallbacks: [] },
        models: {
          ...config.agents?.defaults?.models,
          [MODEL_REF]: { agentRuntime: { id: "openclaw" } },
        },
      },
    },
    nodeHost: {
      ...config.nodeHost,
      workerRuns: { enabled: true },
    },
  };
}

async function hotPublishGeneration(params: {
  gateway: WireGateway;
  tracePath: string;
  generation: Exclude<Generation, "A">;
}): Promise<{ pidBefore: number; pidAfter: number }> {
  const before = (await params.gateway.call("system.info", {})) as { pid?: number };
  const config = JSON.parse(await fs.readFile(params.gateway.configPath, "utf8")) as OpenClawConfig;
  const pluginEntry = config.plugins?.entries?.[PLUGIN_ID];
  const providerConfig = config.models?.providers?.[PROVIDER_ID];
  if (!pluginEntry?.config || !providerConfig) {
    throw new Error("generation A config was not installed before hot publish");
  }
  const next: OpenClawConfig = {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [PLUGIN_ID]: {
          ...pluginEntry,
          config: { ...pluginEntry.config, generation: params.generation },
        },
      },
    },
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        [PROVIDER_ID]: {
          ...providerConfig,
          apiKey: `${SOURCE_CREDENTIAL_PREFIX}-${params.generation}`,
        },
      },
    },
  };
  await fs.writeFile(params.gateway.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await waitFor(`generation ${params.generation} provider registration`, async () => {
    const registrations = (await readTrace(params.tracePath)).filter(
      (event) => event.event === "registered" && event.generation === params.generation,
    );
    return registrations.length > 0 ? registrations : undefined;
  });
  const after = (await params.gateway.call("system.info", {})) as { pid?: number };
  if (!Number.isSafeInteger(before.pid) || after.pid !== before.pid) {
    throw new Error(
      `generation ${params.generation} hot publish replaced the Gateway: ${before.pid} -> ${after.pid}`,
    );
  }
  return { pidBefore: before.pid!, pidAfter: after.pid! };
}

async function startTurn(operator: GatewayClient, reply: string): Promise<string> {
  const runId = `${SCENARIO_ID}-${randomUUID()}`;
  const started = await operator.request<TurnResult>("chat.send", {
    sessionKey: SESSION_KEY,
    message: `Reply exactly: ${reply}`,
    deliver: false,
    idempotencyKey: runId,
  });
  if (started.status !== "started" || started.runId !== runId) {
    throw new Error(`chat.send did not start ${reply}: ${JSON.stringify(started)}`);
  }
  return runId;
}

async function waitForTurn(operator: GatewayClient, runId: string): Promise<void> {
  const result = await operator.request<TurnResult>(
    "agent.wait",
    { runId, timeoutMs: PROOF_TIMEOUT_MS },
    { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
  );
  if (result.status !== "ok") {
    throw new Error(`worker turn failed: ${JSON.stringify(result)}`);
  }
}

async function readHistoryReplyCounts(operator: GatewayClient): Promise<Record<string, number>> {
  const history = await operator.request<{ messages?: unknown[] }>("chat.history", {
    sessionKey: SESSION_KEY,
    limit: 100,
  });
  return Object.fromEntries(
    [GENERATION_A_REPLY, GENERATION_B_REPLY, GENERATION_C_REPLY].map((reply) => [
      reply,
      (history.messages ?? []).filter(
        (message) =>
          (message as { role?: unknown }).role === "assistant" &&
          wireMessageText(message) === reply,
      ).length,
    ]),
  );
}

async function waitForHistoryReply(operator: GatewayClient, reply: string): Promise<void> {
  await waitFor(`one worker history reply ${reply}`, async () => {
    const count = (await readHistoryReplyCounts(operator))[reply] ?? 0;
    if (count > 1) {
      throw new Error(`worker history persisted ${count} copies of ${reply}`);
    }
    return count === 1 ? true : undefined;
  });
}

function requireGenerationOwnership(params: {
  events: readonly TraceEvent[];
  generation: Generation;
  waited: boolean;
}) {
  const authEvents = params.events.filter((event) => event.event === "auth-prepare");
  const authReadyEvents = params.events.filter((event) => event.event === "auth-ready");
  const stages = params.events.filter((event) =>
    OWNERSHIP_STAGES.includes(event.event as (typeof OWNERSHIP_STAGES)[number]),
  );
  if (
    authEvents.length !== 1 ||
    authEvents[0]?.generation !== params.generation ||
    authEvents[0]?.waited !== params.waited ||
    authEvents[0]?.modelGenerationMatches !== true ||
    authEvents[0]?.sourceAuthMatchesGeneration !== true ||
    authReadyEvents.length !== 1 ||
    authReadyEvents[0]?.generation !== params.generation
  ) {
    throw new Error(
      `unexpected ${params.generation} auth preparation: ${JSON.stringify(authEvents)}`,
    );
  }
  if (
    stages.length !== OWNERSHIP_STAGES.length ||
    stages.some(
      (event, index) =>
        event.event !== OWNERSHIP_STAGES[index] || event.generation !== params.generation,
    )
  ) {
    throw new Error(`worker inference crossed provider generations: ${JSON.stringify(stages)}`);
  }
  const [factory, policy, wrapper, execution] = stages;
  if (
    factory?.modelGenerationMatches !== true ||
    policy?.modelGenerationMatches !== true ||
    wrapper?.modelGenerationMatches !== true ||
    wrapper?.streamPresent !== true ||
    execution?.modelGenerationMatches !== true ||
    execution?.authPresent !== true ||
    execution?.baseUrlMatchesGeneration !== true
  ) {
    throw new Error(`worker inference ownership facts were incomplete: ${JSON.stringify(stages)}`);
  }
  return stages.map((event) => `${event.event}:${event.generation}`);
}

async function readMockRequests(baseUrl: string) {
  const response = await fetch(`${baseUrl}/debug/requests?after=0`);
  if (!response.ok) {
    throw new Error(`mock request inspection failed: HTTP ${response.status}`);
  }
  return (await response.json()) as Array<{
    model?: string;
    outcome?: string;
    allInputText?: string;
  }>;
}

async function runProof(options: ProducerOptions) {
  if (workerGenerationProviderFixture.id !== PLUGIN_ID) {
    throw new Error("worker generation fixture id does not match its configured plugin id");
  }
  // openclaw-temp-dir: standalone QA producer owns and removes this fixture root.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-generation-"));
  const tracePath = path.join(options.artifactBase, `${SCENARIO_ID}-trace.jsonl`);
  const barrierPath = path.join(root, "auth-preparation-barrier");
  const pluginDir = path.join(
    options.repoRoot,
    "test/e2e/qa-lab/runtime/fixtures/worker-inference-generation-provider",
  );
  const mock = await startQaMockOpenAiServer({ modelRefs: [MODEL_REF] });
  const authProxy = await startAuthInspectingProxy(mock.baseUrl);
  let gateway: WireGateway | undefined;
  let operator: GatewayClient | undefined;
  let worker: PairedNodeWorkerHost | undefined;
  let published: PublishedWireWorkspace | undefined;
  let proofError: unknown;
  let verdict: Record<string, unknown> | undefined;
  try {
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.rm(tracePath, { force: true });
    await fs.writeFile(barrierPath, "released\n", "utf8");
    published = await createPublishedWireWorkspace(root);
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${authProxy.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: DEFAULT_MOCK_MODEL_REF,
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      mutateConfig: (config) =>
        buildGenerationConfig({
          config,
          generation: "A",
          pluginDir,
          tracePath,
          barrierPath,
          mockProviderBaseUrl: `${authProxy.baseUrl}/v1`,
        }),
    });
    await waitFor("generation A provider registration", async () => {
      const registrations = (await readTrace(tracePath)).filter(
        (event) => event.event === "registered" && event.generation === "A",
      );
      return registrations.length > 0 ? registrations : undefined;
    });
    operator = await connectWireClient({ gateway, role: "operator", identity: null });
    worker = await createPairedNodeWorkerHost({ gateway, operator, root, bundlePrewarm: true });
    await operator.request("sessions.create", {
      key: SESSION_KEY,
      agentId: "qa",
      worktree: true,
      worktreeName: `worker-generation-${randomUUID().slice(0, 8)}`,
      worktreeBaseRef: "main",
      cwd: published.source,
    });
    const dispatched = (await gateway.call(
      "sessions.dispatch",
      { key: SESSION_KEY, deviceId: worker.identity.deviceId },
      { timeoutMs: PROOF_TIMEOUT_MS },
    )) as { placement?: { state?: string; environmentId?: string; generation?: number } };
    if (dispatched.placement?.state !== "active") {
      throw new Error(`worker session did not dispatch: ${JSON.stringify(dispatched)}`);
    }

    const traceCursorA = (await readTrace(tracePath)).length;
    const runA = await startTurn(operator, GENERATION_A_REPLY);
    await waitForTurn(operator, runA);
    await waitForHistoryReply(operator, GENERATION_A_REPLY);
    const eventsA = (await readTrace(tracePath)).slice(traceCursorA);
    const stagesA = requireGenerationOwnership({ events: eventsA, generation: "A", waited: false });

    const hotPublishB = await hotPublishGeneration({ gateway, tracePath, generation: "B" });
    await fs.writeFile(barrierPath, "armed\n", "utf8");
    const traceCursorB = (await readTrace(tracePath)).length;
    const runB = await startTurn(operator, GENERATION_B_REPLY);
    await waitFor("generation B auth preparation barrier", async () => {
      const events = (await readTrace(tracePath)).slice(traceCursorB);
      return events.some((event) => event.event === "auth-prepare" && event.waited === true)
        ? events
        : undefined;
    });
    const hotPublishC = await hotPublishGeneration({ gateway, tracePath, generation: "C" });
    await fs.writeFile(barrierPath, "released\n", "utf8");
    await waitForTurn(operator, runB);
    await waitForHistoryReply(operator, GENERATION_B_REPLY);
    const eventsB = (await readTrace(tracePath)).slice(traceCursorB);
    const stagesB = requireGenerationOwnership({ events: eventsB, generation: "B", waited: true });
    if (
      !eventsB.some((event) => event.event === "auth-prepare-released" && event.generation === "B")
    ) {
      throw new Error("generation B auth preparation did not resume after generation C published");
    }

    const traceCursorC = (await readTrace(tracePath)).length;
    const runC = await startTurn(operator, GENERATION_C_REPLY);
    await waitForTurn(operator, runC);
    await waitForHistoryReply(operator, GENERATION_C_REPLY);
    const eventsC = (await readTrace(tracePath)).slice(traceCursorC);
    const stagesC = requireGenerationOwnership({ events: eventsC, generation: "C", waited: false });

    const requests = await readMockRequests(mock.baseUrl);
    const requestFacts = requests.map((request) => ({
      model: request.model,
      outcome: request.outcome,
      generationA: String(request.allInputText ?? "").includes(GENERATION_A_REPLY),
      generationB: String(request.allInputText ?? "").includes(GENERATION_B_REPLY),
      generationC: String(request.allInputText ?? "").includes(GENERATION_C_REPLY),
    }));
    if (
      requests.length !== 3 ||
      requests.some((request) => request.outcome !== "success") ||
      requestFacts[0]?.generationA !== true ||
      requestFacts[0]?.generationB !== false ||
      requestFacts[0]?.generationC !== false ||
      requestFacts[1]?.generationA !== true ||
      requestFacts[1]?.generationB !== true ||
      requestFacts[1]?.generationC !== false ||
      requestFacts[2]?.generationA !== true ||
      requestFacts[2]?.generationB !== true ||
      requestFacts[2]?.generationC !== true
    ) {
      throw new Error(`unexpected mock-openai worker requests: ${JSON.stringify(requestFacts)}`);
    }
    if (JSON.stringify(authProxy.authGenerations) !== JSON.stringify(["A", "B", "C"])) {
      throw new Error(
        `worker inference used unexpected runtime credential generations: ${JSON.stringify(authProxy.authGenerations)}`,
      );
    }
    const replyCounts = await readHistoryReplyCounts(operator);
    if (
      [GENERATION_A_REPLY, GENERATION_B_REPLY, GENERATION_C_REPLY].some(
        (reply) => replyCounts[reply] !== 1,
      )
    ) {
      throw new Error(`worker history reply counts were not exact: ${JSON.stringify(replyCounts)}`);
    }

    verdict = {
      status: "pass",
      providerMode: "mock-openai",
      sessionKey: SESSION_KEY,
      placement: dispatched.placement,
      hotPublishes: { generationB: hotPublishB, generationC: hotPublishC },
      generationA: { reply: GENERATION_A_REPLY, stages: stagesA },
      generationB: { reply: GENERATION_B_REPLY, stages: stagesB },
      generationC: { reply: GENERATION_C_REPLY, stages: stagesC },
      runtimeCredentialGenerations: authProxy.authGenerations,
      replyCounts,
      requestFacts,
      tracePath,
    };
    await fs.writeFile(
      path.join(options.artifactBase, VERDICT_FILE),
      `${JSON.stringify(verdict, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    proofError = error;
  }

  const cleanup = await Promise.allSettled([
    operator?.stopAndWait({ timeoutMs: 1_000 }) ?? Promise.resolve(),
    worker?.stop() ?? Promise.resolve(),
    gateway?.stop() ?? Promise.resolve(),
    published ? closeWireServer(published.server) : Promise.resolve(),
    authProxy.stop(),
    mock.stop(),
    fs.rm(root, { recursive: true, force: true }),
  ]);
  const cleanupFailures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (cleanupFailures.length > 0) {
    proofError = new AggregateError(
      proofError ? [proofError, ...cleanupFailures] : cleanupFailures,
      "worker inference generation proof cleanup failed",
      proofError ? { cause: proofError } : undefined,
    );
  }
  if (proofError) {
    throw proofError;
  }
  if (!verdict) {
    throw new Error("worker inference generation proof produced no verdict");
  }
  return verdict;
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: MODEL_REF,
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Worker inference generation reload",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/cloud-workers.md", "docs/concepts/qa-e2e-automation.md"],
      codeRefs: [
        "src/gateway/worker-environments/inference-runtime.ts",
        "src/agents/simple-completion-runtime.ts",
        "test/e2e/qa-lab/runtime/worker-inference-generation-reload.ts",
      ],
    },
  });
  const startedAt = Date.now();
  try {
    const verdict = await runProof(options);
    writer.appendLog(`pass: ${JSON.stringify(verdict)}\n`);
    return await writer.write({
      artifacts: [
        { filePath: VERDICT_FILE, kind: "verdict" },
        { filePath: `${SCENARIO_ID}-trace.jsonl`, kind: "trace" },
      ],
      details:
        "A baseline worker turn established the placement lifecycle; generation B then retained factory, policy, wrapper, and execution ownership while C hot-published, and the next turn used C",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const evidence = await runProducer(options);
  const status = evidence.entries[0]?.result.status;
  console.log(`Worker inference generation evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(
    `Worker inference generation verdict: ${path.join(options.artifactBase, VERDICT_FILE)}`,
  );
  if (status === "pass") {
    console.log((await fs.readFile(path.join(options.artifactBase, VERDICT_FILE), "utf8")).trim());
  }
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
