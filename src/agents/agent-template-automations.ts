import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { listAgentIds } from "./agent-scope-config.js";

const text = z.string().min(1);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: text }).strict(),
  z
    .object({
      kind: z.literal("every"),
      everyMs: z.number().int().positive(),
      anchorMs: timestamp.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expr: text,
      tz: text.optional(),
      staggerMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

export const agentTemplateAutomationsSchema = z.array(
  z
    .object({
      name: text.refine((value) => value.trim().length > 0),
      description: z.string().optional(),
      schedule: scheduleSchema,
      pacing: z.object({ min: text.optional(), max: text.optional() }).strict().optional(),
      payload: z
        .object({
          kind: z.literal("agentTurn"),
          message: text,
          model: text.optional(),
          thinking: text.optional(),
          timeoutSeconds: z.number().int().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
);

export type AgentTemplateAutomation = z.infer<typeof agentTemplateAutomationsSchema>[number];

export function exportAgentTemplateAutomations(jobs: readonly CronJob[], agentId: string) {
  const automations: AgentTemplateAutomation[] = [];
  let unsupportedPayload = 0;
  let unsupportedSchedule = 0;
  let omittedTriggers = 0;
  for (const job of jobs) {
    if (job.agentId !== agentId || job.owner?.agentId !== agentId) {
      continue;
    }
    if (job.payload.kind !== "agentTurn") {
      unsupportedPayload++;
      continue;
    }
    if (job.schedule.kind === "on-exit" || job.schedule.kind === "stream") {
      unsupportedSchedule++;
      continue;
    }
    if (job.trigger) {
      omittedTriggers++;
    }
    const { name, description } = job;
    const { kind, message, model, thinking, timeoutSeconds } = job.payload;
    const schedule = job.schedule;
    automations.push({
      name,
      description,
      schedule:
        schedule.kind === "at"
          ? { kind: "at", at: schedule.at }
          : schedule.kind === "every"
            ? { kind: "every", everyMs: schedule.everyMs, anchorMs: schedule.anchorMs }
            : { kind: "cron", expr: schedule.expr, tz: schedule.tz, staggerMs: schedule.staggerMs },
      ...(job.pacing ? { pacing: { min: job.pacing.min, max: job.pacing.max } } : {}),
      payload: { kind, message, model, thinking, timeoutSeconds },
    });
  }
  const omissions = [
    ...(unsupportedPayload
      ? [`${unsupportedPayload} automation(s) skipped: unsupported payload for portable templates`]
      : []),
    ...(unsupportedSchedule
      ? [`${unsupportedSchedule} automation(s) skipped: executable schedule for portable templates`]
      : []),
    ...(omittedTriggers ? [`${omittedTriggers} automation trigger(s) not exported`] : []),
  ];
  return { automations: agentTemplateAutomationsSchema.parse(automations), omissions };
}

export type AgentTemplateAutomationImportOutcome =
  | { name: string; status: "created"; id: string }
  | { name: string; status: "failed"; error: string };

async function templateCronDependencies(cfg: OpenClawConfig): Promise<CronServiceDeps> {
  const { resolveCronJobsStorePathFromConfig } = await import("../cron/store.js");
  const noop = () => {};
  return {
    storePath: resolveCronJobsStorePathFromConfig(cfg),
    cronEnabled: false,
    cronConfig: cfg.cron,
    isAgentAvailable: (id) => listAgentIds(cfg).includes(id),
    log: { debug: noop, info: noop, warn: noop, error: noop },
    enqueueSystemEvent: () => false,
    requestHeartbeat: noop,
    runIsolatedAgentJob: async () => ({
      status: "skipped",
      error: "Template import does not run automations",
    }),
  };
}

function templateCronInput(agentId: string, automation: AgentTemplateAutomation): CronJobCreate {
  return {
    ...automation,
    agentId,
    owner: { agentId },
    enabled: false,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    delivery: { mode: "none" },
  };
}

/** Use the add-path validator in memory before agent creation publishes any state. */
export async function validateAgentTemplateAutomations(
  cfg: OpenClawConfig,
  agentId: string,
  automations: AgentTemplateAutomation[],
): Promise<void> {
  if (!automations.length) {
    return;
  }
  const [{ createJob }, { createCronServiceState }, { assertCronStoreCanPersist }, deps] =
    await Promise.all([
      import("../cron/service/jobs.js"),
      import("../cron/service/state.js"),
      import("../cron/store/row-codec.js"),
      templateCronDependencies(cfg),
    ]);
  const state = createCronServiceState(deps);
  const jobs = automations.map((automation) =>
    createJob(state, templateCronInput(agentId, automation)),
  );
  assertCronStoreCanPersist({ version: 1, jobs });
}

export async function importAgentTemplateAutomations(
  cfg: OpenClawConfig,
  agentId: string,
  automations: AgentTemplateAutomation[],
): Promise<AgentTemplateAutomationImportOutcome[]> {
  if (!automations.length) {
    return [];
  }
  const [{ CronService }, deps] = await Promise.all([
    import("../cron/service.js"),
    templateCronDependencies(cfg),
  ]);
  const service = new CronService(deps);
  const outcomes: AgentTemplateAutomationImportOutcome[] = [];
  try {
    for (const automation of automations) {
      try {
        const job = await service.add(templateCronInput(agentId, automation));
        outcomes.push({ name: automation.name, status: "created", id: job.id });
      } catch (error) {
        outcomes.push({
          name: automation.name,
          status: "failed",
          error: formatErrorMessage(error),
        });
      }
    }
  } finally {
    service.stop();
  }
  return outcomes;
}
