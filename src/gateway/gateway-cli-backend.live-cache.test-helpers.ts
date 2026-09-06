import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { loadCliSessionHistoryMessages } from "../agents/cli-runner/session-history.js";
import { computeCacheHitRate } from "../agents/live-cache-test-support.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { sleep } from "../utils/sleep.js";
import type { GatewayClient } from "./client.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

export const CLI_BACKEND_PROBE_PLUGIN_ID = "cli-backend-probe";
export const MCP_SCHEMA_PROBE_TOOL_NAME = "mcp_schema_probe_no_args";
export const CLI_ANNOUNCE_BARRIER_TOOL_NAME = "cli_announce_barrier";
export const CLI_CACHE_AUTH_PROFILE_ID = "claude-cli:live-cache";

const execFileAsync = promisify(execFile);

export async function createCliAnnounceBarrier() {
  const requestPath = `/cli-announce-${randomBytes(12).toString("hex")}`;
  let response: ServerResponse | undefined;
  let calls = 0;
  const server = createServer((request, incomingResponse) => {
    if (request.url !== requestPath) {
      incomingResponse.writeHead(404).end();
      return;
    }
    calls += 1;
    if (calls !== 1) {
      incomingResponse.writeHead(409).end();
      return;
    }
    response = incomingResponse;
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("CLI announce barrier did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    url: `http://127.0.0.1:${port}${requestPath}`,
    get calls() {
      return calls;
    },
    release() {
      response?.end("CLI announce barrier released");
      response = undefined;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export type RuntimeBackendEntry = ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];

export async function initializeCacheProbeGitWorkspace(workspaceDir: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet", workspaceDir]);
  await execFileAsync("git", ["-C", workspaceDir, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", [
    "-C",
    workspaceDir,
    "config",
    "user.email",
    "openclaw-tests@localhost",
  ]);
  await execFileAsync("git", ["-C", workspaceDir, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    workspaceDir,
    "commit",
    "--quiet",
    "-m",
    "cache probe baseline",
  ]);
}

type CliCacheUsage = {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export function logCliCacheUsage(turn: string, result: unknown): number {
  const typedResult =
    // SAFETY: agent results expose this optional metadata shape; every field stays optional below.
    result as {
      meta?: {
        agentMeta?: {
          usage?: CliCacheUsage;
          lastCallUsage?: CliCacheUsage;
        };
      };
    };
  const agentMeta = typedResult.meta?.agentMeta;
  const usage = agentMeta?.lastCallUsage ?? agentMeta?.usage;
  if (!usage) {
    throw new Error("Claude CLI cache probe did not return normalized usage metadata");
  }
  const hitRate = computeCacheHitRate(usage);
  process.stderr.write(
    `[gateway-cli-cache] ${turn} input=${usage.input ?? 0} cacheRead=${usage.cacheRead ?? 0} cacheWrite=${usage.cacheWrite ?? 0} hitRate=${(hitRate * 100).toFixed(2)}%\n`,
  );
  return hitRate;
}

export async function createCliBackendProbePlugin(
  tempDir: string,
  probes: {
    mcpSchema: boolean;
    announceBarrierUrl: string;
    continuity?: { sessionKey: string; firstTurnMarker: string; injectedContext: string };
  },
): Promise<{ pluginPath: string; resultToken: string }> {
  const pluginDir = path.join(tempDir, CLI_BACKEND_PROBE_PLUGIN_ID);
  const resultToken = `MCP-SCHEMA-${randomBytes(6).toString("hex").toUpperCase()}`;
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: CLI_BACKEND_PROBE_PLUGIN_ID,
        name: "CLI Backend Probe",
        description: "Live test plugin for CLI completion ordering, continuity, and MCP schemas",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: {
          tools: [
            CLI_ANNOUNCE_BARRIER_TOOL_NAME,
            ...(probes.mcpSchema ? [MCP_SCHEMA_PROBE_TOOL_NAME] : []),
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
  id: "${CLI_BACKEND_PROBE_PLUGIN_ID}",
  name: "CLI Backend Probe",
  register(api) {
    api.registerTool({
      name: "${CLI_ANNOUNCE_BARRIER_TOOL_NAME}",
      description: "Wait for the live test controller to release the parent turn after child completion",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_id, _params, signal) {
        const response = await fetch(${JSON.stringify(probes.announceBarrierUrl)}, { signal });
        if (!response.ok) throw new Error("CLI announce barrier request failed");
        return { content: [{ type: "text", text: await response.text() }] };
      },
    });
    const continuity = ${JSON.stringify(probes.continuity ?? null)};
    if (continuity) {
      api.on("before_prompt_build", (event, ctx) => {
        if (ctx.sessionKey === continuity.sessionKey && event.prompt.includes(continuity.firstTurnMarker)) {
          return { prependContext: continuity.injectedContext };
        }
      });
    }
    if (${probes.mcpSchema}) api.registerTool({
      name: "${MCP_SCHEMA_PROBE_TOOL_NAME}",
      description: "Live test no-argument tool for MCP schema normalization",
      parameters: { type: "object" },
      async execute() {
        return { content: [{ type: "text", text: "${resultToken}" }] };
      },
    });
  },
};
`,
  );
  return { pluginPath: pluginDir, resultToken };
}

export function prepareClaudeCacheProbeBackend(params: {
  config: OpenClawConfig;
  liveBackend: RuntimeBackendEntry;
  providerId: string;
}): RuntimeBackendEntry {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY_OLD?.trim();
  if (!apiKey) {
    throw new Error("Claude CLI cache probe requires an Anthropic API key");
  }
  // Exercise the same profile-owned secret-input path as an operator-configured key.
  // The isolated state directory is removed when this live test finishes.
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        [CLI_CACHE_AUTH_PROFILE_ID]: {
          type: "api_key",
          provider: "claude-cli",
          key: apiKey,
        },
      },
      order: { "claude-cli": [CLI_CACHE_AUTH_PROFILE_ID] },
    },
    resolveAgentDir(params.config, "dev"),
    { syncExternalCli: false },
  );

  // This Vitest gateway uses the minimal startup path, so load the owning bundled plugin
  // explicitly. The production Gateway loads the same runtime registration at startup.
  const registry = loadOpenClawPlugins({
    cache: false,
    config: params.config,
    onlyPluginIds: ["anthropic"],
  });
  const registration = registry.cliBackends.find((entry) => entry.backend.id === params.providerId);
  if (!registration) {
    const pluginStates = registry.plugins
      .map((plugin) => `${plugin.id}:${plugin.status}${plugin.error ? ` (${plugin.error})` : ""}`)
      .join(", ");
    throw new Error(
      `cache probe could not load runtime CLI backend ${params.providerId}; plugins=${pluginStates || "none"}`,
    );
  }
  return {
    ...registration.backend,
    // Keep the live harness's installed command and explicit API-key passthrough while
    // exercising the owning plugin's real prepare/argv hooks.
    config: params.liveBackend.config,
    pluginId: registration.pluginId,
    ...(registration.builtWithOpenClawVersion
      ? { builtWithOpenClawVersion: registration.builtWithOpenClawVersion }
      : {}),
  };
}

async function waitFor<T>(resolve: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const value = resolve();
    if (value !== undefined) {
      return value;
    }
    await sleep(1_000);
  }
  throw new Error("timed out waiting for live CLI announce proof");
}

export async function verifyCliBackendAnnounceOrdering({
  client,
  announceBarrier,
  requestTimeoutMs,
  logStep,
}: {
  client: GatewayClient;
  announceBarrier: Awaited<ReturnType<typeof createCliAnnounceBarrier>>;
  requestTimeoutMs: number;
  logStep: (step: string, details?: Record<string, unknown>) => void;
}) {
  const announceNonce = randomBytes(3).toString("hex").toUpperCase();
  const announceSessionKey = `agent:dev:cli-announce-${announceNonce.toLowerCase()}`;
  const announceChildToken = `CLI_ANNOUNCE_CHILD_${announceNonce}`;
  const announceParentToken = `CLI_ANNOUNCE_PARENT_${announceNonce}`;
  let announceParentObservedAt: number | undefined;
  const announceRequest = client.request(
    "agent",
    {
      sessionKey: announceSessionKey,
      idempotencyKey: `cli-announce-order-${randomUUID()}`,
      deliver: false,
      timeout: 240,
      message: [
        "Run this exact OpenClaw CLI-backed completion announcement scenario. Use tool calls, not prose.",
        `Call sessions_spawn exactly once with taskName=cli_announce_${announceNonce.toLowerCase()} and task=${JSON.stringify(`Reply exactly ${announceChildToken} and nothing else.`)}.`,
        `After sessions_spawn returns status=accepted, call ${CLI_ANNOUNCE_BARRIER_TOOL_NAME} exactly once with no arguments.`,
        `After that tool returns, reply exactly ${announceParentToken}.`,
        `When the child's completion is delivered in a later turn, include its exact result ${announceChildToken} in your user-facing update.`,
      ].join("\n"),
    },
    { expectFinal: true, timeoutMs: requestTimeoutMs },
  );
  let announceError: unknown;
  void announceRequest.then(
    () => (announceParentObservedAt = Date.now()),
    (error: unknown) => (announceError = error),
  );

  const completedAnnounceChild = await waitFor(() => {
    if (announceError) {
      throw new Error("CLI announce parent failed", { cause: announceError });
    }
    if (announceBarrier.calls === 0) {
      return undefined;
    }
    return listSubagentRunsForRequester(announceSessionKey).find(
      (run) =>
        run.taskName === `cli_announce_${announceNonce.toLowerCase()}` &&
        run.completion?.resultText?.includes(announceChildToken) === true &&
        run.execution.outcome?.status === "ok",
    );
  });
  expect(announceBarrier.calls).toBe(1);
  expect(announceParentObservedAt).toBeUndefined();
  expect(completedAnnounceChild.delivery?.announcedAt).toBeUndefined();
  logStep("announce-child:completed-before-parent", {
    runId: completedAnnounceChild.runId,
    childEndedAt: completedAnnounceChild.execution.endedAt,
    delivery: completedAnnounceChild.delivery,
  });
  announceBarrier.release();
  const announceParent = await announceRequest;
  announceParentObservedAt ??= Date.now();
  expect(extractPayloadText(announceParent.result)).toContain(announceParentToken);

  const deliveredAnnounceChild = await waitFor(() =>
    listSubagentRunsForRequester(announceSessionKey).find(
      (run) =>
        run.runId === completedAnnounceChild.runId &&
        run.delivery?.status === "delivered" &&
        typeof run.delivery?.deliveredAt === "number" &&
        typeof run.delivery?.announcedAt === "number",
    ),
  );
  expect(deliveredAnnounceChild.delivery?.announcedAt).toBeGreaterThanOrEqual(
    announceParentObservedAt,
  );
  expect(deliveredAnnounceChild.delivery?.announcedAt).toBe(
    deliveredAnnounceChild.delivery?.deliveredAt,
  );
  // CLI requesters use an ordered agent handoff, not the embedded steer queue.
  // The committed parent reply must precede the completion in canonical history.
  const announceEntry = loadGatewaySessionEntryReadOnly(announceSessionKey).entry;
  if (!announceEntry?.sessionId) {
    throw new Error("CLI announce probe lost its requester session");
  }
  const announceHistory = await loadCliSessionHistoryMessages({
    sessionTarget: await resolveSessionTranscriptRuntimeTarget({
      agentId: "dev",
      sessionId: announceEntry.sessionId,
      sessionKey: announceSessionKey,
    }),
  });
  const assistantReplies = announceHistory.flatMap((message) => {
    const record = message as { role?: unknown; content?: unknown };
    return record.role === "assistant"
      ? [extractTextFromChatContent(record.content, { joinWith: "" }) ?? ""]
      : [];
  });
  const parentReplyIndex = assistantReplies.findIndex((reply) =>
    reply.includes(announceParentToken),
  );
  const completionReplyIndex = assistantReplies.findIndex((reply) =>
    reply.includes(announceChildToken),
  );
  logStep("announce-child:transcript-order", {
    runId: deliveredAnnounceChild.runId,
    parentObservedAt: announceParentObservedAt,
    delivery: deliveredAnnounceChild.delivery,
    parentReplyIndex,
    completionReplyIndex,
  });
  expect(parentReplyIndex).toBeGreaterThanOrEqual(0);
  expect(completionReplyIndex).toBeGreaterThan(parentReplyIndex);
}
