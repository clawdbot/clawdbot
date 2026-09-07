import {
  getRuntimeConfigSnapshot,
  type OpenClawConfig,
  type PluginRuntime,
  type PluginLogger,
  type SessionTurnCurrencyPolicy,
} from "../api.js";
import { materializeAttachments } from "./attachment-materializer.js";
import { inferBuiltinSkillName, validateBuiltinSkillSelection } from "./builtin-skill-routing.js";
import {
  buildCitationDirective,
  splitCitations,
  stripDanglingCitationMarkers,
} from "./citations.js";
import type { DownloadManager } from "./download-manager.js";
import type { FeedCounter } from "./feed-counter.js";
import type { HistoryManager } from "./history-manager.js";
import { mediaLinesToMarkdown } from "./media-lines.js";
import {
  MercurePusher,
  StreamingMercurePusher,
  type MercureEventPusher,
} from "./mercure-pusher.js";
import { extractMessageText } from "./message-text.js";
import { computeDateScope, type ReportPeriod } from "./report-period.js";
import type { ReportTaskPublisher } from "./report-task-publisher.js";
import type { ResolvedTemplate, ReportTemplateLookup } from "./report-template-lookup.js";
import { normalizeChineseProseQuotes, sanitizeInternalRefs } from "./sanitize-output.js";
import { prepareHistorySessionSnapshot } from "./session-snapshot.js";
import type { ResolvedSkill, SkillLookup } from "./skill-lookup.js";
import { buildSuhengDesignContext } from "./suheng-design-context.js";
import { SUHENG_RUNTIME_SYSTEM_PROMPT } from "./suheng-runtime-context.js";
import { buildSuhengWorkspaceContext } from "./suheng-workspace-context.js";
import { ToolActivityNarrator, type ActivityStep, type StepCategory } from "./tool-activity.js";
import { pickTopicByLlm } from "./topic-llm-picker.js";
import { pickTopicByName } from "./topic-match.js";
import type { TopicInfo, TopicResolver } from "./topic-resolver.js";
import { persistTurnUsage } from "./turn-usage-writer.js";
import type { ChatMessage, MercureConfig } from "./types.js";

/** Hard cap on injected template body, so a huge MEDIUMTEXT can't blow the prompt. */
const TEMPLATE_BODY_MAX = 6000;

/** Per-skill and total caps on injected skill instructions, so many/long skills can't blow the prompt. */
const SKILL_BODY_MAX = 4000;
const SKILL_CONTEXT_TOTAL_MAX = 12000;

/**
 * These capabilities judge the supplied public content on its own merits. A
 * user's default monitoring project is authorization metadata, not the target
 * of the judgment. Injecting an enterprise topic here can make the model invent
 * that enterprise as the complainant (history_messages #2271).
 */
const SUBJECT_AGNOSTIC_VIOLATION_CAPABILITY =
  /(?:机构违规研判(?:及举报)?|通用违规研判(?:和举报函|及举报)?)/;

/**
 * Signals that the user wants data from one of their monitoring projects.
 * Keep these deliberately narrower than general words such as "项目", "风险", or
 * "负面": those occur constantly in writing, document review, and ordinary chat.
 */
const MONITORING_TOPIC_INTENT_PATTERNS = [
  /(?:(?:舆情|网络|全网)?(?:监测|监控)(?:项目|专题)|舆情(?:项目|专题))/iu,
  /(?:舆情|监测)(?:数据|记录|条目|列表|明细|动态|趋势|分布|声量|热度|来源|信源|预警|统计|结果)/iu,
  /(?:数据|记录|条目|列表|明细|动态|趋势|分布|声量|热度|来源|信源|预警|统计|结果).{0,4}(?:舆情|监测)/iu,
  /(?:查询|查找|检索|排查|统计|汇总|筛选|调取|获取|拉取|读取|查看|关注|跟踪|追踪|看看|看一下|查一下).{0,16}(?:舆情|舆论动态|网络动态|媒体动态)/iu,
  /(?:今天|昨日|昨天|本周|这周|本月|这个月|最近|近[一二两三四五六七八九十\d]+(?:天|周|月)|过去[一二两三四五六七八九十\d]+(?:天|周|月)).{0,12}(?:负面|正面|中性)(?:舆情|信息|新闻|报道|内容|帖子|文章|动态)?/iu,
  /(?:负面|正面|中性)(?:舆情|信息|新闻|报道|内容|帖子|文章|动态)?.{0,10}(?:多少|几条|数据|趋势|分布|声量|热度)/iu,
];

