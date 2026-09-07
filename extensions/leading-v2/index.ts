import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  createComplaintSubmitToolFactory,
  createInfringeComplaintSubmitToolFactory,
  createInfringeProfileListToolFactory,
  createInfringeProfileSaveToolFactory,
  createJobListToolFactory,
  createJobStopToolFactory,
  createLetterFetchToolFactory,
  createLetterGenerateToolFactory,
} from "./src/ai/ai-tools.js";
import { closePool } from "./src/client/db-client.js";
import { resolveConfig } from "./src/client/http-client.js";
import { ApiKeyResolver } from "./src/client/key-resolver.js";
import { RecentTaskStore } from "./src/client/recent-tasks.js";
import { createComplaintTaskStatusToolFactory } from "./src/complaint/complaint-status-tool.js";
import { createComplaintTaxonomyToolFactory } from "./src/complaint/complaint-taxonomy-tool.js";
import {
  createCrawlRefreshCreateToolFactory,
  createCrawlRefreshListToolFactory,
  createCrawlRefreshStatusToolFactory,
  type RecentCrawlRefresh,
} from "./src/crawl/crawl-tools.js";
import { createHotRankToolFactory } from "./src/hot-rank/hot-rank-tool.js";
import {
  createLinkBatchCreateToolFactory,
  createLinkBatchListToolFactory,
  createLinkBatchStatusToolFactory,
  type RecentLinkBatch,
} from "./src/link/link-tools.js";
import { getChatMercureTopic } from "./src/notify/chat-topic.js";
import { resolveNotifyConfig } from "./src/notify/config.js";
import { pollCrawlRefresh } from "./src/notify/crawl-adapter.js";
import { debugLog } from "./src/notify/debug.js";
import { resolveSmtpConfig } from "./src/notify/email-client.js";
import { createEmailSendToolFactory } from "./src/notify/email-tool.js";
import { clearNotifyEnqueue, setNotifyEnqueue } from "./src/notify/enqueue-bridge.js";
import { pollLegalCheck } from "./src/notify/legal-check-adapter.js";
import { pollLinkCheck } from "./src/notify/link-check-adapter.js";
import { MercurePusher, resolveMercureConfig } from "./src/notify/mercure.js";
import { Notifier, type NotificationTransport } from "./src/notify/notification.js";
import { CompletionNotifier } from "./src/notify/notifier.js";
import { getSharedPendingRegistry } from "./src/notify/pending-store.js";
import { DbHistoryTransport } from "./src/notify/transports/db-history.js";
import { EmailNotificationTransport } from "./src/notify/transports/email.js";
import { MercureNotificationTransport } from "./src/notify/transports/mercure-notification.js";
import type { NotifyKind } from "./src/notify/types.js";
import { resolveUsageCurrencyPolicy } from "./src/notify/usage.js";
import {
  createFeedListToolFactory,
  createFeedReanalyzeToolFactory,
  createMonthlyStatsToolFactory,
  createTopicListToolFactory,
} from "./src/opinion/opinion-read-tools.js";
import {
  createOpinionAnalyzeToolFactory,
  createOpinionDownloadContentToolFactory,
  createOpinionDownloadListToolFactory,
  createOpinionDownloadStatusToolFactory,
  createOpinionExportToolFactory,
  createSheetReportToolFactory,
  type RecentDownload,
} from "./src/opinion/opinion-task-tools.js";
import {
  createOpinionContentToolFactory,
  createReportStatusToolFactory,
  createReportStopToolFactory,
  type RecentReport,
} from "./src/report/report-tools.js";
import { buildRunners } from "./src/schedule/actions/registry.js";
import { getSharedScheduleStore } from "./src/schedule/schedule-store.js";
import {
  createScheduleCreateToolFactory,
  createScheduleDeleteToolFactory,
  createScheduleListToolFactory,
  createScheduleToggleToolFactory,
} from "./src/schedule/schedule-tools.js";
import { Scheduler } from "./src/schedule/scheduler.js";

