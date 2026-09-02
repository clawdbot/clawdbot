/**
 * Production-path A/B for the `message_tool_only` delivery prompt.
 *
 * Round-1's sibling script (`message-tool-only-prompt-live-proof.ts`) hand-assembled a
 * prompt and posted it straight to provider APIs. ClawSweeper's round-2 [P1] finding was
 * that this bypasses the Codex app-server thread/turn construction and dynamic-tool
 * serialization that actually own the affected user flow. This script closes that gap.
 *
 * WHAT IS REAL HERE (nothing in this list is simulated):
 *   - The real managed Codex app-server binary (`@openai/codex`, version pinned by
 *     `CODEX_APP_SERVER_VERSION`) started over the production stdio transport via
 *     `createIsolatedCodexAppServerClient`.
 *   - The real `runCodexAppServerAttempt` entrypoint, which owns `buildDeveloperInstructions`,
 *     `buildThreadStartParams`, `buildTurnStartParams`, and `createCodexDynamicToolBridge`
 *     dynamic-tool serialization. No prompt bytes and no tool JSON are authored here.
 *   - The real OpenClaw tool build (`buildDynamicTools` -> `createOpenClawCodingTools` ->
 *     `normalizeAgentRuntimeTools`), so the `message` tool the model sees is the production
 *     descriptor, serialized the production way, alongside its production siblings.
 *   - The real production prompt layers: `buildReplyPromptEnvelope`,
 *     `buildInboundMetaSystemPrompt`, `buildInboundUserContextPrefix`, the chat-context
 *     paragraph under test, and the harness-level visible-reply guidance that
 *     `buildDeveloperInstructions` emits for `message_tool_only` runs
 *     (`buildHarnessVisibleReplyGuidance`). That last layer is present in BOTH arms
 *     because production always emits it, and round-1's harness omitted it entirely.
 *   - Real model turns against real OpenAI credentials.
 *
 * WHAT IS MOCKED — exactly one seam, the outermost one:
 *   - The channel plugin's `outbound.sendText` / `outbound.sendMedia`. The real bundled
 *     channel plugin surface is loaded and registered; only its two wire methods are
 *     replaced with recorders so nothing is posted to a live chat. Everything between the
 *     model's tool call and that wire is production code.
 *
 * THE A/B: the only byte that differs between arms is the chat-context paragraph. The
 * `baseline` arm pulls `buildDirectChatContext` / `buildGroupChatContext` out of
 * `git show <base-ref>:src/auto-reply/reply/groups.ts`; the `patched` arm imports the
 * working tree's. Everything else is identical.
 *
 * Run:
 *   OPENAI_API_KEY=... pnpm tsx scripts/dev/message-tool-only-codex-app-server-proof.ts
 *   ... --replicates 5 --concurrency 3 --out ~/reports/bighat-l2nf/proof-app-server
 *
 * Skips cleanly (exit 0) when no credential or no managed Codex binary is available, so it
 * is safe in CI. Fails loudly (exit 1) when a run contradicts the patch's claim.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveCodexAppServerRuntimeOptions } from "../../extensions/codex/src/app-server/config.js";
import { runCodexAppServerAttempt } from "../../extensions/codex/src/app-server/run-attempt.js";
import { createCodexTestBindingStore } from "../../extensions/codex/src/app-server/session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "../../extensions/codex/src/app-server/shared-client.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  resolveMessageToolSourceReplyFinal,
} from "../../src/agents/embedded-agent-message-tool-source-reply.js";
import { extractMessagingToolSourceReplyPayload } from "../../src/agents/embedded-agent-messaging-extraction.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
} from "../../src/auto-reply/reply/inbound-meta.js";
import { buildReplyPromptEnvelope } from "../../src/auto-reply/reply/prompt-prelude.js";
import type { TemplateContext } from "../../src/auto-reply/templating.js";
import { SILENT_REPLY_TOKEN } from "../../src/auto-reply/tokens.js";
import { normalizeChatType } from "../../src/channels/chat-type.js";
import { replaceSessionEntry } from "../../src/config/sessions/session-accessor.js";
import type { EmbeddedRunAttemptParams } from "../../src/plugin-sdk/agent-harness-runtime.js";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../src/plugin-sdk/plugin-test-runtime.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../src/test-utils/channel-plugins.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GROUPS_MODULE_RELATIVE_PATH = "src/auto-reply/reply/groups.ts";
const DEFAULT_BASELINE_REF = "3dd3003f49ce71f38c0ecf84dbdbc95023498a69";
const PROCESS_TEMP_DIRS = new Set<string>();

function createProcessTempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  PROCESS_TEMP_DIRS.add(directory);
  return directory;
}

function cleanupProcessTempDirs(): void {
  for (const directory of PROCESS_TEMP_DIRS) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  PROCESS_TEMP_DIRS.clear();
}

// `skip()` exits directly, so a synchronous exit handler is the single owner that cleans
// proof-global scratch state on success, failure, or a clean preflight skip.
process.once("exit", cleanupProcessTempDirs);

const { values } = parseArgs({
  options: {
    replicates: { type: "string", default: "5" },
    concurrency: { type: "string", default: "3" },
    "base-ref": { type: "string", default: DEFAULT_BASELINE_REF },
    model: { type: "string", default: "" },
    out: { type: "string", default: "" },
    "dump-events": { type: "string", default: "" },
  },
});
const REPLICATES = Math.max(1, Number.parseInt(values.replicates ?? "5", 10));
const CONCURRENCY = Math.max(1, Number.parseInt(values.concurrency ?? "3", 10));
const BASE_REF = values["base-ref"]?.trim() || DEFAULT_BASELINE_REF;
const OUT_DIR = values.out?.trim() || "";
const DUMP_EVENTS = values["dump-events"]?.trim() || "";
const BASELINE_OID = execFileSync("git", ["rev-parse", `${BASE_REF}^{commit}`], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const PATCHED_OID = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
if (BASELINE_OID === PATCHED_OID) {
  throw new Error(`baseline and patched commits both resolve to ${PATCHED_OID}`);
}
console.log(`Proof commits: baseline ${BASELINE_OID}; patched ${PATCHED_OID}`);

/**
 * Safe stringifier for the untyped runtime payload fields this script reads out of
 * app-server events and hook records. Anything that is not already a primitive is
 * reported as the fallback rather than stringified into `[object Object]`.
 */