function shouldInjectTopicContext(message: string, templateReportPending: boolean): boolean {
  if (SUBJECT_AGNOSTIC_VIOLATION_CAPABILITY.test(message)) {
    return false;
  }
  return (
    templateReportPending ||
    MONITORING_TOPIC_INTENT_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * Build the context block injected into the chat agent for the user's active
 * custom skills (the "我的Skills" panel). Each skill's instruction body is
 * treated as an authoritative directive the agent should follow this turn. The
 * block is injected into the agent context — NOT spliced into the user's
 * visible message — so the chat bubble never shows the raw instructions.
 * Returns "" when no skill has usable content. Bounded per-skill and in total.
 */
function buildSkillContext(skills: ResolvedSkill[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const skill of skills) {
    const body = skill.content?.trim();
    if (!body) {
      continue;
    }
    const clipped =
      body.length > SKILL_BODY_MAX
        ? `${body.slice(0, SKILL_BODY_MAX)}\n…(技能内容过长，已截断)`
        : body;
    const desc = skill.description?.trim() ? `（${skill.description.trim()}）` : "";
    const entry = `● 技能「${skill.name}」${desc}：\n${clipped}`;
    // Stop before exceeding the overall cap; the skills already added still apply.
    if (total + entry.length > SKILL_CONTEXT_TOTAL_MAX) {
      break;
    }
    parts.push(entry);
    total += entry.length;
  }
  if (parts.length === 0) {
    return "";
  }
  return (
    "\n\n[用户启用了以下自定义技能，请在本轮严格按这些技能的指令来完成任务；" +
    "如多个技能有冲突，以更具体的要求为准，并可向用户澄清]：\n" +
    `---启用的技能开始---\n${parts.join("\n\n")}\n---启用的技能结束---`
  );
}

/**
 * Build the context block injected into the chat agent when the user has a
 * report template selected but is conversing (not requesting generation), so
 * "先学习一下这份模板" lets the agent actually read and reason about the body.
 * Returns "" when there is no usable template content.
 */
function buildTemplateContext(template: ResolvedTemplate): string {
  const body = template.content?.trim();
  if (!body) {
    return "";
  }
  const clipped =
    body.length > TEMPLATE_BODY_MAX
      ? `${body.slice(0, TEMPLATE_BODY_MAX)}\n…(模板内容过长，已截断)`
      : body;
  const desc = template.description?.trim() ? `，说明：${template.description.trim()}` : "";
  return (
    `\n\n[用户当前选中了报告模板] 名称：${template.name}（${template.period}）${desc}。` +
    "以下是该模板的正文，供你学习和参考（除非用户明确要求，否则不要原样输出整段模板）：\n" +
    `---模板正文开始---\n${clipped}\n---模板正文结束---`
  );
}

/**
 * Resolve the assistant text delta from an agent event payload.
 * The event carries `data.delta` (streaming) or `data.text` (final).
 */
function extractAssistantDelta(data: Record<string, unknown>): string {
  const delta = data.delta;
  const text = data.text;
  if (typeof delta === "string") {
    return delta;
  }
  if (typeof text === "string") {
    return text;
  }
  return "";
}

/**
 * Pick the requirement-named topic from the user's authorized set, preferring
 * the LLM classifier and falling back to deterministic substring matching.
 *
 * The LLM understands intent the substring matcher can't — abbreviations like
 * "深圳农行" -> "农业银行深圳市分行", and it ignores generic domain words
 * ("舆情/日报") that used to cause spurious matches. When the model is
 * unavailable, times out, is unsure, or picks an out-of-set id, pickTopicByLlm
 * returns null and we fall back to pickTopicByName. Both are bounded to the
 * authorized set, so neither can reach a project the user does not own.
 */
async function matchRequirementTopic(
  requirement: string,
  topics: TopicInfo[],
  logger: PluginLogger,
  userId: string,
  runtime?: PluginRuntime,
  token?: string | number,
): Promise<TopicInfo | null> {
  if (runtime && token !== undefined) {
    const llmMatch = await pickTopicByLlm({
      requirement,
      topics,
      subagent: runtime.subagent,
      userId,
      token,
      logger,
    });
    if (llmMatch) {
      logger.info(
        `[CHAT_PIPELINE] LLM matched topic ${JSON.stringify(llmMatch.topicName)} ` +
          `(#${llmMatch.topicId}) for userId=${userId}`,
      );
      return llmMatch;
    }
  }
  return pickTopicByName(requirement, topics);
}

/**
 * Resolve the user's report topic (entity_auth: uid -> masterId/slaveId).
 * Returns zeros when no resolver/mapping exists for the explicit-template report path.
 *
 * When the requirement names a project ("...南方基金..."), the best match WITHIN
 * the user's authorized topics wins over the default primary topic — so a
 * multi-project user gets the report they asked for, not just their most
 * recently granted one. Matching is bounded to the authorized set, never the
 * whole feed_topic table, so it can't be used to reach an unowned project.
 */
async function resolveReportTopic(args: {
  userId: string;
  topicResolver: TopicResolver | undefined;
  logger: PluginLogger;
  requirement?: string;
  /** Enables the LLM topic picker; omit to use only substring matching. */
  runtime?: PluginRuntime;
  /** Uniqueness token for the picker's isolated session (e.g. historyId). */
  token?: string | number;
}): Promise<{ topicId: number; useSlaveTopic: boolean; masterId: number }> {
  const { userId, topicResolver, logger, requirement, runtime, token } = args;
  if (!topicResolver) {
    return { topicId: 0, useSlaveTopic: false, masterId: 0 };
  }
  const resolution = await topicResolver.getTopicIdsByUser(userId);

  // Default: the user's primary (most recently granted) topic.
  let chosen = {
    topicId: resolution.topicId ?? 0,
    useSlaveTopic: resolution.useSlaveTopic,
    masterId: resolution.masterId,
  };

  // Prefer a requirement-named project when the user owns several.
  if (requirement && resolution.topics.length > 1) {
    const match = await matchRequirementTopic(
      requirement,
      resolution.topics,
      logger,
      userId,
      runtime,
      token,
    );
    if (match && match.topicId !== chosen.topicId) {
      logger.info(
        `[CHAT_PIPELINE] Requirement matched topic ${JSON.stringify(match.topicName)} ` +
          `(#${match.topicId}) over primary #${chosen.topicId} for userId=${userId}`,
      );
      chosen = {
        topicId: match.topicId,
        useSlaveTopic: match.useSlaveTopic,
        masterId: match.masterId,
      };
    }
  }

  logger.info(
    `[CHAT_PIPELINE] Resolved topicId=${chosen.topicId}, useSlaveTopic=${chosen.useSlaveTopic}, ` +
      `masterId=${chosen.masterId} for userId=${userId}`,
  );
  return chosen;
}

/**
 * Queue a report task and acknowledge it instantly. The report itself is
 * generated asynchronously by the report-generator service.
 *
 * The ack is never blocked on a feed COUNT: a high-volume topic (广汽本田 etc.)
 * makes that COUNT slow, and running it BEFORE the ack used to blow the
 * frontend's response deadline (which now shows the standard Suheng learning fallback).
 * The empty-data case is now handled authoritatively by the report-generator
 * (it short-circuits to a "暂无数据" report when its full-set total is 0); the
 * COUNT here is a best-effort volume hint pushed off the critical path.
 * Always emits a Mercure `done` so the frontend unlocks.
 */
interface EnqueueReportTaskArgs {
  period: ReportPeriod;
  requirement: string;
  dateScope: { start: string; end: string };
  topicId: number;
  useSlaveTopic: boolean;
  /** Master topic id from entity_auth; stored as download.topicId in slave mode. */
  masterId: number;
  /** report_template.id the user picked explicitly. */
  templateId: number;
  chatMsg: ChatMessage;
  mercure: MercureEventPusher;
  mercureTopic: string;
  downloadManager: DownloadManager;
  feedCounter: FeedCounter | undefined;
  reportTaskPublisher: ReportTaskPublisher | undefined;
  logger: PluginLogger;
}

/**
 * Create the report task row and kick off asynchronous generation: open the
 * frontend report card (`report_created`), notify the report-generator, and fire
 * off a best-effort volume hint. Does NOT push reply text or `done` — the caller
 * owns the user-facing reply (a keyword ack, or the streamed acknowledgement on
 * the template path). Returns the new task id.
 */
async function enqueueReportTask(args: EnqueueReportTaskArgs): Promise<number> {
  const {
    period,
    requirement,
    dateScope,
    topicId,
    useSlaveTopic,
    masterId,
    templateId,
    chatMsg,
    mercure,
    mercureTopic,
    downloadManager,
    feedCounter,
    reportTaskPublisher,
    logger,
  } = args;

  const uid = parseInt(chatMsg.userId, 10) || 0;
  const taskId = await downloadManager.createReportTask({
    uid,
    topicId,
    requirement,
    period,
    dateScope,
    title: `${period}舆情报告`,
    useSlaveTopic,
    masterId,
    mercureTopic,
    templateId,
    // Originating history row, so the report-generator can write the finished
    // report back into it (metadata.report) for the lobster history view.
    historyId: chatMsg.historyId,
    // Same per-user agent the chat runs under, so the report subagent
    // inherits its workspace, DB skills, and schema knowledge.
    agentId: `rabbitmq-${chatMsg.userId}`,
  });
  logger.info(`[CHAT_PIPELINE] Created report task #${taskId} for user ${uid}`);

  // Let the frontend open a report card for this taskId right away; progress
  // (`report_text`) and the final `report` event will target the same card.
  await mercure.pushReportCreated(mercureTopic, taskId);

  // Notify the report-generator so it starts immediately instead of waiting
  // for its fallback poll cycle. Publish failure is tolerated: the poller picks
  // up the Pending task.
  if (reportTaskPublisher) {
    const published = await reportTaskPublisher.publishTaskCreated(taskId);
    if (published) {
      logger.info(`[CHAT_PIPELINE] Notified report-generator for task #${taskId}`);
    }
  }

  // Best-effort data-volume hint, fully decoupled from the ack: a COUNT over a
  // large topic can be slow, so it runs fire-and-forget and only emits a
  // transient `progress` line once it resolves. Failures and the empty case are
  // swallowed here — the report-generator owns the authoritative empty-data
  // message, so a slow or zero count never delays or blocks the user.
  if (feedCounter && topicId > 0) {
    void feedCounter
      .countFeedData(topicId, dateScope.start, dateScope.end, useSlaveTopic)
      .then((feedCount) => {
        logger.info(
          `[CHAT_PIPELINE] Feed count=${feedCount} for topicId=${topicId} ` +
            `(${dateScope.start} ~ ${dateScope.end})`,
        );
        if (feedCount > 0) {
          void mercure.pushProgress(
            mercureTopic,
            `已检索到 ${feedCount} 条数据，正在生成${period}…`,
            chatMsg.historyId,
          );
        }
      })
      .catch((err) => {
        logger.warn(`[CHAT_PIPELINE] Feed count failed (non-fatal): ${String(err)}`);
      });
  }

  return taskId;
}

/**
 * Process a chat message from RabbitMQ with real-time streaming:
 *
 * 1. Fetch history record from MySQL
 * 2. Idempotency check (skip if already has response)
 * 3. Subscribe to agent events for streaming push
 * 4. Run OpenClaw subagent to generate response
 * 5. Wait for completion and extract response
 * 6. Update MySQL history record
 * 7. Push any remaining response via Mercure + done signal
 *
 * The streaming mirrors the Python `_stream_response_with_mercure` pattern:
 * each LLM text delta is forwarded to the frontend in near-real-time via
 * Mercure SSE, creating a typewriter effect.
 */
/**
 * Best-effort pre-warm of a user's chat agent, triggered when the frontend
 * opens the chat. Pays the cold-start cost up front — agent session spawn,
 * injected-prompt loading, model connection, and provider context-cache priming
 * for the shared system-prompt prefix — so the user's FIRST real message returns
 * far faster. Runs in a dedicated warmup session so it never pollutes the user's
 * real conversation history, and never pushes anything to Mercure. All failures
 * are swallowed: a warmup must never affect the user-visible flow.
 */
export async function warmupAgent(
  userId: string,
  runtime: PluginRuntime,
  logger: PluginLogger,
): Promise<void> {
  if (!userId) {
    return;
  }
  try {
    const agentId = `rabbitmq-${userId}`;
    const sessionKey = `agent:${agentId}:rabbitmq-warmup:${userId}`;
    logger.info(`[CHAT_PIPELINE] Warmup starting for agentId=${agentId}`);
    const runResult = await runtime.subagent.run({
      sessionKey,
      // Trivial turn: just enough to load the agent + prime the model/cache.
      message: "[warmup] 仅回复 OK，无需调用任何工具。",
      deliver: false,
    });
    await runtime.subagent.waitForRun({ runId: runResult.runId, timeoutMs: 60_000 });
    logger.info(`[CHAT_PIPELINE] Warmup completed for agentId=${agentId}`);
  } catch (err) {
    logger.warn(`[CHAT_PIPELINE] Warmup failed (non-fatal): ${String(err)}`);
  }
}

/** Per-turn execution limits handed down from the plugin config. */
export type ChatTurnOptions = {
  /**
   * Duration of each `waitForRun` polling window. An elapsed window does not
   * cancel or fail the turn; the pipeline starts another wait window.
   */
  turnTimeoutMs?: number;
  /** Local/debug-only event sink. Production callers default to the real Mercure client. */
  eventPusher?: MercureEventPusher;
  /** Local-debug observation hook; receives only Skills already authorized for this user. */
  onSkillsResolved?: (skills: readonly ResolvedSkill[]) => void;
  /** Stops this turn's embedded OpenClaw run when the web client cancels it. */
  abortSignal?: AbortSignal;
  /** Host abort seam, injected by the plugin entrypoint and tests. */
  abortRun?: (sessionKey: string) => boolean | Promise<boolean>;
};

/** Five-minute polling windows keep the Gateway RPC bounded without limiting the whole turn. */
export const DEFAULT_TURN_TIMEOUT_MS = 300_000;
/** Below a minute no realistic tool-using turn finishes; above an hour the broker complains. */
const MIN_TURN_TIMEOUT_MS = 60_000;
const MAX_TURN_TIMEOUT_MS = 3_600_000;

/**
 * Clamp a configured polling window into the supported range. This bounds each
 * Gateway RPC only; it is not a deadline for the whole embedded run.
 */
export function resolveTurnTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TURN_TIMEOUT_MS;
  }
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.floor(value)));
}