export default definePluginEntry({
  id: "leading-v2",
  name: "Leading V2 Backend",
  description:
    "Submit tasks and poll their status across leading-v2.0 backend modules, and send explicitly " +
    "confirmed SMTP email. Tools are scoped to rabbitmq-<userId> agents; per-uid keys are resolved " +
    "(and auto-provisioned) from the api_key table.",
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig ?? {});
    // One shared resolver for the whole backend: each uid is minted/cached once.
    const resolver = new ApiKeyResolver(config.apiKeys, config.db);
    // Completion-notification plumbing, shared by every async-task module below.
    // Process-global singleton: the tool-discovery register() and the service
    // register() must enqueue into and poll the SAME registry instance.
    const notify = resolveNotifyConfig(api.pluginConfig ?? {});
    const pendingTasks = getSharedPendingRegistry();

    // --- 失效链接检测 (LinkController → Queue::OfflineLinksChecker, link_status_job) ---
    const linkBatches = new RecentTaskStore<RecentLinkBatch>();
    api.registerTool(
      createLinkBatchCreateToolFactory(api, resolver, linkBatches, pendingTasks, notify),
      { name: "link_batch_create" },
    );
    api.registerTool(createLinkBatchStatusToolFactory(api, resolver, linkBatches), {
      name: "link_batch_status",
    });
    api.registerTool(createLinkBatchListToolFactory(api, resolver), {
      name: "link_batch_list",
    });

    // --- industry-report (评论/回应生成) ---
    const reports = new RecentTaskStore<RecentReport>();
    api.registerTool(createOpinionContentToolFactory(api, resolver, reports), {
      name: "opinion_content_create",
    });
    api.registerTool(createReportStatusToolFactory(api, resolver, reports), {
      name: "report_status",
    });
    api.registerTool(createReportStopToolFactory(api, resolver, reports), {
      name: "report_stop",
    });

    // --- pub-opinion (舆情监测/研判) ---
    const downloads = new RecentTaskStore<RecentDownload>();
    api.registerTool(createOpinionAnalyzeToolFactory(api, resolver, downloads), {
      name: "opinion_analyze",
    });
    api.registerTool(createOpinionExportToolFactory(api, resolver, downloads), {
      name: "opinion_report_export",
    });
    api.registerTool(createSheetReportToolFactory(api, resolver, downloads), {
      name: "sheet_report_create",
    });
    api.registerTool(createOpinionDownloadStatusToolFactory(api, resolver, downloads), {
      name: "opinion_download_status",
    });
    api.registerTool(createOpinionDownloadListToolFactory(api, resolver), {
      name: "opinion_download_list",
    });
    api.registerTool(createOpinionDownloadContentToolFactory(api, resolver), {
      name: "opinion_download_content",
    });
    api.registerTool(createFeedListToolFactory(api, resolver), { name: "feed_list" });
    api.registerTool(createTopicListToolFactory(api, resolver), { name: "topic_list" });
    api.registerTool(createFeedReanalyzeToolFactory(api, resolver), { name: "feed_reanalyze" });
    api.registerTool(createMonthlyStatsToolFactory(api, resolver), { name: "monthly_stats" });
    api.registerTool(createHotRankToolFactory(api), { name: "hot_rank" });

    // --- Explicitly confirmed outbound email ---
    api.registerTool(createEmailSendToolFactory(api, resolveSmtpConfig(api.pluginConfig ?? {})), {
      name: "send_email",
    });

    // --- ai (任务管理 + 维权文书) ---
    api.registerTool(createJobListToolFactory(api, resolver), { name: "job_list" });
    api.registerTool(createJobStopToolFactory(api, resolver), { name: "job_stop" });
    api.registerTool(createLetterGenerateToolFactory(api, resolver), { name: "letter_generate" });
    api.registerTool(createLetterFetchToolFactory(api, resolver), { name: "letter_fetch" });
    api.registerTool(createComplaintTaxonomyToolFactory(api, resolver), {
      name: "complaint_taxonomy",
    });
    api.registerTool(createComplaintSubmitToolFactory(api, resolver), { name: "complaint_submit" });
    api.registerTool(createComplaintTaskStatusToolFactory(api, resolver), {
      name: "complaint_task_status",
    });

    // --- infringe-complaint (侵权投诉，投诉方案；与举报 complaint_submit 平级) ---
    api.registerTool(createInfringeProfileListToolFactory(api, resolver), {
      name: "infringe_profile_list",
    });
    api.registerTool(createInfringeProfileSaveToolFactory(api, resolver), {
      name: "infringe_profile_save",
    });
    api.registerTool(createInfringeComplaintSubmitToolFactory(api, resolver), {
      name: "infringe_complaint_submit",
    });

    // --- link-data-crawler (互动量刷新，只读：重抓互动量但不写回主看板) ---
    const crawlRefreshes = new RecentTaskStore<RecentCrawlRefresh>();
    api.registerTool(
      createCrawlRefreshCreateToolFactory(api, resolver, crawlRefreshes, pendingTasks, notify),
      { name: "crawl_refresh_create" },
    );
    api.registerTool(createCrawlRefreshStatusToolFactory(api, resolver, crawlRefreshes), {
      name: "crawl_refresh_status",
    });
    api.registerTool(createCrawlRefreshListToolFactory(api, resolver), {
      name: "crawl_refresh_list",
    });

    // --- scheduled tasks (口述定时；结果走同一套 notifier) ---
    const scheduleStore = getSharedScheduleStore();
    api.registerTool(createScheduleCreateToolFactory(api, scheduleStore), {
      name: "schedule_create",
    });
    api.registerTool(createScheduleListToolFactory(api, scheduleStore), { name: "schedule_list" });
    api.registerTool(createScheduleDeleteToolFactory(api, scheduleStore), {
      name: "schedule_delete",
    });
    api.registerTool(createScheduleToggleToolFactory(api, scheduleStore), {
      name: "schedule_toggle",
    });

    let notifier: CompletionNotifier | undefined;
    let scheduler: Scheduler | undefined;
    api.registerService({
      id: "leading-v2",
      async start(ctx) {
        try {
          const stateFile = join(ctx.stateDir, "leading-v2-notify.json");
          await pendingTasks.init(stateFile, ctx.logger);
          debugLog(
            `service.start enabled=${notify.enabled} pollMs=${notify.pollIntervalMs} ` +
              `loaded=${pendingTasks.all().length} hasRuntime=${Boolean(api.runtime)} ` +
              `hasSubagent=${Boolean(api.runtime?.subagent)} stateFile=${stateFile}`,
          );
          // Generic Notifier: tasks emit a Notification; transports deliver it.
          // Built unconditionally so both the completion-notifier and the
          // scheduler's agent_prompt action share one fanout.
          // T1 = Mercure `notification` event on the user's topic (web frontend
          // renders it via one handler — see plan-notifier-delivery.md §3.1).
          const mercureCfg = resolveMercureConfig(api.pluginConfig ?? {});
          const transports: NotificationTransport[] = [];
          if (mercureCfg) {
            // T1 live in-app event (renders if the user's chat SSE is open).
            transports.push(
              new MercureNotificationTransport(new MercurePusher(mercureCfg, ctx.logger)),
            );
          }
          if (config.db) {
            // T2 durable: persist as an assistant-only history row so it shows
            // on next reload even if the user was offline (key for scheduled tasks).
            transports.push(new DbHistoryTransport(config.db, ctx.logger));
          }
          const smtpCfg = resolveSmtpConfig(api.pluginConfig ?? {});
          if (smtpCfg && config.db) {
            // T3 offline push: email subscribers (address from feed_report_subscriber).
            transports.push(new EmailNotificationTransport(smtpCfg, config.db));
          }
          const fanout = new Notifier(transports, ctx.logger);
          if (!fanout.hasTransports()) {
            ctx.logger.warn(
              "[LEADING_V2] No notification transport configured (set plugins.leading-v2.mercure)",
            );
          }

          if (notify.enabled) {
            // Title/category vary by task kind; everything else is shared.
            const NOTIFY_TITLES: Record<
              NotifyKind,
              { named: (t: string) => string; done: string }
            > = {
              crawl_refresh: { named: (t) => `互动量刷新：${t}`, done: "互动量刷新完成" },
              link_check: { named: (t) => `失效链接检测：${t}`, done: "失效链接检测完成" },
              legal_check: { named: (t) => `内容检测：${t}`, done: "内容检测完成" },
            };
            const deliver = async (
              task: {
                uid: string;
                sessionKey: string;
                mercureTopic: string;
                backendId: string;
                title: string | null;
                kind: NotifyKind;
              },
              summary: string,
            ) => {
              const topic = task.mercureTopic || task.uid;
              debugLog(`deliver notification topic=${topic} category=${task.kind}`);
              const titles = NOTIFY_TITLES[task.kind] ?? NOTIFY_TITLES.crawl_refresh;
              await fanout.notify(
                {
                  id: `${task.kind}:${task.backendId}`,
                  uid: task.uid,
                  category: task.kind,
                  level: "success",
                  title: task.title ? titles.named(task.title) : titles.done,
                  body: summary,
                  ts: Date.now(),
                },
                { mercureTopic: topic, sessionKey: task.sessionKey },
              );
            };
            const adapters = {
              crawl_refresh: pollCrawlRefresh,
              link_check: pollLinkCheck,
              legal_check: pollLegalCheck,
            };
            notifier = new CompletionNotifier({
              registry: pendingTasks,
              resolver,
              config,
              notify,
              deliver,
              logger: ctx.logger,
              adapters,
            });
            notifier.start();

            // Expose a narrow enqueue hook so sibling extensions (legal-check
            // submits 内容检测 jobs) can register a task for proactive completion
            // notification without importing across the plugin boundary. Only
            // installed while notify is enabled; removed on stop.
            setNotifyEnqueue((input) => {
              if (!(input.kind in adapters)) {
                return false;
              }
              if (!input.sessionKey || !input.backendId || !input.uid) {
                return false;
              }
              const now = Date.now();
              pendingTasks.add({
                id: `${input.kind}:${input.backendId}`,
                kind: input.kind as NotifyKind,
                uid: input.uid,
                backendId: input.backendId,
                sessionKey: input.sessionKey,
                mercureTopic: input.mercureTopic || getChatMercureTopic(input.uid) || input.uid,
                delivery: input.delivery ?? {},
                title: input.title ?? null,
                createdAt: now,
                attempts: 0,
                notified: false,
                expiresAt: now + notify.ttlMs,
              });
              return true;
            });
          }

          // Scheduler: run user-defined recurring tasks; results flow through the
          // same completion-notifier + Notifier as chat-initiated tasks.
          // MySQL-backed when a db is configured (shared with the web frontend
          // so it can list/edit/delete the same schedules); JSON file otherwise.
          await scheduleStore.init(
            join(ctx.stateDir, "leading-v2-schedules.json"),
            ctx.logger,
            config.db,
          );
          // Scheduled agent runs burn tokens like any chat turn, so they are
          // billed onto the same history_messages columns. Providers quote unit
          // prices in different currencies; this folds them into one.
          const usagePolicy = resolveUsageCurrencyPolicy(api.pluginConfig ?? {});
          ctx.logger.info(
            `[LEADING_V2] Scheduled-run usage accounting in ${usagePolicy.currency} ` +
              `(rate=${usagePolicy.rate} for ${usagePolicy.foreignProviders.join(",")})`,
          );
          const runners = buildRunners({
            config,
            resolver,
            registry: pendingTasks,
            subagent: api.runtime?.subagent,
            deliver: (n, to) => fanout.notify(n, to),
            usagePolicy,
            appConfig: api.config,
            logger: ctx.logger,
          });
          scheduler = new Scheduler({ store: scheduleStore, runners, logger: ctx.logger });
          scheduler.start();

          ctx.logger.info("[LEADING_V2] Service initialized");
        } catch (error) {
          debugLog(`service.start ERROR ${String(error)}`);
          throw error;
        }
      },
      async stop(ctx) {
        clearNotifyEnqueue();
        notifier?.stop();
        scheduler?.stop();
        await pendingTasks.flush();
        await scheduleStore.flush();
        await closePool();
        ctx.logger.info("[LEADING_V2] DB pool closed, service stopped");
      },
    });
  },
});