function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function isCanonicalTerminalCurrentSourceReply(params: unknown, result: unknown): boolean {
  return (
    resolveMessageToolSourceReplyFinal(params) &&
    extractMessagingToolSourceReplyPayload(result) !== undefined &&
    isDeliveredMessageToolOnlySourceReplyResult({
      sourceReplyDeliveryMode: "message_tool_only",
      toolName: "message",
      args: params,
      result,
    })
  );
}

function assertDeliveryClassifierRejectsFalsePositives(): void {
  const settledDelivery = {
    status: "settled",
    partialDelivery: false,
    createdThreadIds: [],
  };
  const canonicalResult = {
    details: {
      deliveryStatus: "sent",
      channel: "webchat",
      target: "current-run",
      sourceReplySink: "internal-ui",
      sourceReply: { text: "visible source reply" },
      messageDelivery: settledDelivery,
    },
  };
  if (!isCanonicalTerminalCurrentSourceReply({ action: "send" }, canonicalResult)) {
    throw new Error("delivery classifier rejected a canonical terminal current-source reply");
  }
  if (
    isCanonicalTerminalCurrentSourceReply(
      { action: "send", channel: "telegram", target: "user:elsewhere" },
      {
        details: {
          deliveryStatus: "sent",
          channel: "telegram",
          target: "user:elsewhere",
          messageDelivery: settledDelivery,
        },
      },
    )
  ) {
    throw new Error("delivery classifier accepted an off-target successful send");
  }
  if (isCanonicalTerminalCurrentSourceReply({ action: "send", final: false }, canonicalResult)) {
    throw new Error("delivery classifier accepted a non-terminal source reply");
  }
}

assertDeliveryClassifierRejectsFalsePositives();

type GroupsModule = {
  buildGroupChatContext: (params: {
    sessionCtx: TemplateContext;
    sourceReplyDeliveryMode?: string;
    silentReplyPolicy?: string;
    silentToken?: string;
  }) => string;
  buildDirectChatContext: (params: {
    sessionCtx: TemplateContext;
    sourceReplyDeliveryMode?: string;
  }) => string;
};

/**
 * Loads the pre-fix builders straight out of git history. Relative import specifiers are
 * rewritten to absolute file URLs so the extracted copy resolves against the working tree's
 * unchanged siblings; nothing is written into the repository.
 */
