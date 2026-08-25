/**
 * Live A/B proof that the `message_tool_only` prompt rewrite changes real model
 * behavior, not just rendered prompt bytes (PR #128872).
 *
 * Why a live script instead of a vitest case: the seam under test is the model.
 * Snapshot fixtures and unit tests can only assert which bytes we render; they
 * cannot show that a model reading those bytes actually delivers through
 * `message(action=send)` instead of leaving the reply in its private final
 * answer. This script runs real model turns and reports a rate per arm.
 *
 * What is REAL here:
 * - The prompt bytes. Both arms come from the real prompt builders. The patched
 *   arm imports `buildGroupChatContext` / `buildDirectChatContext` from the
 *   working tree; the baseline arm loads the same two builders from a
 *   `git show <base-ref>:src/auto-reply/reply/groups.ts` extraction, so the
 *   pre-fix wording is the production wording, not a hand-copied string.
 * - The tool surface. `createMessageTool({ sourceReplyOnly: true,
 *   sourceReplyDeliveryMode: "message_tool_only" })` supplies the real tool
 *   name, description, and parameter schema the agent runtime exposes on a
 *   source-reply turn. Identical in both arms.
 * - The model. Real API turns against real models (OpenAI Responses API and/or
 *   the Anthropic Messages API).
 *
 * What is STUBBED (the outermost edge only):
 * - Channel delivery. The tool is never executed; a `message(action=send)` tool
 *   call IS the captured delivery signal. Nothing is sent to Slack, Discord,
 *   or Telegram.
 * - The surrounding agent system prompt. A short synthetic preamble plus a
 *   synthetic inbound-metadata block stands in for the full runtime prompt
 *   assembly. It is byte-identical across arms, so it cannot bias the A/B.
 * - Conversation content is synthetic; no real user text is used or printed.
 *
 * Scenarios (each run in both arms):
 * - `group-addressed` / `direct-addressed`: the agent is asked a question it
 *   should answer. A turn that produces prose but no `message(action=send)` is
 *   the reported bug: the person waiting gets nothing.
 * - `group-ambient`: chatter not addressed to the agent. Control for the
 *   opposite failure — the fix must not turn "stay quiet" turns into sends.
 *
 * Assertions (the script exits non-zero when any of these fail). They pin what
 * the patch is responsible for — delivery rate — not how good any given model
 * is in absolute terms:
 * - The baseline arm reproduces the non-delivery failure at least once.
 * - Across all models, the patched arm's reply-expected delivery rate exceeds
 *   the baseline arm's by at least MIN_ABSOLUTE_IMPROVEMENT, and the rise is
 *   significant under a one-sided two-proportion z-test.
 * - No model/scenario cell regresses significantly under the same test. A fixed
 *   percentage-point tolerance was tried first and rejected: at n=10 an ordinary
 *   binomial swing on a cell already near 100% trips it in whichever direction
 *   the run happens to land, which is a coin flip dressed as an assertion.
 * - Across all models, the patched arm's ambient send rate does not rise
 *   significantly.
 * - Fewer than MAX_TRIAL_ERROR_RATE of turns fail to produce a usable answer.
 *   Truncated turns (an output cap hit before any answer) count as errors, not
 *   as non-delivery — a truncated turn is not an observation of behavior.
 *
 * Credentials: needs `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`. With neither
 * set the script prints a SKIP line and exits 0, so it never breaks a gate on a
 * machine without model credentials. It is intentionally NOT part of the
 * standard validation gate: it costs real API calls and needs network.
 *
 * Run:
 *   pnpm tsx scripts/dev/message-tool-only-prompt-live-proof.ts
 *   pnpm tsx scripts/dev/message-tool-only-prompt-live-proof.ts \
 *     --trials 10 --models openai:gpt-5,anthropic:claude-sonnet-4-5 \
 *     --json /tmp/proof.json
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createMessageTool } from "../../src/agents/tools/message-tool-execution.js";
import type { TemplateContext } from "../../src/auto-reply/templating.js";

const MIN_ABSOLUTE_IMPROVEMENT = 0.1;
/** One-sided alpha for the two-proportion tests below. */
const SIGNIFICANCE_ALPHA = 0.05;
/** Cells this far apart are called out in the notes even when not significant. */
const NOTEWORTHY_DELTA = 0.15;
const MAX_TRIAL_ERROR_RATE = 0.1;
const CONCURRENCY = 6;
const ANTHROPIC_MAX_TOKENS = 6000;
const GROUPS_MODULE_RELATIVE_PATH = "src/auto-reply/reply/groups.ts";

