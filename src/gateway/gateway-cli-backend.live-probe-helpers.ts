import { randomUUID } from "node:crypto";
import { isTruthyEnvValue } from "../infra/env.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { GatewayClient } from "./client.js";
import {
  shouldRetryCliCronMcpProbeReply,
  type BootstrapWorkspaceContext,
} from "./gateway-cli-backend.live-helpers.js";
import {
  assertCronJobMatches,
  assertCronJobVisibleViaCli,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  runOpenClawCliJson,
  type CronListJob,
} from "./live-agent-probes.js";
import { renderCatFacePngBase64 } from "./live-image-probe.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.js";
import { resolveMcpLoopbackBearerToken } from "./mcp-http.loopback-runtime.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

// CI Docker live lanes can see repeated cancelled cron tool calls before a job
// finally sticks, and the created job may take extra time to surface via the CLI.
const CLI_CRON_MCP_PROBE_MAX_ATTEMPTS = 10;
const CLI_CRON_MCP_PROBE_VERIFY_POLLS = 20;
const CLI_CRON_MCP_PROBE_VERIFY_POLL_MS = 2_000;

function shouldLogCliCronProbe(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG) ||
    isTruthyEnvValue(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT)
  );
}

function logCliCronProbe(step: string, details?: Record<string, unknown>): void {
  if (!shouldLogCliCronProbe()) {
    return;
  }
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.error(`[gateway-cli-live:cron] ${step}${suffix}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCliCronJobVisible(params: {
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
  expectedName: string;
  expectedMessage: string;
  polls?: number;
  pollMs?: number;
}): Promise<{ job?: CronListJob; pollsUsed: number }> {
  const polls = Math.max(1, params.polls ?? CLI_CRON_MCP_PROBE_VERIFY_POLLS);
  const pollMs = Math.max(0, params.pollMs ?? CLI_CRON_MCP_PROBE_VERIFY_POLL_MS);
  for (let verifyAttempt = 0; verifyAttempt < polls; verifyAttempt += 1) {
    const job = await assertCronJobVisibleViaCli({
      port: params.port,
      token: params.token,
      env: params.env,
      expectedName: params.expectedName,
      expectedMessage: params.expectedMessage,
    });
    if (job) {
      return { job, pollsUsed: verifyAttempt + 1 };
    }
    if (verifyAttempt < polls - 1) {
      await sleep(pollMs);
    }
  }
  return { pollsUsed: polls };
}

async function removeCliCronJobBestEffort(params: {
  id: string;
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  try {
    await runOpenClawCliJson(
      [
        "cron",
        "rm",
        params.id,
        "--json",
        "--url",
        `ws://127.0.0.1:${params.port}`,
        "--token",
        params.token,
      ],
      params.env,
    );
  } catch (error) {
    logCliCronProbe("cleanup:cron-rm-failed", {
      jobId: params.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type LoopbackJsonRpcResponse = {
  result?: unknown;
  error?: { message?: string };
};

type LoopbackToolListEntry = {
  name?: string;
  inputSchema?: unknown;
};

function asLoopbackSchemaRecord(schema: unknown): Record<string, unknown> | null {
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : null;
}

function assertLoopbackObjectSchemasHaveProperties(params: {
  tools: LoopbackToolListEntry[];
  expectedSchemaProbeToolName?: string;
}): void {
  const missingProperties = params.tools
    .filter((tool) => {
      const schema = asLoopbackSchemaRecord(tool.inputSchema);
      if (!schema || schema.type !== "object") {
        return false;
      }
      const properties = schema.properties;
      return (
        !Object.hasOwn(schema, "properties") ||
        !properties ||
        typeof properties !== "object" ||
        Array.isArray(properties)
      );
    })
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);

  if (missingProperties.length > 0) {
    throw new Error(
      `mcp loopback tools/list exposed object schemas without properties: ${missingProperties.join(
        ", ",
      )}`,
    );
  }

  const expectedToolName = params.expectedSchemaProbeToolName;
  if (!expectedToolName) {
    return;
  }
  const tool = params.tools.find((candidate) => candidate.name === expectedToolName);
  if (!tool) {
    throw new Error(`mcp loopback tools/list did not expose ${expectedToolName}`);
  }
  const schema = asLoopbackSchemaRecord(tool.inputSchema);
  if (
    !schema ||
    schema.type !== "object" ||
    !Object.hasOwn(schema, "properties") ||
    !asLoopbackSchemaRecord(schema.properties)
  ) {
    throw new Error(`mcp loopback schema probe ${expectedToolName} was not normalized`);
  }
}

async function callLoopbackJsonRpc(params: {
  sessionKey: string;
  senderIsOwner: boolean;
  messageProvider?: string;
  accountId?: string;
  body: Record<string, unknown>;
}): Promise<LoopbackJsonRpcResponse> {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("mcp loopback runtime is not active");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveMcpLoopbackBearerToken(runtime, params.senderIsOwner)}`,
    "Content-Type": "application/json",
    "x-session-key": params.sessionKey,
  };
  if (params.messageProvider) {
    headers["x-openclaw-message-channel"] = params.messageProvider;
  }
  if (params.accountId) {
    headers["x-openclaw-account-id"] = params.accountId;
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(params.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`mcp loopback http ${response.status}: ${text}`);
  }
  if (!text.trim()) {
    return {};
  }
  const parsed = JSON.parse(text) as LoopbackJsonRpcResponse;
  if (parsed.error?.message) {
    throw new Error(`mcp loopback json-rpc error: ${parsed.error.message}`);
  }
  return parsed;
}

export async function verifyCliCronMcpLoopbackPreflight(params: {
  sessionKey: string;
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
  senderIsOwner: boolean;
  messageProvider?: string;
  accountId?: string;
  expectedSchemaProbeToolName?: string;
}): Promise<void> {
  const cronProbe = createLiveCronProbeSpec();
  logCliCronProbe("loopback-preflight:start", {
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    jobName: cronProbe.name,
  });

  await callLoopbackJsonRpc({
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    body: {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vitest" } },
    },
  });
  await callLoopbackJsonRpc({
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  const toolsList = await callLoopbackJsonRpc({
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    body: { jsonrpc: "2.0", id: "tools-list", method: "tools/list" },
  });
  const tools = Array.isArray((toolsList.result as { tools?: unknown[] } | undefined)?.tools)
    ? (((toolsList.result as { tools?: unknown[] }).tools ?? []) as LoopbackToolListEntry[])
    : [];
  assertLoopbackObjectSchemasHaveProperties({
    tools,
    expectedSchemaProbeToolName: params.expectedSchemaProbeToolName,
  });
  const toolNames = tools
    .map((tool) => (typeof tool.name === "string" ? tool.name : ""))
    .filter(Boolean);
  logCliCronProbe("loopback-preflight:tools", {
    senderIsOwner: params.senderIsOwner,
    toolCount: toolNames.length,
    cronVisible: toolNames.includes("cron"),
  });
  if (!toolNames.includes("cron")) {
    throw new Error(
      `mcp loopback tools/list did not expose cron (senderIsOwner=${String(params.senderIsOwner)})`,
    );
  }

  const toolCall = await callLoopbackJsonRpc({
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
    body: {
      jsonrpc: "2.0",
      id: "cron-add",
      method: "tools/call",
      params: {
        name: "cron",
        arguments: JSON.parse(cronProbe.argsJson) as Record<string, unknown>,
      },
    },
  });
  const toolCallError =
    (toolCall.result as { isError?: unknown } | undefined)?.isError === true ||
    !(toolCall.result as { content?: unknown } | undefined);
  logCliCronProbe("loopback-preflight:call", {
    isError: toolCallError,
    jobName: cronProbe.name,
  });
  if (toolCallError) {
    throw new Error(`mcp loopback cron tools/call returned isError for job ${cronProbe.name}`);
  }

  const { job: createdJob, pollsUsed } = await pollCliCronJobVisible({
    port: params.port,
    token: params.token,
    env: params.env,
    expectedName: cronProbe.name,
    expectedMessage: cronProbe.message,
  });
  logCliCronProbe("loopback-preflight:verify", {
    jobName: cronProbe.name,
    pollsUsed,
    createdJob: Boolean(createdJob),
  });
  if (!createdJob) {
    throw new Error(`mcp loopback cron tools/call did not create job ${cronProbe.name}`);
  }
  assertCronJobMatches({
    job: createdJob,
    expectedName: cronProbe.name,
    expectedMessage: cronProbe.message,
    expectedSessionKey: params.sessionKey,
  });
  if (createdJob.id) {
    await removeCliCronJobBestEffort({
      id: createdJob.id,
      port: params.port,
      token: params.token,
      env: params.env,
    });
  }
  logCliCronProbe("loopback-preflight:done", { jobName: cronProbe.name });
}

function getCliBackendProbeThinking(providerId: string): "low" | undefined {
  return normalizeLowercaseStringOrEmpty(providerId) === "codex-cli" ? "low" : undefined;
}

export async function verifyCliBackendImageProbe(params: {
  client: GatewayClient;
  providerId: string;
  sessionKey: string;
  tempDir: string;
  bootstrapWorkspace: BootstrapWorkspaceContext | null;
}): Promise<void> {
  const thinking = getCliBackendProbeThinking(params.providerId);
  const imageBase64 = renderCatFacePngBase64();
  const runIdImage = randomUUID();
  const imageProbe = await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${runIdImage}-image`,
      // Route all providers through the same attachment pipeline. Claude CLI
      // still receives a local file path, but now via the runner code we
      // actually want to validate instead of an ad hoc prompt-only shortcut.
      message:
        "What animal is drawn in the attached image? Reply with only the lowercase animal name.",
      attachments: [
        {
          mimeType: "image/png",
          fileName: `probe-${runIdImage}.png`,
          content: imageBase64,
        },
      ],
      deliver: false,
      ...(thinking ? { thinking } : {}),
    },
    { expectFinal: true },
  );
  if (imageProbe?.status !== "ok") {
    throw new Error(`image probe failed: status=${String(imageProbe?.status)}`);
  }
  assertLiveImageProbeReply(extractPayloadText(imageProbe?.result));
}