async function loadBaselineGroupsModule(baseRef: string): Promise<GroupsModule> {
  const source = execFileSync("git", ["show", `${baseRef}:${GROUPS_MODULE_RELATIVE_PATH}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const sourceDirectory = path.join(repoRoot, path.dirname(GROUPS_MODULE_RELATIVE_PATH));
  const absolutize = (specifier: string) =>
    pathToFileURL(path.resolve(sourceDirectory, specifier)).href;
  const rewritten = source
    .replace(
      /(from\s+")(\.\.?\/[^"]+)(")/g,
      (_m, head, spec, tail) => head + absolutize(spec) + tail,
    )
    .replace(
      /(import\(\s*")(\.\.?\/[^"]+)("\s*\))/g,
      (_m, head, spec, tail) => head + absolutize(spec) + tail,
    );
  const file = path.join(createProcessTempDir("mto-appserver-baseline-"), "groups.ts");
  fs.writeFileSync(file, rewritten, "utf8");
  return (await import(pathToFileURL(file).href)) as GroupsModule;
}

// ---------------------------------------------------------------------------
// Preflight: skip cleanly rather than fail when this environment cannot run it.
// ---------------------------------------------------------------------------

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

// Keep every byte this proof writes inside a throwaway directory; it must never touch a
// developer's real OpenClaw state.
const PROOF_STATE_DIR = createProcessTempDir("mto-appserver-state-");
process.env.OPENCLAW_STATE_DIR = PROOF_STATE_DIR;

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
  skip("OPENAI_API_KEY is not set; this proof needs a real credential to drive real turns.");
}

// ---------------------------------------------------------------------------
// Scenarios. All conversation content is synthetic: no real user text, names, or ids.
// ---------------------------------------------------------------------------

type Scenario = {
  id: string;
  provider: "telegram" | "discord";
  chatType: "direct" | "group";
  /** True when a competent participant should answer; false for ambient chatter. */
  replyExpected: boolean;
  ctx: TemplateContext;
};

const SCENARIOS: Scenario[] = [
  {
    id: "direct-addressed",
    provider: "telegram",
    chatType: "direct",
    replyExpected: true,
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "user:1000001",
      AccountId: "primary",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:1000001",
      MessageSid: "tg-msg-0001",
      SenderId: "1000001",
      SenderName: "Sam",
      SenderUsername: "sam",
      Body: "I'm about to bump the cache TTL from 60s to 600s on the pricing service. Walk me through what could break and what I should watch after the change.",
      BodyStripped:
        "I'm about to bump the cache TTL from 60s to 600s on the pricing service. Walk me through what could break and what I should watch after the change.",
    } as unknown as TemplateContext,
  },
  {
    id: "group-addressed",
    provider: "discord",
    chatType: "group",
    replyExpected: true,
    ctx: {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:987654321",
      From: "guild:123456789/channel:987654321",
      AccountId: "primary",
      ChatType: "group",
      SessionKey: "agent:main:discord:guild:123456789:channel:987654321",
      MessageSid: "discord-msg-0001",
      SenderId: "424242",
      SenderName: "Rowan",
      SenderUsername: "rowan",
      WasMentioned: true,
      Body: "@agent the nightly export job finished with 3 retries again. Can you explain what causes the retries and tell us whether we need to change anything before Friday's run?",
      BodyStripped:
        "the nightly export job finished with 3 retries again. Can you explain what causes the retries and tell us whether we need to change anything before Friday's run?",
    } as unknown as TemplateContext,
  },
  {
    id: "group-ambient",
    provider: "discord",
    chatType: "group",
    replyExpected: false,
    ctx: {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:987654321",
      From: "guild:123456789/channel:987654321",
      AccountId: "primary",
      ChatType: "group",
      SessionKey: "agent:main:discord:guild:123456789:channel:987654322",
      MessageSid: "discord-msg-0002",
      SenderId: "424243",
      SenderName: "Wren",
      SenderUsername: "wren",
      Body: "coffee machine on floor 2 is broken again. tragic. floor 3 one still works",
      BodyStripped: "coffee machine on floor 2 is broken again. tragic. floor 3 one still works",
    } as unknown as TemplateContext,
  },
];

type Arm = "baseline" | "patched";
const ARMS: Arm[] = ["baseline", "patched"];

const patchedGroups = (await import("../../src/auto-reply/reply/groups.js")) as GroupsModule;
const baselineGroups = await loadBaselineGroupsModule(BASE_REF);

function renderChatContext(arm: Arm, scenario: Scenario): string {
  const groups = arm === "patched" ? patchedGroups : baselineGroups;
  return scenario.chatType === "direct"
    ? groups.buildDirectChatContext({
        sessionCtx: scenario.ctx,
        sourceReplyDeliveryMode: "message_tool_only",
      })
    : groups.buildGroupChatContext({
        sessionCtx: scenario.ctx,
        sourceReplyDeliveryMode: "message_tool_only",
        silentReplyPolicy: "allow",
        silentToken: SILENT_REPLY_TOKEN,
      });
}

/** Production system-prompt composition for a source-reply turn. */
function buildExtraSystemPrompt(arm: Arm, scenario: Scenario): string {
  return [buildInboundMetaSystemPrompt(scenario.ctx, {}), renderChatContext(arm, scenario)]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Production turn body, composed by `buildReplyPromptEnvelope`.
 *
 * The envelope owns both the visible user prompt and hidden per-turn inbound context.
 * Production passes those fields separately to the harness; the Codex adapter prepends
 * `currentInboundContext.text` before issuing `turn/start`.
 */
function buildPromptSubmission(
  scenario: Scenario,
): Pick<EmbeddedRunAttemptParams, "prompt" | "currentInboundContext"> {
  const body = scenario.ctx.BodyStripped ?? scenario.ctx.Body ?? "";
  const inboundUserContext = buildInboundUserContextPrefix(scenario.ctx);
  const promptBody = [inboundUserContext, body].filter(Boolean).join("\n\n");
  const envelope = buildReplyPromptEnvelope({
    ctx: scenario.ctx,
    sessionCtx: scenario.ctx,
    baseBody: promptBody,
    hasUserBody: true,
    inboundUserContext: "",
    isBareSessionReset: false,
    startupAction: "new",
    prefixedBody: promptBody,
    inboundEventKind: "user_request",
    sourceReplyDeliveryMode: "message_tool_only",
  } as Parameters<typeof buildReplyPromptEnvelope>[0]);
  return {
    prompt: envelope.prefixedCommandBody,
    currentInboundContext: envelope.currentInboundContext,
  };
}

// ---------------------------------------------------------------------------
// One trial = one real Codex app-server turn.
// ---------------------------------------------------------------------------

type Delivery = { text: string; to: unknown };
type Trial = {
  arm: Arm;
  scenarioId: string;
  replicate: number;
  delivered: Delivery[];
  messageToolCalls: number;
  messageToolOutcomes: string[];
  messageToolResults: string[];
  toolCalls: string[];
  assistantTextChars: number;
  terminal: string;
  dynamicToolNames: string[];
  messageToolSpecJson?: string;
  developerInstructions?: string;
  chatContextPresent?: boolean;
  currentInboundContextPresent?: boolean;
  events: Array<{ stream: string; data: Record<string, unknown> }>;
  error?: string;
};

/**
 * A minimal but realistically shaped OpenClaw agent workspace. Codex discovers these
 * through native project-doc discovery exactly as it does in production. Without them the
 * temp workspace reads as an unexplored code repo and the model spends the turn running
 * `bash` instead of answering, which produces a degenerate turn that measures nothing.
 */
const WORKSPACE_FILES: Record<string, string> = {
  "AGENTS.md": [
    "# AGENTS.md",
    "",
    "You are a conversational assistant reachable through a messaging gateway.",
    "",
    "## Every turn",
    "",
    "- Answer from what you already know. This workspace holds no project code:",
    "  there is nothing to search, build, or test here.",
    "- Keep replies concise and useful to the person who wrote to you.",
    "",
  ].join("\n"),
  "SOUL.md": [
    "# SOUL.md",
    "",
    "Warm, direct, competent. You explain tradeoffs plainly and do not pad.",
    "",
  ].join("\n"),
  "IDENTITY.md": ["# IDENTITY.md", "", "- **Name:** Ash", "- **Emoji:** 🛠️", ""].join("\n"),
  "USER.md": [
    "# USER.md",
    "",
    "- **Name:** Sam",
    "- **Role:** platform engineer",
    "- **Pronouns:** they/them",
    "",
  ].join("\n"),
};

/**
 * `setActivePluginRegistry` and `initializeGlobalHookRunner` are PROCESS-GLOBAL. Installing
 * either per trial silently cross-contaminates concurrent trials: one trial's hook handler
 * closes over another trial's record, and a discord trial's registry replaces a telegram
 * trial's mid-run. Both globals are therefore installed exactly once, before any trial runs,
 * and every observation is routed back to its own trial by `runId`.
 */
const TRIALS_BY_RUN_ID = new Map<string, Trial>();

async function loadRecordingChannelPlugin(
  provider: string,
  sink: Delivery[],
): Promise<Record<string, unknown>> {
  const moduleId = resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: provider,
    artifactBasename: "channel-plugin-api.js",
  });
  const namespace = (await import(moduleId)) as Record<string, unknown>;
  const realPlugin = namespace[`${provider}Plugin`] as Record<string, unknown> | undefined;
  if (!realPlugin || typeof realPlugin !== "object") {
    throw new Error(`missing channel plugin export "${provider}Plugin" in ${moduleId}`);
  }
  // Only the two wire methods are replaced. Capabilities, meta, config, and every other
  // adapter stay exactly as the bundled plugin declares them, so the message tool's
  // generated schema is the production schema.
  return {
    ...realPlugin,
    outbound: {
      ...(realPlugin.outbound as Record<string, unknown>),
      deliveryMode: "direct",
      sendText: async (args: { to?: unknown; text?: string }) => {
        sink.push({
          text: args?.text ?? "",
          to: { channelAdapter: args?.to ?? null },
        });
        return { channel: provider, messageId: `mock-${sink.length}` };
      },
      sendMedia: async (args: { to?: unknown; caption?: string }) => {
        sink.push({ text: args?.caption ?? "<media>", to: args?.to });
        return { channel: provider, messageId: `mock-media-${sink.length}` };
      },
    },
  };
}

async function runTrial(arm: Arm, scenario: Scenario, replicate: number): Promise<Trial> {
  const trial: Trial = {
    arm,
    scenarioId: scenario.id,
    replicate,
    delivered: [],
    messageToolCalls: 0,
    messageToolOutcomes: [],
    messageToolResults: [],
    toolCalls: [],
    events: [],
    assistantTextChars: 0,
    terminal: "unknown",
    dynamicToolNames: [],
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mto-appserver-${arm}-`));
  const promptSubmission = buildPromptSubmission(scenario);
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(root, "codex-home");
  for (const dir of [workspaceDir, agentDir, codexHome]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const [name, contents] of Object.entries(WORKSPACE_FILES)) {
    fs.writeFileSync(path.join(workspaceDir, name), contents, "utf8");
  }
  // The message tool persists the source reply into the session transcript before it
  // reaches the transport, and refuses to write when the store has no entry whose
  // sessionId matches this attempt ("session rebound"). Seed the real store so the
  // production persistence step succeeds instead of short-circuiting the send.
  const sessionStorePath = path.join(root, "sessions.json");
  const sessionId = `proof-${arm}-${scenario.id}-${replicate}`;
  await replaceSessionEntry(
    {
      agentId: "main",
      sessionKey: String(scenario.ctx.SessionKey),
      storePath: sessionStorePath,
    },
    { sessionId, updatedAt: Date.now() },
  );
  let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
  let host: Awaited<ReturnType<typeof createAgentHarnessHostCapabilitiesForTest>> | undefined;
  try {
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: apiKey, auth_mode: "apikey" }),
      "utf8",
    );

    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: { appServer: { homeScope: "user" } },
      env: {},
    });
    client = await createIsolatedCodexAppServerClient({
      startOptions: {
        ...runtime.start,
        env: { ...runtime.start.env, CODEX_HOME: codexHome },
      },
      agentDir,
      authProfileId: null,
      timeoutMs: 180_000,
    });

    // Read-only observation of the production RPC payloads; the request itself is untouched.
    const originalRequest = client.request.bind(client);
    (client as unknown as { request: unknown }).request = async (
      method: string,
      params: unknown,
      opts?: unknown,
    ) => {
      if (method === "thread/start") {
        const started = params as {
          dynamicTools?: unknown;
          developerInstructions?: unknown;
        };
        const specs = started?.dynamicTools;
        if (Array.isArray(specs)) {
          trial.dynamicToolNames = specs.map((spec) =>
            asText((spec as { name?: unknown })?.name, "?"),
          );
          trial.messageToolSpecJson = JSON.stringify(
            specs.find((spec) => (spec as { name?: unknown })?.name === "message") ?? null,
          );
        }
        // The load-bearing check: the arm's chat-context bytes must actually reach the
        // app-server's developer instructions. If they do not, the A/B measures nothing.
        const instructions = asText(started?.developerInstructions);
        trial.developerInstructions = instructions;
        trial.chatContextPresent = instructions.includes(renderChatContext(arm, scenario));
      }
      if (method === "turn/start") {
        const turn = params as { input?: Array<{ type?: unknown; text?: unknown }> };
        const submittedText = (turn.input ?? [])
          .filter((item) => item?.type === "text")
          .map((item) => asText(item.text))
          .join("\n");
        const inboundText = promptSubmission.currentInboundContext?.text?.trim() ?? "";
        trial.currentInboundContextPresent =
          inboundText.length > 0 && submittedText.includes(inboundText);
      }
      return originalRequest(method, params as never, opts as never);
    };

    const modelId = resolvedModelId;
    const attempt = {
      agentId: "main",
      agentDir,
      workspaceDir,
      cwd: workspaceDir,
      sessionFile: path.join(root, "session.jsonl"),
      sessionKey: scenario.ctx.SessionKey,
      sessionId,
      runId: `proof-run-${arm}-${scenario.id}-${replicate}`,
      provider: "codex",
      modelId,
      model: {
        id: modelId,
        name: modelId,
        provider: "codex",
        api: "openai-chatgpt-responses",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 8_000,
        compat: { supportsTools: true },
      },
      ...promptSubmission,
      extraSystemPrompt: buildExtraSystemPrompt(arm, scenario),
      config: {
        tools: { web: { search: { enabled: false } } },
        session: { store: sessionStorePath },
        // Account credentials the production send path checks before it hands off to the
        // outbound adapter. The values are placeholders; the adapter is the recorder, so
        // nothing is ever presented to a real API.
        telegram: { accounts: { primary: { token: "proof-placeholder-token" } } },
        discord: { accounts: { primary: { token: "proof-placeholder-token" } } },
      },
      thinkLevel: "medium",
      disableTools: false,
      timeoutMs: 300_000,
      trigger: "user",
      oneShotCliRun: true,
      messageProvider: scenario.provider,
      messageChannel: scenario.provider,
      chatType: normalizeChatType(scenario.ctx.ChatType),
      agentAccountId: scenario.ctx.AccountId,
      messageTo: scenario.ctx.OriginatingTo,
      groupId: scenario.ctx.From,
      senderId: scenario.ctx.SenderId,
      senderName: scenario.ctx.SenderName,
      senderUsername: scenario.ctx.SenderUsername,
      senderIsOwner: true,
      currentMessageId: scenario.ctx.MessageSid,
      sourceReplyDeliveryMode: "message_tool_only",
      forceMessageTool: true,
      authStorage: {},
      authProfileStore: { version: 1, profiles: {} },
      modelRegistry: {},
      onAgentEvent: (event: { stream: string; data: Record<string, unknown> }) => {
        if (DUMP_EVENTS) {
          trial.events.push(event);
        }
        // Codex projects dynamic-tool lifecycle on the `item` stream; the `tool` stream
        // carries only tools whose channel progress is not suppressed. `message` is
        // suppressed, so counting it off `tool` silently misses every call.
        if (
          event.stream === "item" &&
          event.data?.kind === "tool" &&
          event.data?.phase === "start"
        ) {
          const name = asText(event.data?.name, "?");
          trial.toolCalls.push(name);
          if (name === "message") {
            trial.messageToolCalls += 1;
          }
        }
        if (
          event.stream === "item" &&
          event.data?.kind === "tool" &&
          event.data?.phase === "end" &&
          event.data?.name === "message"
        ) {
          trial.messageToolOutcomes.push(asText(event.data?.status, "?"));
        }
        if (event.stream === "assistant" && typeof event.data?.text === "string") {
          trial.assistantTextChars = Math.max(trial.assistantTextChars, event.data.text.length);
        }
      },
    } as unknown as EmbeddedRunAttemptParams;

    TRIALS_BY_RUN_ID.set(attempt.runId, trial);
    host = await createAgentHarnessHostCapabilitiesForTest({
      attempt,
      pluginId: "codex",
    });
    attempt.hostCapabilities = host.capabilities;
    try {
      // `hostCapabilities` is assigned above, which the declared optional type cannot see.
      const result = await runCodexAppServerAttempt(
        attempt as Parameters<typeof runCodexAppServerAttempt>[0],
        {
          bindingStore: createCodexTestBindingStore(),
          pluginConfig: { appServer: { homeScope: "user" } },
          clientFactory: async () => client,
        },
      );
      trial.terminal = asText((result.terminal as { kind?: unknown })?.kind, "unknown");
    } catch (error) {
      trial.terminal = "threw";
      trial.error = error instanceof Error ? error.message : String(error);
    }
    return trial;
  } finally {
    host?.close();
    await client?.closeAndWait().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Resolved once against a throwaway app-server so concurrent trials never contend on
 * `model/list` (three simultaneous app-servers reliably time that request out).
 */
async function resolveDefaultModelId(): Promise<string> {
  const configured = values.model?.trim();
  if (configured) {
    return configured;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mto-appserver-models-"));
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
  try {
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: apiKey, auth_mode: "apikey" }),
      "utf8",
    );
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: { appServer: { homeScope: "user" } },
      env: {},
    });
    client = await createIsolatedCodexAppServerClient({
      startOptions: {
        ...runtime.start,
        env: { ...runtime.start.env, CODEX_HOME: codexHome },
      },
      agentDir,
      authProfileId: null,
      timeoutMs: 180_000,
    });
    const listed = await client.request<{
      data: Array<{ model: string; isDefault?: boolean }>;
    }>("model/list", { limit: 100, cursor: null, includeHidden: false }, { timeoutMs: 120_000 });
    const modelId = listed.data.find((entry) => entry.isDefault)?.model ?? listed.data[0]?.model;
    if (!modelId) {
      skip("Codex model/list returned no models reachable with these credentials.");
    }
    return modelId;
  } finally {
    await client?.closeAndWait().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Drive every cell, then report.
// ---------------------------------------------------------------------------

async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) {
        return;
      }
      results[index] = await tasks[index]!();
    }
  });
  await Promise.all(workers);
  return results;
}

