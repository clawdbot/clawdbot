import { toNumber } from "../format";
import type { GatewayBrowserClient } from "../gateway";
import type { CronJob, CronRunLogEntry, CronStatus } from "../types";
import type { CronFormState } from "../ui-types";

export type CronState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronLoading: boolean;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronRunsJobId: string | null;
  cronRuns: CronRunLogEntry[];
  cronBusy: boolean;
};

export async function loadCronStatus(state: CronState) {
  if (!state.client || !state.connected) return;
  try {
    const res = (await state.client.request("cron.status", {})) as CronStatus;
    state.cronStatus = res;
  } catch (err) {
    state.cronError = String(err);
  }
}

export async function loadCronJobs(state: CronState) {
  if (!state.client || !state.connected) return;
  if (state.cronLoading) return;
  state.cronLoading = true;
  state.cronError = null;
  try {
    const res = (await state.client.request("cron.list", {
      includeDisabled: true,
    })) as { jobs?: CronJob[] };
    state.cronJobs = Array.isArray(res.jobs) ? res.jobs : [];
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronLoading = false;
  }
}

export function buildCronSchedule(form: CronFormState) {
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) throw new Error("Invalid run time.");
    return { kind: "at" as const, atMs: ms };
  }
  if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
    if (amount <= 0) throw new Error("Invalid interval amount.");
    const unit = form.everyUnit;
    const mult = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
    return { kind: "every" as const, everyMs: amount * mult };
  }
  const expr = form.cronExpr.trim();
  if (!expr) throw new Error("Cron expression required.");
  return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
}

export function buildCronPayload(form: CronFormState) {
  if (form.payloadKind === "systemEvent") {
    const text = form.payloadText.trim();
    if (!text) throw new Error("System event text required.");
    return { kind: "systemEvent" as const, text };
  }
  const message = form.payloadText.trim();
  if (!message) throw new Error("Agent message required.");
  const payload: {
    kind: "agentTurn";
    message: string;
    deliver?: boolean;
    channel?:
      | "last"
      | "whatsapp"
      | "telegram"
      | "discord"
      | "slack"
      | "signal"
      | "imessage";
    to?: string;
    timeoutSeconds?: number;
  } = { kind: "agentTurn", message };
  if (form.deliver) payload.deliver = true;
  if (form.channel) payload.channel = form.channel;
  if (form.to.trim()) payload.to = form.to.trim();
  const timeoutSeconds = toNumber(form.timeoutSeconds, 0);
  if (timeoutSeconds > 0) payload.timeoutSeconds = timeoutSeconds;
  return payload;
}

export async function addCronJob(state: CronState) {
  if (!state.client || !state.connected || state.cronBusy) return;
  state.cronBusy = true;
  state.cronError = null;
  try {
    const schedule = buildCronSchedule(state.cronForm);
    const payload = buildCronPayload(state.cronForm);
    const job = {
      name: state.cronForm.name.trim(),
      description: state.cronForm.description.trim() || undefined,
      enabled: state.cronForm.enabled,
      schedule,
      sessionTarget: state.cronForm.sessionTarget,
      wakeMode: state.cronForm.wakeMode,
      payload,
      isolation:
        state.cronForm.postToMainPrefix.trim() &&
        state.cronForm.sessionTarget === "isolated"
          ? { postToMainPrefix: state.cronForm.postToMainPrefix.trim() }
          : undefined,
    };
    if (!job.name) throw new Error("Name required.");
    await state.client.request("cron.add", job);
    state.cronForm = {
      ...state.cronForm,
      name: "",
      description: "",
      payloadText: "",
    };
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function toggleCronJob(
  state: CronState,
  job: CronJob,
  enabled: boolean,
) {
  if (!state.client || !state.connected || state.cronBusy) return;
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.update", { id: job.id, patch: { enabled } });
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function runCronJob(state: CronState, job: CronJob) {
  if (!state.client || !state.connected || state.cronBusy) return;
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.run", { id: job.id, mode: "force" });
    await loadCronRuns(state, job.id);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function removeCronJob(state: CronState, job: CronJob) {
  if (!state.client || !state.connected || state.cronBusy) return;
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.remove", { id: job.id });
    if (state.cronRunsJobId === job.id) {
      state.cronRunsJobId = null;
      state.cronRuns = [];
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function loadCronRuns(state: CronState, jobId: string) {
  if (!state.client || !state.connected) return;
  try {
    const res = (await state.client.request("cron.runs", {
      id: jobId,
      limit: 50,
    })) as { entries?: CronRunLogEntry[] };
    state.cronRunsJobId = jobId;
    state.cronRuns = Array.isArray(res.entries) ? res.entries : [];
  } catch (err) {
    state.cronError = String(err);
  }
}