export async function processChatMessage(
  chatMsg: ChatMessage,
  historyManager: HistoryManager,
  mercureConfig: MercureConfig,
  runtime: PluginRuntime,
  logger: PluginLogger,
  downloadManager?: DownloadManager,
  topicResolver?: TopicResolver,
  feedCounter?: FeedCounter,
  reportTaskPublisher?: ReportTaskPublisher,
  templateLookup?: ReportTemplateLookup,
  skillLookup?: SkillLookup,
  /**
   * Live config used to resolve the agent workspace for attachment
   * materialization. Passed from the plugin api (`api.config`) because the
   * process-global runtime snapshot isn't populated in this consumer's path.
   */
  config?: OpenClawConfig,
  /**
   * Currency policy for per-turn cost accounting (see usage-pricing.ts). When
   * omitted the turn still runs; only the token/cost writeback is skipped.
   */
  usageCurrency?: SessionTurnCurrencyPolicy,
  /**
   * Per-turn execution limits. Bundled into an options object so future knobs
   * do not keep extending this already long positional signature.
   */
  options?: ChatTurnOptions,
): Promise<string> {
  const turnTimeoutMs = resolveTurnTimeoutMs(options?.turnTimeoutMs);
  const mercure = options?.eventPusher ?? new MercurePusher(mercureConfig);

  // Declare streamPusherCtx early so it's available in catch block
  const streamPusherCtx: { streamPusher: StreamingMercurePusher | null } = { streamPusher: null };

  // Work-process ("工作过程") timeline accumulated as the turn streams, then
  // persisted to history_messages.metadata so the lobster history view can
  // replay the panel. Declared at function scope so EVERY exit path (success,
  // subagent error/timeout, connection reset, unhandled throw) can finalize and
  // persist it — see persistTimeline. Carries only sanitized
  // label/category/status/duration plus bounded public observations assembled
  // from allowlisted tool fields, never raw tool args (see ActivityStep).
  type StoredStep = {
    id: string;
    index: number;
    label: string;
    category: StepCategory;
    status: "running" | "completed" | "failed";
    durationMs?: number;
    detail?: string;
    publicNarrative?: string[];
  };
  const storedSteps: StoredStep[] = [];
  let timelinePersisted = false;
  // Finalize and persist the timeline. Any step still "running" is coerced to a
  // terminal status first: the live panel relies on the stream's `done` event to
  // finalize stragglers, but history replay has no `done`, so a leftover running
  // step (e.g. a tool whose `end` was missed, or all steps on an error turn)
  // would spin forever. Idempotent (writes at most once) and best-effort (a
  // metadata write failure must never fail an already-decided turn).
  const persistTimeline = async (finalStatus: "completed" | "failed"): Promise<void> => {
    if (timelinePersisted || storedSteps.length === 0) {
      return;
    }
    timelinePersisted = true;
    for (const s of storedSteps) {
      if (s.status === "running") {
        s.status = finalStatus;
      }
    }
    try {
      await historyManager.updateMetadata(chatMsg.historyId, { steps: storedSteps });
    } catch (metaErr) {
      logger.warn(
        `[CHAT_PIPELINE] Persisting steps metadata failed (non-fatal): ${String(metaErr)}`,
      );
    }
  };

  // Per-turn token/cost accounting. Filled in just before the agent run so the
  // window starts at the run, and declared at function scope so EVERY exit path
  // (success, subagent error/timeout, connection reset) bills the turn — an
  // errored turn still burned tokens. Idempotent (bills at most once) and
  // best-effort (see persistTurnUsage).
  let usageContext: { sessionKey: string; agentId: string; sinceMs: number } | null = null;
  let usageBilled = false;
  const persistUsage = async (): Promise<void> => {
    const ctx = usageContext;
    if (usageBilled || !ctx || !usageCurrency) {
      return;
    }
    usageBilled = true;
    await persistTurnUsage({
      historyId: chatMsg.historyId,
      ...ctx,
      historyManager,
      policy: usageCurrency,
      config,
      logger,
    });
  };

  try {
    // Step 1: Fetch history record
    logger.info(
      `[CHAT_PIPELINE] Processing message: historyId=${chatMsg.historyId}, ` +
        `userId=${chatMsg.userId}, sessionId=${chatMsg.sessionId}`,
    );

    const record = await historyManager.getRecord(chatMsg.historyId);
    if (!record) {
      logger.error(`[CHAT_PIPELINE] History record not found: ${chatMsg.historyId}`);
      return `Error: History record ${chatMsg.historyId} not found`;
    }

    // Step 2: Idempotency check
    if (record.response) {
      logger.info(`[CHAT_PIPELINE] Record ${chatMsg.historyId} already has response, skipping`);
      return record.response;
    }

    // Resolve the user message (prefer from chat body, fallback to record)
    const userMessage = chatMsg.message?.trim() || record.message;
    const sessionId = chatMsg.sessionId || record.sessionId;
    const userId = chatMsg.userId || record.userId;
    const mercureTopic = chatMsg.topic || userId;

    // The frontend may explicitly select a bundled skill. For unmistakable
    // public-opinion deliverables, also route deterministically when the user
    // typed the request directly. Relying on discovery among the full skill
    // catalog made identical report requests follow different evidence/search
    // workflows depending on whether the skill picker happened to be used.
    const builtinSkillName = chatMsg.builtinSkillName ?? inferBuiltinSkillName(userMessage);
    await validateBuiltinSkillSelection(
      builtinSkillName,
      skillLookup ? (name) => skillLookup.isPublishedPublicSkill(name) : undefined,
    );
    const inferredBuiltinSkillName = chatMsg.builtinSkillName ? undefined : builtinSkillName;
    if (inferredBuiltinSkillName) {
      logger.info(
        `[CHAT_PIPELINE] Auto-selected builtin skill ${inferredBuiltinSkillName} ` +
          `for historyId=${chatMsg.historyId}`,
      );
    }

    // Bridge the live web-chat Mercure topic to other plugins (the leading-v2
    // completion notifier delivers proactive "task done" messages to this exact
    // topic). Shared via Symbol.for — no cross-extension import. Best-effort.
    {
      const sym = Symbol.for("openclaw.chat.mercureTopicByUid");
      const g = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
      let topicMap = g[sym];
      if (!topicMap) {
        topicMap = new Map<string, string>();
        g[sym] = topicMap;
      }
      topicMap.set(userId, mercureTopic);
    }

    if (!userMessage) {
      logger.error(`[CHAT_PIPELINE] Empty message for historyId=${chatMsg.historyId}`);
      return "Error: Empty message";
    }

    // Step 2.4: A selected report template (frontend's template panel sends the
    // picked report_template.id) ALWAYS produces a report — selecting a template
    // is the user's request for it. But we no longer answer with a bare "报告已
    // 生成中" card: that felt abrupt. Instead we run the normal streamed chat turn
    // first (with the template body injected so the agent can reference it) so the
    // agent greets the user and acknowledges their message, THEN enqueue the
    // report just before `done` (see Step 8b). An unresolvable id (deleted,
    // disabled, another user's) or a missing downloadManager falls through to
    // ordinary chat handling with no report.
    let selectedTemplate: ResolvedTemplate | null = null;
    let pendingReport: {
      tpl: ResolvedTemplate;
      topic: { topicId: number; useSlaveTopic: boolean; masterId: number };
      dateScope: { start: string; end: string };
    } | null = null;
    if (chatMsg.templateId && templateLookup) {
      const tpl = await templateLookup.resolve(chatMsg.templateId, userId, logger);
      if (tpl && chatMsg.hasAttachment) {
        // Attachment overrides the internal-DB report: the user uploaded the
        // data to analyze, so we keep the template as a FORMAT guide (injected
        // below) but do not query the 智脑 feed tables. The turn runs as a
        // normal chat turn and the agent writes the report from the attachment.
        selectedTemplate = tpl;
        logger.info(
          `[CHAT_PIPELINE] Template #${tpl.id} ("${tpl.name}") selected WITH attachment -> ` +
            `analyze upload using template as format guide (no internal-DB report)`,
        );
      } else if (tpl && downloadManager) {
        logger.info(
          `[CHAT_PIPELINE] Template #${tpl.id} ("${tpl.name}") selected -> ` +
            `acknowledge then generate ${tpl.period}`,
        );
        const topic = await resolveReportTopic({
          userId,
          topicResolver,
          logger,
          requirement: userMessage,
          runtime,
          token: chatMsg.historyId,
        });
        selectedTemplate = tpl;
        pendingReport = { tpl, topic, dateScope: computeDateScope(tpl.period) };
      } else if (tpl) {
        // Resolved but no downloadManager: still let the agent reference the body.
        selectedTemplate = tpl;
        logger.warn(
          `[CHAT_PIPELINE] Template #${tpl.id} resolved but no downloadManager; ` +
            `replying without a report`,
        );
      } else {
        logger.warn(
          `[CHAT_PIPELINE] templateId=${chatMsg.templateId} did not resolve; ` +
            `falling back to normal handling`,
        );
      }
    }

    // Step 2.4b: Resolve the user's active custom skills (from the "我的Skills"
    // panel). Their instruction bodies are injected into the agent context below
    // so the agent follows them this turn — never spliced into the visible
    // message. Ownership + is_enable are enforced in the lookup; unresolved ids
    // are simply dropped. Failure degrades to an ordinary turn (no skills).
    let selectedSkills: ResolvedSkill[] = [];
    if (!chatMsg.builtinSkillName && chatMsg.skillIds?.length && skillLookup) {
      selectedSkills = await skillLookup.resolveMany(chatMsg.skillIds, userId, logger);
      options?.onSkillsResolved?.(selectedSkills);
      if (selectedSkills.length) {
        logger.info(
          `[CHAT_PIPELINE] Injecting ${selectedSkills.length} active skill(s) for userId=${userId}: ` +
            selectedSkills.map((s) => `#${s.id}"${s.name}"`).join(", "),
        );
      }
    }

    // Resolve and inject project ownership only for turns that actually need
    // monitoring data. A default project is authorization metadata, not normal
    // conversation context; injecting it into every turn made the model bring
    // that enterprise into unrelated writing, analysis, and chat. Resolution
    // failure degrades to the plain [userId:...] prefix instead of failing.
    let topicContext = "";
    const needsTopicContext =
      !chatMsg.hasAttachment && shouldInjectTopicContext(userMessage, pendingReport !== null);
    if (topicResolver && needsTopicContext) {
      try {
        const resolution = await topicResolver.getTopicIdsByUser(userId);
        if (resolution.topicId && resolution.topicId > 0) {
          // JSON.stringify keeps the quoting deterministic even when the
          // title itself contains quotes or brackets (prompt-cache friendly).
          const namePart = resolution.topicName
            ? ` topicName:${JSON.stringify(resolution.topicName)}`
            : "";
          topicContext = ` [topicId:${resolution.topicId}${namePart} useSlaveTopic:${resolution.useSlaveTopic}]`;
          // A user can own several topics; list them all (sorted by topicId
          // upstream) so the agent never has to guess beyond the prefix.
          if (resolution.topics.length > 1) {
            const all = resolution.topics
              .map((t) => `${t.topicId}${t.topicName ? `:${JSON.stringify(t.topicName)}` : ""}`)
              .join(", ");
            topicContext += ` [allTopics: ${all}]`;
          }
          logger.info(
            `[CHAT_PIPELINE] Injecting topic context for userId=${userId}:${topicContext}`,
          );
        }
      } catch (err) {
        logger.warn(
          `[CHAT_PIPELINE] Topic resolution failed, continuing without topic context: ${String(err)}`,
        );
      }
    }

    // Per-user agent isolation. Resolved before the event subscription so the
    // listener can scope itself to this run's session.
    const agentId = `rabbitmq-${userId}`;
    const sessionKey = `agent:${agentId}:rabbitmq:${userId}:${sessionId}`;

    if (options?.abortSignal?.aborted) {
      const stopped = "输出已暂停。";
      await historyManager.updateResponse(chatMsg.historyId, stopped);
      await mercure.pushDone(mercureTopic, chatMsg.historyId);
      return stopped;
    }

    // Original attachments: copy the OSS-backed files into this agent's
    // workspace so the agent can read full tables and inspect evidence such as
    // stamped PDFs. Best-effort — failures degrade to the extracted text already
    // in `userMessage`. Prefer the passed-in config
    // (api.config); the process-global snapshot is a fallback only.
    const attachmentConfig = config ?? getRuntimeConfigSnapshot();
    let materializedAttachments: Awaited<ReturnType<typeof materializeAttachments>> = [];
    if (chatMsg.attachments?.length) {
      if (attachmentConfig) {
        materializedAttachments = await materializeAttachments(
          chatMsg.attachments,
          agentId,
          attachmentConfig,
          logger,
        );
      } else {
        logger.warn("[ATTACHMENT] No config available; cannot resolve workspace, skipping");
      }
    }

    // Step 3: Set up streaming pusher + subscribe to agent events.
    // Tag every push with this turn's historyId so stale frontend
    // subscriptions on the shared per-user topic can drop foreign chunks.
    streamPusherCtx.streamPusher = new StreamingMercurePusher(
      mercure,
      mercureTopic,
      chatMsg.historyId,
    );

    // Sanitized tool-activity narration: while the agent runs tools (DB
    // queries etc.) it produces no assistant deltas, so without these pushes
    // the frontend sees nothing for the whole tool phase. Only the tool NAME
    // is mapped to a generic status line — args (SQL, paths) never leak.
    // Immediate feedback: light up the frontend "工作过程" timeline the instant
    // processing starts, so the user sees activity through the cold-start + model
    // first-token wait instead of a blank "思考中…". This first step is ended as
    // soon as real output begins (a tool step, or the first assistant delta).
    // Synthetic phase steps frame the agent's work so the "工作过程" timeline
    // reads as a narrative — 理解 → (思考) → (工具步骤) → 组织回答 — even on turns
    // with few or no tool calls. Tool steps (from the narrator) carry their own
    // ids and slot in between. start/end are matched by stepId on the frontend,
    // which also finalizes any still-running step on `done`, so a missed end is
    // harmless. Each phase starts/ends at most once (idempotent), so repeated
    // thinking/assistant events never duplicate or revive a phase.
    // Merge each streamed step into storedSteps (declared at function scope
    // above). Mirrors the frontend's applyStep merge: a `start` adds a running
    // step; an `end` marks it completed/failed with duration. The final coercion
    // of any leftover running step happens in persistTimeline.
    const recordStep = (step: ActivityStep) => {
      const existing = storedSteps.find((s) => s.id === step.stepId);
      if (step.phase === "end") {
        if (existing) {
          existing.status = step.status ?? "completed";
          if (step.durationMs != null) {
            existing.durationMs = step.durationMs;
          }
          if (step.detail) {
            existing.detail = step.detail;
          }
          if (step.publicNarrative) {
            existing.publicNarrative = step.publicNarrative;
          }
        } else {
          storedSteps.push({
            id: step.stepId,
            index: step.index,
            label: step.label,
            category: step.category,
            status: step.status ?? "completed",
            durationMs: step.durationMs,
            ...(step.detail ? { detail: step.detail } : {}),
            ...(step.publicNarrative ? { publicNarrative: step.publicNarrative } : {}),
          });
        }
      } else if (!existing) {
        storedSteps.push({
          id: step.stepId,
          index: step.index,
          label: step.label,
          category: step.category,
          status: step.status ?? "running",
          ...(step.publicNarrative ? { publicNarrative: step.publicNarrative } : {}),
        });
      }
    };
    // Push a step to the live frontend AND record it for history persistence.
    const emitStep = (step: ActivityStep) => {
      recordStep(step);
      void mercure.pushStep(mercureTopic, step, chatMsg.historyId);
    };

    const phaseState = new Map<string, { ended: boolean; startedAt: number }>();
    const startPhase = (stepId: string, index: number, label: string, category: StepCategory) => {
      if (phaseState.has(stepId)) {
        return;
      }
      phaseState.set(stepId, { ended: false, startedAt: Date.now() });
      emitStep({ phase: "start", stepId, index, label, category, status: "running" });
    };
    const endPhase = (stepId: string, label: string, category: StepCategory, detail?: string) => {
      const entry = phaseState.get(stepId);
      if (!entry || entry.ended) {
        return;
      }
      entry.ended = true;
      emitStep({
        phase: "end",
        stepId,
        index: 0,
        label,
        category,
        status: "completed",
        durationMs: Math.max(0, Date.now() - entry.startedAt),
        ...(detail ? { detail } : {}),
      });
    };

    const INIT_STEP_ID = "init";
    const INIT_STEP_LABEL = "正在理解您的问题";
    const THINK_STEP_ID = "think";
    const THINK_STEP_LABEL = "正在思考分析";
    const ANSWER_STEP_ID = "answer";
    const ANSWER_STEP_LABEL = "正在组织回答";

    const endInitStep = () => endPhase(INIT_STEP_ID, INIT_STEP_LABEL, "default");

    // ③ Reasoning peek. When the model streams reasoning, we attach a SHORT,
    // sanitized one-line summary of it as the think step's `detail`. This exposes
    // model chain-of-thought to the external customer, so it is gated and kept
    // minimal: sanitizeInternalRefs strips paths / injected context / session
    // keys, whitespace is collapsed, and the text is hard-capped. Flip
    // REASONING_SUMMARY_ENABLED to false to surface only "正在思考分析" with no peek.
    const REASONING_SUMMARY_ENABLED = true;
    const REASONING_SUMMARY_MAX = 80;
    let reasoningText = "";
    const buildReasoningSummary = (): string | undefined => {
      if (!REASONING_SUMMARY_ENABLED || !reasoningText) {
        return undefined;
      }
      const safe = sanitizeInternalRefs(reasoningText).replace(/\s+/g, " ").trim();
      if (!safe) {
        return undefined;
      }
      return safe.length > REASONING_SUMMARY_MAX
        ? `${safe.slice(0, REASONING_SUMMARY_MAX)}…`
        : safe;
    };
    const endThinkStep = () =>
      endPhase(THINK_STEP_ID, THINK_STEP_LABEL, "think", buildReasoningSummary());

    // Immediate feedback: light up the timeline the instant processing starts,
    // through the cold-start + model first-token wait, instead of a blank panel.
    startPhase(INIT_STEP_ID, 0, INIT_STEP_LABEL, "default");
    void mercure.pushProgress(mercureTopic, `${INIT_STEP_LABEL}…`, chatMsg.historyId);

    const narrator = new ToolActivityNarrator({
      push: (message) => {
        void mercure.pushProgress(mercureTopic, message, chatMsg.historyId);
      },
      // Structured timeline steps (start/end) for the frontend's "工作过程"
      // panel. Tool-specific observers read only allowlisted request/result
      // fields and never pass raw args, credentials, links, or errors through.
      onStep: (step) => {
        // A tool starting means the agent moved from understanding/thinking to
        // acting — close those phases so the tool step reads as the next stage.
        endInitStep();
        endThinkStep();
        emitStep(step);
      },
    });

    // Forward only events belonging to THIS turn, identified by EITHER the run's
    // id (once captured below) OR its sessionKey (when present). Either one
    // uniquely identifies our run, and needing only one is what fixes the bug:
    // the runtime attaches sessionKey to agent events ONLY when the run surfaces
    // to the control UI (isControlUiVisible), which holds solely for
    // "webchat"-channel runs. This subagent run isn't a webchat channel, so its
    // events arrive with sessionKey=undefined — the old
    // `evt.sessionKey !== sessionKey` filter then dropped ALL tool/assistant
    // events, leaving the "工作过程" timeline stuck on just the init step and the
    // reply un-streamed (recovered only from session messages at the end).
    // runId is always stamped by emitAgentEvent and is unique per run, so the
    // runId arm catches our events even without a sessionKey, while still
    // isolating us from concurrent runs (report subagent, heartbeat, another
    // user's chat) whose runId and sessionKey both differ.
    let currentRunId: string | null = null;
    let abortRunPromise: Promise<unknown> | null = null;
    const abortActiveRun = () => {
      if (!currentRunId || abortRunPromise || !options?.abortRun) {
        return;
      }
      abortRunPromise = Promise.resolve(options.abortRun(sessionKey)).catch((error) => {
        logger.warn(
          `[CHAT_PIPELINE] Failed to abort subagent run ${currentRunId}: ${String(error)}`,
        );
      });
    };
    options?.abortSignal?.addEventListener("abort", abortActiveRun, { once: true });
    const unsubscribe = runtime.events.onAgentEvent((evt) => {
      if (evt.runId !== currentRunId && evt.sessionKey !== sessionKey) {
        return;
      }
      if (evt.stream === "tool") {
        narrator.handleAgentEvent(evt);
        return;
      }
      if (evt.stream === "thinking") {
        // Model reasoning phase. Only emitted when the run streams reasoning
        // (reasoning-capable model + streamReasoning on); a no-op otherwise.
        // The timeline shows one "正在思考分析" step; its end carries a sanitized,
        // capped reasoning peek (see buildReasoningSummary / ③). `data.text` is
        // the cumulative reasoning so far — keep the latest for the summary.
        endInitStep();
        startPhase(THINK_STEP_ID, 1, THINK_STEP_LABEL, "think");
        const text = (evt.data as { text?: unknown } | undefined)?.text;
        if (typeof text === "string" && text) {
          reasoningText = text;
        }
        return;
      }
      if (evt.stream !== "assistant") {
        return;
      }
      const delta = extractAssistantDelta(evt.data);
      if (delta) {
        // First visible answer text → close understanding/thinking and open the
        // answer-composing phase, which the timeline shows until the turn ends.
        endInitStep();
        endThinkStep();
        startPhase(ANSWER_STEP_ID, 99, ANSWER_STEP_LABEL, "answer");
        streamPusherCtx.streamPusher!.appendDelta(delta);
      }
    });

    try {
      // Step 4: Run subagent for this user's session.
      logger.info(
        `[CHAT_PIPELINE] Running subagent for agentId=${agentId}, sessionKey=${sessionKey}`,
      );

      // Early ack is now the init step + progress pushed above (a `step`, not a
      // `text` chunk) so the "工作过程" panel lights up immediately without
      // prefixing throwaway text into the reply bubble.

      // When the caller opts out of memory (use_memory:false), instruct the agent
      // to skip long-term recall for this turn. Memory tools (memory_search /
      // memory_get) are registered at the agent level and cannot be removed
      // per-run, so this is a prompt-level suppression, not a hard tool gate.
      const memoryDirective = !chatMsg.useMemory
        ? "[no-memory] Do not call memory_search or memory_get this turn; " +
          "answer only from the current conversation and the data provided. "
        : "";

      // A selected template's body is injected so the agent can reference it
      // (the "先学习一下模板" flow) while it greets the user.
      const templateContext = selectedTemplate ? buildTemplateContext(selectedTemplate) : "";

      // Active custom skills: inject their instructions so the agent follows
      // them this turn. Kept out of the visible message (appended to context).
      const skillContext = selectedSkills.length ? buildSkillContext(selectedSkills) : "";

      // Filtering makes the matching skill the only advertised bundled skill;
      // naming it in the prompt additionally requires the normal skill loader
      // to read and apply its SKILL.md before acting.
      const inferredBuiltinSkillDirective = inferredBuiltinSkillName
        ? `[auto-selected-skill] 本轮请求明确匹配内置技能，请使用 $${inferredBuiltinSkillName} 完成任务。 `
        : "";

      // On the template path the report is generated right after this turn, so we
      // steer the turn to be a short, natural acknowledgement of the user's
      // message rather than a free-form answer (and never the report itself).
      const ackDirective = pendingReport
        ? "[acknowledge-and-report] 用户选择了报告模板" +
          `《${pendingReport.tpl.name}》（${pendingReport.tpl.period}），` +
          "系统会在你回复后立即开始生成这份报告。请用一两句自然、口语化的话承接用户刚才说的内容，" +
          "并表明你已了解这份模板、马上为其生成报告。" +
          "切勿给出任何具体完成时间或时长（例如“预计X分钟”“几分钟内”），" +
          "报告耗时不确定，只需说明在后台生成、完成后会第一时间发给用户。" +
          "本轮不要调用任何工具，也不要输出报告正文。 "
        : "";

      // Attachment path: the user uploaded data (already spliced into the
      // message) and wants it analyzed. Steer the agent to base its answer on
      // the attached content — never on the internal 智脑 库 — and, when a
      // template was selected, to follow that template's structure for the
      // write-up. Tools stay allowed (the agent may use the excel skill, etc.).
      // Large-sheet path: the full file is in the workspace. Tell the agent to
      // read it with code (pandas/openpyxl) and — critically — to keep the data
      // in the subprocess, returning only small computed results (counts,
      // filtered subsets, aggregations) so it never floods context. The inline
      // overview is the authoritative source for totals/percentages.
      const materializedSheets = materializedAttachments.filter((a) => a.kind === "spreadsheet");
      const largeSheetDirective = materializedSheets.length
        ? "本轮附件含大表，完整文件已就绪于 workspace：" +
          materializedSheets
            .map((a) => `「${a.filename}」→ ${a.workspacePath}（约 ${a.totalDataRows ?? 0} 行）`)
            .join("、") +
          "。消息正文里只内联了概览+前若干行样本。如需逐行明细、按任意字段筛选或自定义聚合，" +
          "请用代码（pandas/openpyxl 读取该文件路径）在子进程内完成计算，" +
          "只返回小结果（计数/筛选出的少量行/分组聚合表），切勿把整表打印进回复；" +
          "总数与占比一律以上方概览为准，不要从样本估算。 "
        : "";

      // Original documents retain layout, embedded images, signatures, and
      // stamps that text extraction cannot represent. Give the agent an exact
      // workspace-relative path so complaint/evidence workflows can inspect and
      // upload the real file instead of falsely reporting that it never landed.
      const materializedDocuments = materializedAttachments.filter((a) => a.kind === "document");
      const originalDocumentDirective = materializedDocuments.length
        ? "[原始附件] 完整原文件已存入 workspace：" +
          materializedDocuments
            .map(
              (a) =>
                `「${a.filename}」→ ${a.workspacePath}` +
                (a.ossKey ? `（ossKey=${a.ossKey}）` : `（ossUrl=${a.ossUrl}）`),
            )
            .join("；") +
          "。需要核验版式、公章、签名、图片或提交原始证据时，必须读取并使用上述原文件；" +
          "不要仅凭正文中的文本提取结果判断文件不存在，也不要要求用户重复上传。" +
          "若其中是已盖章《投诉通知书》，请把随附件提供的 ossKey（旧消息则用 ossUrl）" +
          "直接作为 infringe_complaint_submit.stampedComplaint 提交；" +
          "仅当附件没有任何 OSS 引用时，才对 workspace 原文件调用 file_share 获取 OSS URL。 "
        : "";

      // 证件图片（投诉建档）：图片已落到 workspace，且各自带回 OSS objectKey。
      // 让 agent 先 read 逐张「看」图自主识别证件类型，再把对应 ossKey 填进
      // infringe_profile_save 的字段——用户无需手工标注每张是什么证件。
      // 图片附件带回了 workspace 路径与 OSS objectKey。软性、意图门控：仅当用户
      // 意在投诉/维权建档时才据此建档；普通图片对话不受影响。
      const materializedImages = materializedAttachments.filter((a) => a.kind === "image");
      const certImageDirective = materializedImages.length
        ? "[图片附件] 用户本轮上传了图片，已存入 workspace 并各自带回 OSS objectKey：" +
          materializedImages
            .map((a) => `「${a.filename}」→ ${a.workspacePath}（ossKey=${a.ossKey ?? ""}）`)
            .join("；") +
          "。若这些是投诉/维权所需证件（身份证 / 营业执照 / 公章 / 授权委托书），请代用户建立或完善「投诉主体档案」：" +
          "①用 read 工具逐张查看，自主识别每张属于哪类证件（身份证正面 / 身份证反面 / 手持身份证 / 营业执照 / 公章 / 授权委托书）；" +
          "②按识别结果把每张的 ossKey 填入 infringe_profile_save 对应字段" +
          "（身份证正面→idCardFront，反面→idCardBack，手持→idCardHold，营业执照→businessLicense，公章→sealImage，委托书→powerOfAttorney）；" +
          "③主体类型 subjectType：出现营业执照按 Enterprise，否则 Personal；" +
          "④名称 name / 证件号 idNumber 等文本字段，图中能清晰读到就据实填写，读不到就简要询问用户后再建档，切勿编造；" +
          "⑤建档成功后用返回的 missingDocs 告知用户还缺哪些证件；缺失证件和盖章《投诉通知书》都可让用户直接作为聊天附件补充，无需跳转网页端。" +
          "若这些只是普通图片、与投诉无关，则忽略本条，按用户实际问题正常处理。 "
        : "";

      // Does this attachment turn ask for a report (vs an ad-hoc question like
      // "华东有多少条")? A selected template or an explicit report noun counts.
      // Period keywords alone intentionally do not trigger report behavior.
      const wantsReport = !!selectedTemplate || /报告|简报|研判|通报/.test(userMessage);

      // Report turns: force the COMPLETE report inline. This path streams the
      // report AS the chat reply and stores it in history_messages.response —
      // there is no separate file/Word export. So the model must NOT summarize
      // and then pretend a full version was saved/exported (a recurring failure:
      // "全文约5600字…完整报告已保存…可导出Word/PDF" while only emitting a digest).
      const reportOutputDirective = wantsReport
        ? "本轮是报告撰写请求：请在本次回复里【直接输出完整的报告正文】，按章节逐节完整展开" +
          "（标题、各板块、数据分析、结论与建议全部写全），不要只给摘要、目录或要点列表。" +
          (selectedTemplate ? `结构与文风遵循所选模板《${selectedTemplate.name}》。` : "") +
          "默认在本次回复中直接交付完整正文。只有实际调用文件生成或导出工具并明确返回成功，" +
          "才能补充说明已生成对应文件；否则严禁出现“完整报告已保存”“原文已存档”" +
          "“已导出为Word/PDF”“全文约X字”等说法，" +
          "更不要用一段摘要替代正文。 "
        : "";

      const attachmentDirective =
        chatMsg.hasAttachment && !pendingReport
          ? "[analyze-attachment] 用户本轮上传了附件，正文里已包含附件内容。" +
            "请【仅依据附件中的数据】进行分析与撰写，不要查询或编造系统内部舆情库的数据；" +
            "若附件数据不足以回答某一点，如实说明而非以内部数据补足。" +
            largeSheetDirective +
            originalDocumentDirective +
            reportOutputDirective +
            " "
          : "";

      // Ask the model to footnote external facts and end with a machine sources
      // block (split off in Step 6). It self-gates per the "when to cite" rules,
      // so pure chat/creative turns simply omit it.
      const citationDirective = buildCitationDirective();
      const suhengWorkspaceContext = buildSuhengWorkspaceContext(userMessage);
      const suhengDesignContext = buildSuhengDesignContext(userMessage);
      // Interactive turns keep the runtime-authorized tool catalog. A per-message
      // keyword allowlist breaks follow-ups ("make it clearer", "retry") even
      // while the model retains the earlier task. Runtime policy still enforces
      // provider, agent, owner, sandbox and subagent restrictions on every run.

      // Continue in this history row's full snapshot before the agent appends.
      await prepareHistorySessionSnapshot({
        history: record,
        userId,
        sessionKey,
        agentId,
        config: attachmentConfig ?? undefined,
        sessions: runtime.agent.session,
      });
      // Open accounting after the copy so inherited messages stay in past turns.
      usageContext = { sessionKey, agentId, sinceMs: Date.now() };

      const runResult = await runtime.subagent.run({
        sessionKey,
        message: `${inferredBuiltinSkillDirective}${ackDirective}${attachmentDirective}${certImageDirective}${memoryDirective}${citationDirective}${suhengWorkspaceContext}${suhengDesignContext}[userId:${userId}]${topicContext} ${userMessage}${templateContext}${skillContext}`,
        extraSystemPrompt: SUHENG_RUNTIME_SYSTEM_PROMPT,
        systemPromptMode: builtinSkillName ? "full" : "minimal",
        bootstrapContextMode: "lightweight",
        ...(builtinSkillName ? { skillFilter: [builtinSkillName] } : {}),
        deliver: false,
      });

      // Scope the event listener to this run now that we have its id. Tool and
      // assistant events fire during waitForRun below, after this assignment.
      currentRunId = runResult.runId;
      if (options?.abortSignal?.aborted) {
        abortActiveRun();
      }

      // Step 5: Wait until the embedded run actually settles. agent.wait needs a
      // bounded RPC timeout, but an elapsed wait window only means "still
      // running"; it must not be turned into a failed user response while the
      // model continues calling tools in the background.
      let waitResult: Awaited<ReturnType<PluginRuntime["subagent"]["waitForRun"]>>;
      let elapsedWaitMs = 0;
      while (true) {
        waitResult = await runtime.subagent.waitForRun({
          runId: runResult.runId,
          timeoutMs: turnTimeoutMs,
        });
        if (options?.abortSignal?.aborted) {
          abortActiveRun();
          const pendingAbort = abortRunPromise;
          if (pendingAbort) {
            await pendingAbort;
          }
          const partialText = streamPusherCtx.streamPusher.getFullText().trim();
          const stopped = partialText || "输出已暂停。";
          await historyManager.updateResponse(chatMsg.historyId, stopped);
          await persistTimeline("completed");
          await persistUsage();
          await streamPusherCtx.streamPusher.finish();
          logger.info(`[CHAT_PIPELINE] Cancelled: historyId=${chatMsg.historyId}`);
          return stopped;
        }
        if (waitResult.status !== "timeout") {
          break;
        }
        elapsedWaitMs += turnTimeoutMs;
        logger.info(
          `[CHAT_PIPELINE] Subagent still running after ${Math.round(elapsedWaitMs / 1000)}s; ` +
            `continuing to wait for runId=${runResult.runId}, historyId=${chatMsg.historyId}`,
        );
      }

      if (waitResult.status === "error") {
        logger.error(`[CHAT_PIPELINE] Subagent error: ${waitResult.error}`);
        await streamPusherCtx.streamPusher.pushError(waitResult.error ?? "Unknown error");
        // Persist the timeline with unfinished steps marked failed, so the
        // history view shows a clean failed timeline rather than a spinner.
        await persistTimeline("failed");
        // The failed run still consumed tokens; bill what it spent.
        await persistUsage();
        return `Error: ${waitResult.error}`;
      }

      // Step 6: Extract response from session messages as the canonical source
      const sessionMessages = await runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 5,
      });

      let fullResponse = "";
      if (sessionMessages.messages && Array.isArray(sessionMessages.messages)) {
        for (const msg of [...sessionMessages.messages].toReversed()) {
          const m = msg as { role?: string; content?: unknown };
          if (m.role === "assistant") {
            // content is a string in simple sessions but an array of content
            // blocks in tool-using ones; extract text so downstream sanitizing
            // (and storage) always works on a string, never a raw array.
            const text = extractMessageText(m.content).trim();
            if (text) {
              fullResponse = text;
              break;
            }
          }
        }
      }

      if (!fullResponse) {
        // Fall back to whatever the streaming pusher collected
        fullResponse = streamPusherCtx.streamPusher.getFullText() || "(No response generated)";
      }

      // Split off the machine citations block (marker + JSON) the model appends,
      // so only the user-visible answer is stored/returned; the structured
      // sources go to the frontend separately.
      const { text: splitText, citations } = splitCitations(fullResponse);
      // Drop inline [n] markers that have no matching source (model footnoted
      // but omitted/botched the sources block) so no dead markers are stored.
      const visibleResponse = stripDanglingCitationMarkers(splitText, citations);

      // Hard backstop behind the workspace prompt rule: strip any internal file
      // paths / identifiers the model may have narrated before they are stored
      // or returned to the web client.
      // Then turn `MEDIA:<url>` attachment directives into inline markdown: this
      // channel has no attachment surface, so an unconverted directive reaches
      // the customer as literal text and the image is never delivered.
      const safeResponse = mediaLinesToMarkdown(
        normalizeChineseProseQuotes(sanitizeInternalRefs(visibleResponse)),
      );

      // Step 7: Update history record
      await historyManager.updateResponse(chatMsg.historyId, safeResponse);

      // Persist citation sources into metadata so the lobster history view can
      // replay footnotes on reload (best-effort; merges with the timeline steps).
      if (citations.length > 0) {
        try {
          await historyManager.updateMetadata(chatMsg.historyId, { citations });
        } catch (metaErr) {
          logger.warn(`[CHAT_PIPELINE] Persist citations failed: ${String(metaErr)}`);
        }
      }

      // Close any open phase steps so the timeline ends clean (with real
      // durations) rather than relying on the frontend's done-time finalize.
      endInitStep();
      endThinkStep();
      endPhase(ANSWER_STEP_ID, ANSWER_STEP_LABEL, "answer");

      // Step 7b: Persist the finalized work-process timeline (any leftover
      // running step coerced to "completed") so the lobster history view can
      // replay the "工作过程" panel without a step stuck spinning.
      await persistTimeline("completed");

      // Step 7c: Bill the turn — sum every model call the run made (one per
      // tool-loop iteration) and write tokens + cost onto the history row.
      await persistUsage();

      // Step 8b: Template path — now that the user has been greeted, enqueue the
      // report. This opens the frontend report card (`report_created`) before the
      // `done` below, and the report itself streams in later as a `report` event.
      // Enqueue is a fast INSERT + publish; it never blocks on the data COUNT.
      if (pendingReport && downloadManager) {
        try {
          await enqueueReportTask({
            period: pendingReport.tpl.period,
            // The user's typed text becomes the requirement; it may just be the
            // template name when they only clicked the template without editing.
            requirement: userMessage,
            dateScope: pendingReport.dateScope,
            topicId: pendingReport.topic.topicId,
            useSlaveTopic: pendingReport.topic.useSlaveTopic,
            masterId: pendingReport.topic.masterId,
            templateId: pendingReport.tpl.id,
            chatMsg,
            mercure,
            mercureTopic,
            downloadManager,
            feedCounter,
            reportTaskPublisher,
            logger,
          });
        } catch (reportErr) {
          // The greeting already reached the user; a failed enqueue must not turn
          // the whole turn into an error. Log and let the turn finish cleanly.
          logger.error(`[CHAT_PIPELINE] Report enqueue failed after ack: ${String(reportErr)}`);
        }
      }

      // Step 8: Emit citation sources (whole payload) then finish streaming —
      // flush remaining buffer + push done signal. Citations go before done so
      // the frontend has them when it finalizes the bubble.
      if (citations.length > 0) {
        await streamPusherCtx.streamPusher.pushCitations(citations);
      }
      await streamPusherCtx.streamPusher.finish();

      logger.info(
        `[CHAT_PIPELINE] Completed: historyId=${chatMsg.historyId}, ` +
          `response length=${safeResponse.length}`,
      );

      return safeResponse;
    } finally {
      options?.abortSignal?.removeEventListener("abort", abortActiveRun);
      unsubscribe();
    }
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    const errCode = err?.code ?? err?.cause?.code ?? "unknown";

    // ECONNRESET means the frontend closed the connection while we were processing.
    // This typically happens when the frontend times out before we could respond.
    if (errCode === "ECONNRESET") {
      logger.warn(
        `[CHAT_PIPELINE] Connection reset by frontend (timeout?) for historyId=${chatMsg.historyId}. ` +
          `The response may not have reached the client.`,
      );
      // Try to persist what we have in the history record before failing
      try {
        const partialText = streamPusherCtx.streamPusher?.getFullText();
        if (partialText) {
          // Strip any half-written citations block from the interrupted stream,
          // plus inline [n] markers left dangling by the lost sources block.
          const { text: partialVisible, citations: partialCites } = splitCitations(partialText);
          const safePartial = mediaLinesToMarkdown(
            normalizeChineseProseQuotes(
              sanitizeInternalRefs(stripDanglingCitationMarkers(partialVisible, partialCites)),
            ),
          );
          await historyManager.updateResponse(chatMsg.historyId, safePartial);
          logger.info(
            `[CHAT_PIPELINE] Persisted partial response (${safePartial.length} chars) before connection reset`,
          );
        }
      } catch {
        // best effort - don't fail the whole handler
      }
      // Finalize the timeline too, so a reopened history shows a failed (not
      // spinning) work-process panel.
      await persistTimeline("failed");
      await persistUsage();
      return `Error: Connection reset by client (possible timeout). Response may be incomplete.`;
    }

    logger.error(`[CHAT_PIPELINE] Unhandled error: ${String(error)}, code=${errCode}`);
    await persistTimeline("failed");
    await persistUsage();
    return `Error: ${String(error)}`;
  }
}