const tasks: Array<() => Promise<Trial>> = [];
for (const arm of ARMS) {
  for (const scenario of SCENARIOS) {
    for (let replicate = 0; replicate < REPLICATES; replicate++) {
      tasks.push(() => runTrial(arm, scenario, replicate));
    }
  }
}

// One registry holding every channel a scenario uses, installed once. Production keeps
// several channel plugins registered simultaneously, so this is the faithful shape.
const channelAdapterDeliveries: Delivery[] = [];
setActivePluginRegistry(
  createTestRegistry(
    await Promise.all(
      [...new Set(SCENARIOS.map((scenario) => scenario.provider))].map(async (provider) => ({
        pluginId: provider,
        plugin: await loadRecordingChannelPlugin(provider, channelAdapterDeliveries),
        source: "message-tool-only-app-server-proof",
        origin: "bundled" as const,
      })),
    ),
  ),
);

resetGlobalHookRunner();
initializeGlobalHookRunner(
  createMockPluginRegistry([
    {
      hookName: "after_tool_call",
      handler: (event: unknown, ctx: unknown) => {
        const record = event as {
          toolName?: unknown;
          params?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (asText(record?.toolName) !== "message") {
          return;
        }
        const trial = TRIALS_BY_RUN_ID.get(asText((ctx as { runId?: unknown })?.runId));
        if (!trial) {
          return;
        }
        if (record?.error) {
          trial.messageToolResults.push(JSON.stringify({ error: record.error }).slice(0, 800));
          return;
        }
        const details = (record?.result as { details?: Record<string, unknown> })?.details;
        const deliveryStatus = asText(details?.deliveryStatus);
        const sourceReply = details?.sourceReply as { text?: unknown } | undefined;
        const canonicalTerminalSourceReply = isCanonicalTerminalCurrentSourceReply(
          record?.params,
          record?.result,
        );
        if (canonicalTerminalSourceReply) {
          trial.delivered.push({
            text: asText(sourceReply?.text) || asText(details?.message),
            to: {
              sink: details?.sourceReplySink ?? null,
              channel: details?.channel ?? null,
              target: details?.target ?? null,
            },
          });
        }
        trial.messageToolResults.push(
          JSON.stringify({
            deliveryStatus,
            status: details?.status ?? null,
            sink: details?.sourceReplySink ?? null,
            channel: details?.channel ?? null,
            target: details?.target ?? null,
            final: resolveMessageToolSourceReplyFinal(record?.params),
            canonicalTerminalSourceReply,
            textChars: asText(sourceReply?.text).length,
          }),
        );
      },
    },
  ]),
);

const resolvedModelId = await resolveDefaultModelId();
console.log(
  `Driving ${tasks.length} real Codex app-server turns on ${resolvedModelId} ` +
    `(${ARMS.length} arms x ${SCENARIOS.length} scenarios x ${REPLICATES} replicates, ` +
    `concurrency ${CONCURRENCY}, baseline ${BASELINE_OID}, patched ${PATCHED_OID}).`,
);
const trials = await runPool(tasks, CONCURRENCY);

function cell(arm: Arm, scenarioId: string) {
  const rows = trials.filter((trial) => trial.arm === arm && trial.scenarioId === scenarioId);
  const delivered = rows.filter((trial) => trial.delivered.length > 0).length;
  const errored = rows.filter((trial) => trial.error).length;
  return { rows, delivered, errored, n: rows.length };
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-absX * absX);
  return sign * y;
}