const { values } = parseArgs({
  options: {
    trials: { type: "string", default: "10" },
    models: { type: "string" },
    "base-ref": { type: "string", default: "origin/main" },
    json: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log(
    "Usage: message-tool-only-prompt-live-proof.ts [--trials N] [--models provider:model,...] [--base-ref REF] [--json PATH]",
  );
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const trialsPerCell = Number.parseInt(values.trials ?? "10", 10);
if (!Number.isFinite(trialsPerCell) || trialsPerCell < 1) {
  throw new Error(`--trials must be a positive integer, got ${values.trials}`);
}

type Arm = "baseline" | "patched";
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
 * Loads the pre-fix builders straight out of git history. Relative import
 * specifiers are rewritten to absolute file URLs so the extracted copy resolves
 * against the working tree's unchanged siblings; nothing is written into the
 * repository.
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
  const file = path.join(mkdtempSync(path.join(tmpdir(), "mto-proof-baseline-")), "groups.ts");
  writeFileSync(file, rewritten, "utf8");
  return (await import(pathToFileURL(file).href)) as GroupsModule;
}

const patchedGroups = (await import("../../src/auto-reply/reply/groups.js")) as GroupsModule;
const baselineGroups = await loadBaselineGroupsModule(values["base-ref"] ?? "origin/main");

const messageTool = createMessageTool({
  sourceReplyOnly: true,
  sourceReplyDeliveryMode: "message_tool_only",
});

type Scenario = {
  id: string;
  chatType: "group" | "direct";
  provider: string;
  /** True when a competent participant should answer; false for ambient chatter. */
  replyExpected: boolean;
  inbound: string;
};

// All conversation content is synthetic. No real user text, names, or ids.
const SCENARIOS: Scenario[] = [
  {
    id: "group-addressed",
    chatType: "group",
    provider: "discord",
    replyExpected: true,
    inbound:
      "[#build-notes] teammate-a: @agent the nightly export job finished with 3 retries again. Can you explain what causes the retries and tell us whether we need to change anything before Friday's run?",
  },
  {
    id: "direct-addressed",
    chatType: "direct",
    provider: "telegram",
    replyExpected: true,
    inbound:
      "I'm about to bump the cache TTL from 60s to 600s on the pricing service. Walk me through what could break and what I should watch after the change.",
  },
  {
    id: "group-ambient",
    chatType: "group",
    provider: "discord",
    replyExpected: false,
    inbound:
      "[#build-notes] teammate-a: coffee machine on floor 2 is broken again\n[#build-notes] teammate-b: tragic. floor 3 one still works",
  },
];

function renderConversationContext(arm: Arm, scenario: Scenario): string {
  const groups = arm === "patched" ? patchedGroups : baselineGroups;
  const sessionCtx = {
    Provider: scenario.provider,
    ChatType: scenario.chatType,
  } as unknown as TemplateContext;
  return scenario.chatType === "direct"
    ? groups.buildDirectChatContext({ sessionCtx, sourceReplyDeliveryMode: "message_tool_only" })
    : groups.buildGroupChatContext({
        sessionCtx,
        sourceReplyDeliveryMode: "message_tool_only",
        silentReplyPolicy: "disallow",
        silentToken: "<<SILENT>>",
      });
}

/** Identical in both arms; only the conversation-context block differs. */
function buildSystemPrompt(arm: Arm, scenario: Scenario): string {
  return [
    "You are a helpful assistant agent participating in conversations through a messaging gateway. You have tools available; use them when they are the right way to accomplish something.",
    "### Inbound Context (trusted metadata)\n" +
      JSON.stringify({
        schema: "openclaw.inbound_meta.v2",
        channel: scenario.provider,
        provider: scenario.provider,
        chat_type: scenario.chatType,
      }),
    renderConversationContext(arm, scenario),
  ].join("\n\n");
}

type ToolCall = { name: string; args: Record<string, unknown> };
type TurnResult = { toolCalls: ToolCall[]; finalText: string; truncated: boolean };

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return (await response.json()) as Record<string, unknown>;
    }
    lastError = `${response.status} ${(await response.text()).slice(0, 300)}`;
    if (response.status < 500 && response.status !== 429) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1500 * (attempt + 1));
    });
  }
  throw new Error(`request failed: ${lastError}`);
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function runOpenAiTurn(model: string, system: string, user: string): Promise<TurnResult> {
  const payload = await postJson(
    "https://api.openai.com/v1/responses",
    { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
    {
      model,
      instructions: system,
      input: [{ role: "user", content: [{ type: "input_text", text: user }] }],
      tools: [
        {
          type: "function",
          name: messageTool.name,
          description: messageTool.description,
          parameters: messageTool.parameters,
        },
      ],
      store: false,
    },
  );
  const output = Array.isArray(payload.output) ? (payload.output as Record<string, unknown>[]) : [];
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];
  for (const item of output) {
    if (item.type === "function_call") {
      toolCalls.push({
        name: typeof item.name === "string" ? item.name : "",
        args: safeParseJson(item.arguments),
      });
      continue;
    }
    const content = Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : [];
    for (const part of content) {
      if (typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
  }
  const incomplete =
    payload.status === "incomplete" &&
    (payload.incomplete_details as Record<string, unknown> | undefined)?.reason ===
      "max_output_tokens";
  return {
    toolCalls,
    finalText: textParts.join("\n").trim(),
    truncated: incomplete,
  };
}

async function runAnthropicTurn(model: string, system: string, user: string): Promise<TurnResult> {
  const payload = await postJson(
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    {
      model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      tools: [
        {
          name: messageTool.name,
          description: messageTool.description,
          input_schema: messageTool.parameters,
        },
      ],
    },
  );
  const content = Array.isArray(payload.content)
    ? (payload.content as Record<string, unknown>[])
    : [];
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      toolCalls.push({
        name: typeof block.name === "string" ? block.name : "",
        args: (block.input as Record<string, unknown>) ?? {},
      });
    } else if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return {
    toolCalls,
    finalText: textParts.join("\n").trim(),
    truncated: payload.stop_reason === "max_tokens",
  };
}

type Outcome = "visible_send" | "private_final" | "silent" | "error";
type Trial = {
  model: string;
  arm: Arm;
  scenario: string;
  outcome: Outcome;
  finalTextLength: number;
  sample: string;
  error?: string;
};

function classify(result: TurnResult): Outcome {
  const sent = result.toolCalls.some(
    (call) =>
      call.name === "message" &&
      call.args.action === "send" &&
      typeof call.args.message === "string" &&
      call.args.message.trim().length > 0,
  );
  if (sent) {
    return "visible_send";
  }
  // A turn cut off by the output cap never got to decide anything; counting it
  // as non-delivery would manufacture evidence.
  if (result.truncated && result.finalText.length === 0) {
    return "error";
  }
  return result.finalText.length > 0 ? "private_final" : "silent";
}

async function runTrial(model: string, arm: Arm, scenario: Scenario): Promise<Trial> {
  const [provider, ...rest] = model.split(":");
  const modelId = rest.join(":");
  const system = buildSystemPrompt(arm, scenario);
  try {
    const result =
      provider === "anthropic"
        ? await runAnthropicTurn(modelId, system, scenario.inbound)
        : await runOpenAiTurn(modelId, system, scenario.inbound);
    const outcome = classify(result);
    return {
      model,
      arm,
      scenario: scenario.id,
      outcome,
      finalTextLength: result.finalText.length,
      sample: result.finalText.slice(0, 200),
      ...(outcome === "error" ? { error: "output cap reached before any answer" } : {}),
    };
  } catch (error) {
    return {
      model,
      arm,
      scenario: scenario.id,
      outcome: "error",
      finalTextLength: 0,
      sample: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = Array.from({ length: tasks.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]!();
    }
  });
  await Promise.all(workers);
  return results;
}

const requestedModels = (values.models ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const defaultModels = [
  ...(process.env.OPENAI_API_KEY ? ["openai:gpt-5", "openai:gpt-4.1"] : []),
  ...(process.env.ANTHROPIC_API_KEY ? ["anthropic:claude-sonnet-4-5"] : []),
];
const models = requestedModels.length > 0 ? requestedModels : defaultModels;

if (models.length === 0) {
  console.log(
    "SKIP: no model credentials found (set OPENAI_API_KEY and/or ANTHROPIC_API_KEY). This live proof needs a real model turn; nothing was verified.",
  );
  process.exit(0);
}

// Fail fast if the extracted baseline is not actually the pre-fix wording.
const baselineGroupPrompt = renderConversationContext("baseline", SCENARIOS[0]!);
const patchedGroupPrompt = renderConversationContext("patched", SCENARIOS[0]!);
if (!baselineGroupPrompt.includes("stays private and will not be posted")) {
  throw new Error(
    `baseline arm does not carry the pre-fix wording; is --base-ref ${values["base-ref"]} correct?`,
  );
}
if (
  patchedGroupPrompt.includes("stays private and will not be posted") ||
  !patchedGroupPrompt.includes("a reply left in your final answer reaches nobody")
) {
  throw new Error("patched arm does not carry the post-fix wording; check the working tree");
}

console.log("=== message_tool_only prompt A/B — live model proof (PR #128872) ===");
console.log(`models:   ${models.join(", ")}`);
console.log(`trials:   ${trialsPerCell} per (model x arm x scenario)`);
console.log(`base-ref: ${values["base-ref"]} (baseline arm prompt source)`);
console.log(`tool:     ${messageTool.name} (real descriptor from createMessageTool)\n`);
for (const scenario of SCENARIOS) {
  for (const arm of ["baseline", "patched"] as Arm[]) {
    console.log(`--- prompt bytes [${scenario.id} / ${arm}] ---`);
    console.log(renderConversationContext(arm, scenario));
  }
}
console.log("");

const tasks: (() => Promise<Trial>)[] = [];
for (const model of models) {
  for (const scenario of SCENARIOS) {
    for (const arm of ["baseline", "patched"] as Arm[]) {
      for (let trial = 0; trial < trialsPerCell; trial++) {
        tasks.push(() => runTrial(model, arm, scenario));
      }
    }
  }
}
const trials = await runPool(tasks, CONCURRENCY);

function cell(model: string, arm: Arm, scenarioId: string) {
  const rows = trials.filter(
    (trial) => trial.model === model && trial.arm === arm && trial.scenario === scenarioId,
  );
  const ok = rows.filter((row) => row.outcome !== "error");
  const sends = ok.filter((row) => row.outcome === "visible_send").length;
  return {
    rows,
    total: ok.length,
    sends,
    privateFinals: ok.filter((row) => row.outcome === "private_final").length,
    silent: ok.filter((row) => row.outcome === "silent").length,
    errors: rows.length - ok.length,
    rate: ok.length > 0 ? sends / ok.length : 0,
  };
}

console.log("=== results ===");
console.log("model | scenario | arm | visible_send | private_final | silent | err | send rate");
for (const model of models) {
  for (const scenario of SCENARIOS) {
    for (const arm of ["baseline", "patched"] as Arm[]) {
      const stats = cell(model, arm, scenario.id);
      console.log(
        `${model} | ${scenario.id} | ${arm} | ${stats.sends} | ${stats.privateFinals} | ${stats.silent} | ${stats.errors} | ${(stats.rate * 100).toFixed(0)}% (${stats.sends}/${stats.total})`,
      );
    }
  }
}

const failures: string[] = [];
const errorRate = trials.filter((trial) => trial.outcome === "error").length / trials.length;
if (errorRate > MAX_TRIAL_ERROR_RATE) {
  failures.push(`trial error rate ${(errorRate * 100).toFixed(0)}% exceeds the allowed 10%`);
  for (const trial of trials.filter((row) => row.outcome === "error").slice(0, 3)) {
    failures.push(`  sample error (${trial.model}): ${trial.error}`);
  }
}

/** Abramowitz & Stegun 7.1.26; max error ~1.5e-7, ample for a 0.05 threshold. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * One-sided p-value for "the patched arm's rate is worse than the baseline's",
 * via a pooled two-proportion z-test. A fixed percentage-point tolerance cannot
 * do this job: at n=10 a 20-point swing is ordinary sampling noise, so a fixed
 * threshold either flags noise or hides real regressions depending on n.
 */
function regressionPValue(
  before: { sends: number; total: number },
  after: { sends: number; total: number },
): number {
  if (before.total === 0 || after.total === 0) {
    return 1;
  }
  const pooledRate = (before.sends + after.sends) / (before.total + after.total);
  const standardError = Math.sqrt(
    pooledRate * (1 - pooledRate) * (1 / before.total + 1 / after.total),
  );
  if (standardError === 0) {
    return 1;
  }
  const z = (after.sends / after.total - before.sends / before.total) / standardError;
  return normalCdf(z);
}

function pooled(arm: Arm, scenarios: Scenario[]) {
  let sends = 0;
  let total = 0;
  for (const model of models) {
    for (const scenario of scenarios) {
      const stats = cell(model, arm, scenario.id);
      sends += stats.sends;
      total += stats.total;
    }
  }
  return { sends, total, rate: total > 0 ? sends / total : 0 };
}

const replyExpected = SCENARIOS.filter((scenario) => scenario.replyExpected);
const ambient = SCENARIOS.filter((scenario) => !scenario.replyExpected);
let baselineNonDelivery = 0;
for (const model of models) {
  for (const scenario of replyExpected) {
    const before = cell(model, "baseline", scenario.id);
    const after = cell(model, "patched", scenario.id);
    baselineNonDelivery += before.privateFinals + before.silent;
    const p = regressionPValue(before, after);
    if (p < SIGNIFICANCE_ALPHA) {
      failures.push(
        `${model}/${scenario.id}: patched delivery rate ${(after.rate * 100).toFixed(0)}% (${after.sends}/${after.total}) is significantly below baseline ${(before.rate * 100).toFixed(0)}% (${before.sends}/${before.total}), one-sided p=${p.toFixed(3)}`,
      );
    }
  }
}

// Pooled rates hide per-model behavior, and the interesting cases live in the
// cells. Surface them explicitly so a reader does not have to reconstruct them.
const notes: string[] = [];
for (const model of models) {
  for (const scenario of replyExpected) {
    const before = cell(model, "baseline", scenario.id);
    const after = cell(model, "patched", scenario.id);
    if (after.total > 0 && after.rate < 0.5) {
      notes.push(
        `RESIDUAL: ${model}/${scenario.id} still fails to deliver on ${after.total - after.sends}/${after.total} patched turns (baseline ${before.sends}/${before.total}) — prompt wording alone does not rescue this model`,
      );
    }
  }
  for (const scenario of ambient) {
    const before = cell(model, "baseline", scenario.id);
    const after = cell(model, "patched", scenario.id);
    if (after.total > 0 && after.rate > before.rate + NOTEWORTHY_DELTA) {
      notes.push(
        `CHATTIER: ${model}/${scenario.id} sends on ${after.sends}/${after.total} patched ambient turns vs ${before.sends}/${before.total} baseline (one-sided p=${regressionPValue(after, before).toFixed(3)} for the rise)`,
      );
    }
  }
}

const deliveryBefore = pooled("baseline", replyExpected);
const deliveryAfter = pooled("patched", replyExpected);
console.log(
  `\npooled reply-expected delivery: baseline ${(deliveryBefore.rate * 100).toFixed(0)}% (${deliveryBefore.sends}/${deliveryBefore.total}) -> patched ${(deliveryAfter.rate * 100).toFixed(0)}% (${deliveryAfter.sends}/${deliveryAfter.total})`,
);
if (ambient.length > 0) {
  const ambientBefore = pooled("baseline", ambient);
  const ambientAfter = pooled("patched", ambient);
  console.log(
    `pooled ambient send rate:      baseline ${(ambientBefore.rate * 100).toFixed(0)}% (${ambientBefore.sends}/${ambientBefore.total}) -> patched ${(ambientAfter.rate * 100).toFixed(0)}% (${ambientAfter.sends}/${ambientAfter.total})`,
  );
  const ambientRiseP = regressionPValue(ambientAfter, ambientBefore);
  console.log(`  (one-sided p for the ambient rise: ${ambientRiseP.toFixed(3)})`);
  if (ambientRiseP < SIGNIFICANCE_ALPHA) {
    failures.push(
      `pooled ambient send rate rose significantly from ${(ambientBefore.rate * 100).toFixed(0)}% to ${(ambientAfter.rate * 100).toFixed(0)}% (p=${ambientRiseP.toFixed(3)}) — the fix must not make the agent chattier on turns that need no reply`,
    );
  }
}
const improvementP = regressionPValue(deliveryAfter, deliveryBefore);
console.log(`  (one-sided p for the delivery improvement: ${improvementP.toFixed(3)})`);
if (deliveryAfter.rate < deliveryBefore.rate + MIN_ABSOLUTE_IMPROVEMENT) {
  failures.push(
    `pooled delivery improvement ${((deliveryAfter.rate - deliveryBefore.rate) * 100).toFixed(0)} points is below the required ${(MIN_ABSOLUTE_IMPROVEMENT * 100).toFixed(0)} points`,
  );
}
if (improvementP >= SIGNIFICANCE_ALPHA) {
  failures.push(
    `pooled delivery improvement is not statistically significant (one-sided p=${improvementP.toFixed(3)}, need < ${SIGNIFICANCE_ALPHA})`,
  );
}
if (baselineNonDelivery === 0) {
  failures.push(
    "PREMISE NOT REPRODUCED: the baseline (pre-fix) prompt delivered on every reply-expected turn, so this run shows no failure for the patch to remove",
  );
}

if (notes.length > 0) {
  console.log("\n=== notes (not assertion failures; report these honestly) ===");
  for (const note of notes) {
    console.log(` - ${note}`);
  }
}

if (values.json) {
  writeFileSync(
    path.resolve(values.json),
    JSON.stringify(
      { models, trialsPerCell, baseRef: values["base-ref"], scenarios: SCENARIOS, trials },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nper-trial records written to ${path.resolve(values.json)}`);
}

console.log("\n=== example private-final turns from the baseline arm (the reported bug) ===");
const bugSamples = trials.filter(
  (trial) => trial.arm === "baseline" && trial.outcome === "private_final",
);
for (const sample of bugSamples.slice(0, 3)) {
  console.log(
    `[${sample.model} / ${sample.scenario}] zero message(action=send) calls, ${sample.finalTextLength}-char private final: "${sample.sample.replace(/\s+/gu, " ")}…"`,
  );
}
if (bugSamples.length === 0) {
  console.log("(none in this run)");
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}

const ambientDelta =
  ambient.length > 0 ? pooled("patched", ambient).rate - pooled("baseline", ambient).rate : 0;
console.log(
  `\nAll runtime assertions passed. Baseline non-delivery turns: ${baselineNonDelivery}. Pooled delivery on reply-expected turns rose ${((deliveryAfter.rate - deliveryBefore.rate) * 100).toFixed(0)} points (one-sided p=${improvementP.toFixed(3)}), no per-model cell regressed significantly, and the pooled ambient send rate moved ${ambientDelta >= 0 ? "+" : ""}${(ambientDelta * 100).toFixed(0)} points without reaching significance${notes.length > 0 ? `. ${notes.length} note(s) above qualify this result.` : "."}`,
);
process.exit(0);