export async function verifyCliCronMcpProbe(params: {
  client: GatewayClient;
  providerId: string;
  sessionKey: string;
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const cronProbe = createLiveCronProbeSpec();
  const thinking = getCliBackendProbeThinking(params.providerId);

  let createdJob: CronListJob | undefined;
  let lastCronText = "";

  for (let attempt = 0; attempt < CLI_CRON_MCP_PROBE_MAX_ATTEMPTS && !createdJob; attempt += 1) {
    logCliCronProbe("agent-attempt:start", {
      attempt,
      providerId: params.providerId,
      sessionKey: params.sessionKey,
      expectedJob: cronProbe.name,
    });
    const runIdMcp = randomUUID();
    const cronResult = await params.client.request(
      "agent",
      {
        sessionKey: params.sessionKey,
        idempotencyKey: `idem-${runIdMcp}-mcp-${attempt}`,
        message: buildLiveCronProbeMessage({
          agent: params.providerId,
          argsJson: cronProbe.argsJson,
          attempt,
          exactReply: cronProbe.name,
        }),
        deliver: false,
        ...(thinking ? { thinking } : {}),
      },
      { expectFinal: true },
    );
    if (cronResult?.status !== "ok") {
      throw new Error(`cron mcp probe failed: status=${String(cronResult?.status)}`);
    }
    lastCronText = extractPayloadText(cronResult?.result).trim();
    const retryableReply = shouldRetryCliCronMcpProbeReply(lastCronText);
    logCliCronProbe("agent-attempt:reply", {
      attempt,
      retryableReply,
      reply: lastCronText,
    });
    const verifyResult = await pollCliCronJobVisible({
      port: params.port,
      token: params.token,
      env: params.env,
      expectedName: cronProbe.name,
      expectedMessage: cronProbe.message,
    });
    createdJob = verifyResult.job;
    logCliCronProbe("agent-attempt:verify", {
      attempt,
      pollsUsed: verifyResult.pollsUsed,
      createdJob: Boolean(createdJob),
      retryableReply,
    });
    if (!createdJob && !retryableReply) {
      throw new Error(
        `cron cli verify could not find job ${cronProbe.name} after attempt ${attempt + 1}: reply=${JSON.stringify(lastCronText)}`,
      );
    }
  }

  if (!createdJob) {
    throw new Error(
      `cron cli verify did not create job ${cronProbe.name} after ${CLI_CRON_MCP_PROBE_MAX_ATTEMPTS} attempts: reply=${JSON.stringify(lastCronText)}`,
    );
  }
  assertCronJobMatches({
    job: createdJob,
    expectedName: cronProbe.name,
    expectedMessage: cronProbe.message,
    expectedSessionKey: params.sessionKey,
  });
  if (createdJob?.id) {
    await removeCliCronJobBestEffort({
      id: createdJob.id,
      port: params.port,
      token: params.token,
      env: params.env,
    });
  }
}