/** Two-proportion z-test, two-sided. */
function twoProportionP(a: { hits: number; n: number }, b: { hits: number; n: number }): number {
  if (a.n === 0 || b.n === 0) {
    return Number.NaN;
  }
  const pooledP = (a.hits + b.hits) / (a.n + b.n);
  const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / a.n + 1 / b.n));
  if (!Number.isFinite(se) || se === 0) {
    return 1;
  }
  const z = (b.hits / b.n - a.hits / a.n) / se;
  return 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
}

const lines: string[] = [];
const say = (line = "") => {
  lines.push(line);
  console.log(line);
};

say();
say("## Per-cell delivery (`message(action=send)` completed with `deliveryStatus: sent`)");
say();
say("| scenario | reply expected | baseline | patched |");
say("|---|---|---|---|");
for (const scenario of SCENARIOS) {
  const base = cell("baseline", scenario.id);
  const patched = cell("patched", scenario.id);
  say(
    `| \`${scenario.id}\` | ${scenario.replyExpected ? "yes" : "no"} | ` +
      `${base.delivered}/${base.n} | ${patched.delivered}/${patched.n} |`,
  );
}

function pooled(arm: Arm, predicate: (scenario: Scenario) => boolean) {
  let hits = 0;
  let n = 0;
  for (const scenario of SCENARIOS.filter(predicate)) {
    const stats = cell(arm, scenario.id);
    hits += stats.delivered;
    n += stats.n;
  }
  return { hits, n };
}

const replyBase = pooled("baseline", (s) => s.replyExpected);
const replyPatched = pooled("patched", (s) => s.replyExpected);
const ambientBase = pooled("baseline", (s) => !s.replyExpected);
const ambientPatched = pooled("patched", (s) => !s.replyExpected);
const replyP = twoProportionP(replyBase, replyPatched);
const ambientP = twoProportionP(ambientBase, ambientPatched);

const pct = (v: { hits: number; n: number }) =>
  v.n === 0 ? "n/a" : `${Math.round((100 * v.hits) / v.n)}% (${v.hits}/${v.n})`;

say();
say("## Pooled");
say();
say(
  `- Reply-expected delivery: baseline ${pct(replyBase)} -> patched ${pct(replyPatched)}` +
    ` (p=${Number.isNaN(replyP) ? "n/a" : replyP.toFixed(3)})`,
);
say(
  `- Ambient sends (lower is better): baseline ${pct(ambientBase)} -> patched ${pct(ambientPatched)}` +
    ` (p=${Number.isNaN(ambientP) ? "n/a" : ambientP.toFixed(3)})`,
);

const toolNames = new Set(trials.flatMap((trial) => trial.dynamicToolNames));
const errored = trials.filter((trial) => trial.error);
say();
say("## Production-path attestation");
say();
say(
  `- Baseline commit: \`${BASELINE_OID}\` (pre-fix parent; default ref \`${DEFAULT_BASELINE_REF}\`)`,
);
say(`- Patched commit: \`${PATCHED_OID}\``);
for (const scenario of SCENARIOS) {
  const baselineContext = renderChatContext("baseline", scenario);
  const patchedContext = renderChatContext("patched", scenario);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  say(
    `- ${scenario.id} context SHA-256: baseline \`${digest(baselineContext)}\`; patched \`${digest(patchedContext)}\``,
  );
}
say(
  `- Dynamic tools actually serialized to the app-server: ${[...toolNames].toSorted().join(", ") || "(none)"}`,
);
say(`- Codex app-server binary: managed \`@openai/codex\`; model: ${resolvedModelId}`);
say(
  `- Turns that reached a terminal state: ${trials.filter((t) => t.terminal === "ok").length}/${trials.length}`,
);
say(
  `- Chat-context paragraph verified byte-present in the app-server developer instructions: ` +
    `${trials.filter((t) => t.chatContextPresent).length}/${trials.length} turns`,
);
say(
  `- Current inbound context verified byte-present in Codex turn/start input: ` +
    `${trials.filter((t) => t.currentInboundContextPresent).length}/${trials.length} turns`,
);
say(`- Turns that errored: ${errored.length}`);
const sampleResults = trials.flatMap((t) => t.messageToolResults).slice(0, 3);
for (const sample of sampleResults) {
  say(`  - message() result sample: ${sample}`);
}
say(
  `- message() tool invocations observed: ${trials.reduce((sum, t) => sum + t.messageToolCalls, 0)}` +
    ` across ${trials.length} turns; source replies settled as sent: ` +
    `${trials.reduce((sum, t) => sum + t.delivered.length, 0)}; ` +
    `sends that reached the stubbed channel outbound adapter: ${channelAdapterDeliveries.length}`,
);
for (const t of trials) {
  say(
    `  - ${t.arm}/${t.scenarioId}#${t.replicate}: terminal=${t.terminal} messageCalls=${t.messageToolCalls}` +
      ` sent=${t.delivered.length} assistantChars=${t.assistantTextChars}` +
      ` tools=[${[...new Set(t.toolCalls)].join(",")}]` +
      ` messageOutcomes=[${t.messageToolOutcomes.join(",")}]`,
  );
}
for (const trial of errored.slice(0, 5)) {
  say(`  - ${trial.arm}/${trial.scenarioId}#${trial.replicate}: ${trial.error}`);
}

say();
say("## What This Does Not Prove");
say();
say("- Delivery is measured at the production source-reply settle point, not at a live chat. In");
say("  an embedded run with no gateway attached, the production path settles a source reply at");
say("  `sourceReplySink: internal-ui` (`channel: webchat`, `target: current-run`) rather than at");
say("  the channel plugin's outbound adapter, so `outbound.sendText` is not reached here even");
say("  though it is registered and stubbed. A genuine Telegram/Discord adapter failure");
say("  downstream of that settle point would not be caught by this run.");
say("- The turn runs with `oneShotCliRun` against a minimal temp workspace and an in-memory");
say("  binding store. A long-lived gateway session with real transcript history, hooks, and");
say("  compaction may behave differently.");
say("- Only the Codex app-server harness is covered. The Claude and other harnesses consume the");
say("  same chat-context paragraph through different prompt assemblies and are untested here.");
say("- The production harness-level visible-reply guidance (`buildHarnessVisibleReplyGuidance`,");
say("  emitted by `buildDeveloperInstructions` for `message_tool_only` runs) is present in BOTH");
say("  arms, because production always emits it. It independently pushes both arms toward calling");
say("  the message tool, which shrinks the measurable gap; the numbers above are conservative.");
say("- The per-turn `MESSAGE_TOOL_ONLY_DELIVERY_HINT` is included through the production");
say("  `currentInboundContext` field and verified in the actual Codex `turn/start` text input.");
say(
  "- Sample sizes are small and per-cell rates are noisy. Read the pooled p-values, not a single",
);
say("  cell.");

if (DUMP_EVENTS) {
  fs.mkdirSync(DUMP_EVENTS, { recursive: true });
  for (const trial of trials) {
    fs.writeFileSync(
      path.join(DUMP_EVENTS, `${trial.arm}.${trial.scenarioId}.${trial.replicate}.json`),
      `${JSON.stringify(trial.events, null, 2)}\n`,
      "utf8",
    );
  }
  console.log(`\nEvent dumps written to ${DUMP_EVENTS}`);
}

if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "summary.md"), `${lines.join("\n")}\n`, "utf8");
  fs.writeFileSync(
    path.join(OUT_DIR, "trials.json"),
    `${JSON.stringify(
      trials.map(({ developerInstructions: _drop, events: _drop2, ...rest }) => rest),
      null,
      2,
    )}\n`,
    "utf8",
  );
  // Redacted evidence: the exact developer instructions the app-server received in each
  // arm, plus the serialized message-tool spec the model was offered.
  for (const arm of ARMS) {
    const sample = trials.find(
      (trial) => trial.arm === arm && trial.scenarioId === "direct-addressed",
    );
    if (sample?.developerInstructions) {
      fs.writeFileSync(
        path.join(OUT_DIR, `developer-instructions.${arm}.txt`),
        `${sample.developerInstructions}\n`,
        "utf8",
      );
    }
    if (sample?.messageToolSpecJson) {
      fs.writeFileSync(
        path.join(OUT_DIR, `message-tool-spec.${arm}.json`),
        `${sample.messageToolSpecJson}\n`,
        "utf8",
      );
    }
  }
  console.log(`\nArtifacts written to ${OUT_DIR}`);
}

// ---------------------------------------------------------------------------
// Self-checks. A proof that can only pass is not a proof.
// ---------------------------------------------------------------------------

const failures: string[] = [];
if (!toolNames.has("message")) {
  failures.push(
    "the `message` tool was never serialized into the app-server tool set; the A/B is vacuous",
  );
}
if (errored.length > trials.length / 4) {
  failures.push(`${errored.length}/${trials.length} turns errored; the sample is not trustworthy`);
}
if (trials.some((trial) => trial.chatContextPresent === false)) {
  failures.push(
    "the arm's chat-context paragraph was NOT byte-present in the developer instructions sent " +
      "to the app-server; the A/B is not testing the changed prompt",
  );
}
if (trials.some((trial) => trial.currentInboundContextPresent === false)) {
  failures.push(
    "the production currentInboundContext bytes were NOT present in Codex turn/start input",
  );
}
if (
  !SCENARIOS.some(
    (scenario) =>
      renderChatContext("baseline", scenario) !== renderChatContext("patched", scenario),
  )
) {
  failures.push(
    `baseline ${BASELINE_OID} and patched ${PATCHED_OID} render identical chat contexts`,
  );
}
// Positive control. A run where NEITHER arm ever delivered has not observed the behavior
// under test, so "no regression" is meaningless. That must read as INCONCLUSIVE, not pass.
if (replyBase.hits === 0 && replyPatched.hits === 0) {
  failures.push(
    "INCONCLUSIVE: no reply-expected turn in either arm produced a delivery, so this run never " +
      "exercised the behavior under test. Do not read the equal rates as 'no regression'.",
  );
}
// Turns that produce neither assistant text nor a message call are degenerate: the model
// spent the turn on other tools and never answered. They dilute both arms equally but they
// measure nothing, so surface them rather than letting them pass as data.
const degenerate = trials.filter(
  (trial) => trial.assistantTextChars === 0 && trial.messageToolCalls === 0,
);
if (degenerate.length > trials.length / 2) {
  failures.push(
    `INCONCLUSIVE: ${degenerate.length}/${trials.length} turns ended without any assistant text ` +
      "or message call; the harness is measuring workspace exploration, not delivery",
  );
}
if (replyPatched.n > 0 && replyPatched.hits / replyPatched.n < replyBase.hits / replyBase.n) {
  failures.push(
    `patched arm delivered LESS often on reply-expected turns (${pct(replyBase)} -> ${pct(replyPatched)})`,
  );
}
if (
  ambientBase.n > 0 &&
  ambientPatched.hits / ambientPatched.n > ambientBase.hits / ambientBase.n &&
  ambientP < 0.05
) {
  failures.push(
    `patched arm significantly increased ambient sends (${pct(ambientBase)} -> ${pct(ambientPatched)}, p=${ambientP.toFixed(3)})`,
  );
}

say();
if (failures.length > 0) {
  say("## FAILED");
  for (const failure of failures) {
    say(`- ${failure}`);
  }
  process.exit(1);
}
say("All runtime assertions passed.");
