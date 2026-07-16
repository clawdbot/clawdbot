// Control UI tests cover cron behavior.
import { describe, expect, it, vi } from "vitest";
import {
  addCronJob,
  cancelCronEdit,
  loadCronFailingCount,
  loadCronModelSuggestions,
  toggleCronJob,
  loadCronJobsPage,
  loadCronRuns,
  loadCronScopeStats,
  loadMoreCronRuns,
  normalizeCronFormState,
  resolveConfiguredCronModelSuggestions,
  runCronJob,
  startCronEdit,
  startCronClone,
  updateCronJobsFilter,
  validateCronForm,
  type CronState,
} from "../../lib/cron/index.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";

function createState(overrides: Partial<CronState> = {}): CronState {
  return {
    client: null,
    connected: true,
    cronLoading: false,
    cronJobsLoadingMore: false,
    cronJobsReloadPending: false,
    cronJobsReloadPendingTableFilters: false,
    cronJobs: [],
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    cronJobsLimit: 50,
    cronJobsQuery: "",
    cronJobsEnabledFilter: "all",
    cronJobsScheduleKindFilter: "all",
    cronJobsLastStatusFilter: "all",
    cronJobsSortBy: "nextRunAtMs",
    cronJobsSortDir: "asc",
    cronAgentId: null,
    cronStatus: null,
    cronScopedTotal: null,
    cronScopedNextWakeAtMs: null,
    cronFailingCount: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronCreateOpen: false,
    cronFieldErrors: {},
    cronEditingJobId: null,
    cronRunsJobId: null,
    cronRunsLoadingMore: false,
    cronRuns: [],
    cronRunsTotal: 0,
    cronRunsHasMore: false,
    cronRunsNextOffset: null,
    cronRunsLimit: 50,
    cronRunsScope: "all",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
    cronRunsStatusFilter: "all",
    cronRunsQuery: "",
    cronRunsSortDir: "desc",
    cronBusy: false,
    ...overrides,
  };
}

function findRequestCall(
  calls: ReadonlyArray<readonly [method: string, payload?: unknown]>,
  method: string,
): readonly [method: string, payload?: unknown] {
  const call = calls.find(([callMethod]) => callMethod === method);
  if (!call) {
    throw new Error(`Expected ${method} request call`);
  }
  return call;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectNestedRecordFields(
  record: Record<string, unknown>,
  key: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireRecord(record[key], key), fields);
}

function requestPayload(call: readonly [method: string, payload?: unknown]) {
  return requireRecord(call[1], `${call[0]} payload`);
}

function requestPatch(call: readonly [method: string, payload?: unknown]) {
  return requireRecord(requestPayload(call).patch, `${call[0]} patch`);
}

type EmptyCronListResponse = {
  jobs: [];
  total: number;
  hasMore: boolean;
  nextOffset: null;
};

describe("cron controller", () => {
  it("collects configured model suggestions from defaults and per-agent entries", () => {
    expect(
      resolveConfiguredCronModelSuggestions({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.2",
              fallbacks: ["google/gemini-2.5-pro", "openai/gpt-5.2-mini"],
            },
            models: {
              "anthropic/claude-sonnet-4-5": { alias: "smart" },
              "openai/gpt-5.2": { alias: "main" },
            },
          },
          list: {
            writer: {
              model: { primary: "xai/grok-4", fallbacks: ["openai/gpt-5.2-mini"] },
            },
            planner: {
              model: "google/gemini-2.5-flash",
            },
          },
        },
      }),
    ).toEqual([
      "anthropic/claude-sonnet-4-5",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "openai/gpt-5.2",
      "openai/gpt-5.2-mini",
      "xai/grok-4",
    ]);
  });

  it("returns no configured model suggestions for invalid or missing config", () => {
    expect(resolveConfiguredCronModelSuggestions(null)).toStrictEqual([]);
    expect(resolveConfiguredCronModelSuggestions({})).toStrictEqual([]);
    expect(
      resolveConfiguredCronModelSuggestions({ agents: { defaults: { model: "" } } }),
    ).toStrictEqual([]);
  });

  it("loads model suggestions from the configured model view", async () => {
    const request = vi.fn(async () => ({
      models: [
        { id: "z-model", provider: "zai" },
        { id: "a-model", provider: "anthropic" },
        { id: "z-model", provider: "other" },
        { provider: "missing-id" },
      ],
    }));
    const state = {
      client: { request } as unknown as CronState["client"],
      connected: true,
      cronModelSuggestions: [],
    };

    await loadCronModelSuggestions(state);

    expect(request).toHaveBeenCalledWith("models.list", { view: "configured" });
    expect(state.cronModelSuggestions).toEqual(["a-model", "z-model"]);
  });

  it("normalizes stale announce mode when session/payload no longer support announce", () => {
    const normalized = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      sessionTarget: "main",
      payloadKind: "systemEvent",
      deliveryMode: "announce",
    });

    expect(normalized.deliveryMode).toBe("none");
  });

  it("keeps announce mode when isolated agentTurn supports announce", () => {
    const normalized = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      deliveryMode: "announce",
    });

    expect(normalized.deliveryMode).toBe("announce");
  });

  it("forwards webhook delivery in cron.add payload", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-1" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "webhook job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run this",
        deliveryMode: "webhook",
        deliveryTo: "https://example.invalid/cron",
      },
    });

    const saved = await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    expect(saved.saved).toBe(true);
    const payload = requestPayload(addCall);
    expectRecordFields(payload, {
      name: "webhook job",
    });
    expectNestedRecordFields(payload, "delivery", {
      mode: "webhook",
      to: "https://example.invalid/cron",
    });
  });

  it("returns the saved job id from both cron.add response shapes", async () => {
    const responses = [{ created: true, job: { id: "job-wrapped" } }, { id: "job-bare" }];
    for (const response of responses) {
      const request = vi.fn(async (method: string) => {
        if (method === "cron.add") {
          return response;
        }
        if (method === "cron.list") {
          return { jobs: [] };
        }
        if (method === "cron.status") {
          return { enabled: true, jobs: 0, nextWakeAtMs: null };
        }
        return {};
      });
      const state = createState({
        client: { request } as unknown as CronState["client"],
        cronForm: {
          ...DEFAULT_CRON_FORM,
          name: "id echo",
          scheduleKind: "cron",
          cronExpr: "0 * * * *",
          sessionTarget: "isolated",
          payloadKind: "agentTurn",
          payloadText: "run this",
        },
      });

      const saved = await addCronJob(state);

      expect(saved).toEqual({
        saved: true,
        jobId: "job" in response ? "job-wrapped" : "job-bare",
      });
    }
  });

  it("forwards sessionKey and delivery accountId in cron.add payload", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-3" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "account-routed",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        sessionTarget: "isolated",
        payloadKind: "agentTurn",
        payloadText: "run this",
        sessionKey: "agent:ops:main",
        deliveryMode: "announce",
        deliveryAccountId: "ops-bot",
      },
    });

    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    const payload = requestPayload(addCall);
    expectRecordFields(payload, {
      sessionKey: "agent:ops:main",
    });
    expectNestedRecordFields(payload, "delivery", {
      mode: "announce",
      accountId: "ops-bot",
    });
  });

  it("omits a blank delivery accountId from cron.add payloads", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-blank-account-id" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "implicit account",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        sessionTarget: "isolated",
        payloadKind: "agentTurn",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryAccountId: "   ",
      },
    });

    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    expect(requireRecord(requestPayload(addCall).delivery, "delivery").accountId).toBeUndefined();
  });

  it('omits delivery.channel when the form still uses the "last" sentinel', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-last-add" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "implicit channel",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryChannel: "last",
      },
    });

    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    expectRecordFields(requireRecord(requestPayload(addCall).delivery, "delivery"), {
      mode: "announce",
    });
    expect(
      (addCall[1] as { delivery?: { channel?: string } } | undefined)?.delivery?.channel,
    ).toBeUndefined();
  });

  it("forwards lightContext in cron payload", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-light" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "light-context job",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        sessionTarget: "isolated",
        payloadKind: "agentTurn",
        payloadText: "run this",
        payloadLightContext: true,
      },
    });

    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    expectNestedRecordFields(requestPayload(addCall), "payload", {
      kind: "agentTurn",
      lightContext: true,
    });
  });

  it('sends delivery: { mode: "none" } explicitly in cron.add payload', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-none-add" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "none delivery job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run this",
        deliveryMode: "none",
      },
    });

    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    expect((addCall[1] as { delivery?: unknown } | undefined)?.delivery).toEqual({
      mode: "none",
    });
  });

  it('sends delivery: { mode: "none" } explicitly in cron.update patch', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-none-update" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-none-update" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronEditingJobId: "job-none-update",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "switch to none",
        scheduleKind: "every",
        everyAmount: "30",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "do work",
        deliveryMode: "none",
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expect(
      (updateCall[1] as { patch?: { delivery?: unknown } } | undefined)?.patch?.delivery,
    ).toEqual({
      mode: "none",
    });
  });

  it("sends explicit null model/thinking clears when blanking stored overrides on edit", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-clear-overrides" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-clear-overrides" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronEditingJobId: "job-clear-overrides",
      cronJobs: [
        {
          id: "job-clear-overrides",
          payload: {
            kind: "agentTurn",
            message: "do work",
            model: "openai/gpt-5.5",
            thinking: "high",
          },
        } as unknown as CronState["cronJobs"][number],
      ],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "clear overrides",
        scheduleKind: "every",
        everyAmount: "30",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "do work",
        payloadModel: "",
        payloadThinking: "",
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectNestedRecordFields(requestPatch(updateCall), "payload", {
      kind: "agentTurn",
      message: "do work",
      model: null,
      thinking: null,
    });
  });

  it("does not send null model/thinking for a new job with blank fields", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-new-blank" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-new-blank" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "new blank",
        scheduleKind: "every",
        everyAmount: "30",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "do work",
        payloadModel: "",
        payloadThinking: "",
      },
    });

    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    // A new job never had a stored override, so a blank field stays omitted
    // (no explicit null clear) rather than being mistaken for a cleared value.
    expectNestedRecordFields(requestPayload(addCall), "payload", {
      kind: "agentTurn",
      message: "do work",
      model: undefined,
      thinking: undefined,
    });
  });

  it("does not submit stale announce delivery when unsupported", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-2" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "main job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payloadKind: "systemEvent",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
    });

    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    expectRecordFields(requestPayload(addCall), {
      name: "main job",
    });
    // Delivery is explicitly sent as { mode: "none" } to clear the announce delivery on the backend.
    // Previously this was sent as undefined, which left announce in place (bug #31075).
    expect((addCall[1] as { delivery?: unknown } | undefined)?.delivery).toEqual({
      mode: "none",
    });
    // After submit, form is reset to defaults (deliveryMode = "announce" from DEFAULT_CRON_FORM).
    expect(state.cronForm.deliveryMode).toBe("announce");
  });

  it("submits cron.update when editing an existing job", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-1" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-1" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronEditingJobId: "job-1",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "edited job",
        description: "",
        clearAgent: true,
        deleteAfterRun: false,
        scheduleKind: "cron",
        cronExpr: "0 8 * * *",
        scheduleExact: true,
        payloadKind: "systemEvent",
        payloadText: "updated",
        deliveryMode: "none",
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-1",
    });
    expectRecordFields(requestPatch(updateCall), {
      name: "edited job",
      description: "",
      agentId: null,
      deleteAfterRun: false,
      schedule: { kind: "cron", expr: "0 8 * * *", staggerMs: 0 },
      payload: { kind: "systemEvent", text: "updated" },
      delivery: { mode: "none" },
    });
    expect(state.cronEditingJobId).toBeNull();
  });

  it("sends null delivery.accountId in cron.update to clear persisted account routing", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-clear-account-id" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-clear-account-id" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-clear-account-id",
      cronJobs: [
        {
          id: "job-clear-account-id",
          name: "clear account",
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "cron", expr: "0 * * * *" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "run" },
          delivery: { mode: "announce", accountId: "ops-bot" },
          state: {},
        },
      ],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "clear account",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run",
        deliveryMode: "announce",
        deliveryAccountId: "   ",
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-clear-account-id",
    });
    expectRecordFields(requireRecord(requestPatch(updateCall).delivery, "delivery"), {
      mode: "announce",
      accountId: null,
    });
  });

  it("maps a cron job into editable form fields", () => {
    const state = createState();
    const job = {
      id: "job-9",
      name: "Weekly report",
      description: "desc",
      sessionKey: "agent:ops:main",
      enabled: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every" as const, everyMs: 7_200_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "ship it", timeoutSeconds: 45 },
      delivery: { mode: "announce" as const, channel: "telegram", to: "123", accountId: "bot-2" },
      state: {},
    };

    startCronEdit(state, job);

    expect(state.cronEditingJobId).toBe("job-9");
    expect(state.cronRunsJobId).toBe("job-9");
    expect(state.cronForm.name).toBe("Weekly report");
    expect(state.cronForm.sessionKey).toBe("agent:ops:main");
    expect(state.cronForm.enabled).toBe(false);
    expect(state.cronForm.scheduleKind).toBe("every");
    expect(state.cronForm.everyAmount).toBe("2");
    expect(state.cronForm.everyUnit).toBe("hours");
    expect(state.cronForm.payloadKind).toBe("agentTurn");
    expect(state.cronForm.payloadText).toBe("ship it");
    expect(state.cronForm.timeoutSeconds).toBe("45");
    expect(state.cronForm.deliveryMode).toBe("announce");
    expect(state.cronForm.deliveryChannel).toBe("telegram");
    expect(state.cronForm.deliveryTo).toBe("123");
    expect(state.cronForm.deliveryAccountId).toBe("bot-2");
  });

  it("preserves command payloads when editing Control UI metadata", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-command" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-command" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const job = {
      id: "job-command",
      name: "Command",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every" as const, everyMs: 600_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "command" as const, argv: ["sh", "-lc", "echo ok"] },
      delivery: { mode: "announce" as const, channel: "telegram", to: "123" },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [job],
    });

    startCronEdit(state, job);
    state.cronForm.name = "Command renamed";
    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    const patch = requestPatch(updateCall);
    expect(patch.name).toBe("Command renamed");
    expect(patch).not.toHaveProperty("payload");
  });

  it("preserves on-exit schedules when editing Control UI metadata", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-on-exit" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-on-exit" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const job = {
      id: "job-on-exit",
      name: "On exit",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "on-exit" as const, command: "make build", cwd: "/repo" },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "report" },
      delivery: { mode: "none" as const },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [job],
    });

    startCronEdit(state, job);
    state.cronForm.name = "On exit renamed";
    state.cronForm.cronExpr = "";
    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    const patch = requestPatch(updateCall);
    expect(patch.name).toBe("On exit renamed");
    expect(patch).not.toHaveProperty("schedule");
    expect(state.cronFieldErrors).toEqual({});
  });

  it("applies schedule edits when changing an on-exit job to a regular schedule", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-on-exit" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-on-exit" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const job = {
      id: "job-on-exit",
      name: "On exit",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "on-exit" as const, command: "make build", cwd: "/repo" },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "report" },
      delivery: { mode: "none" as const },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [job],
    });

    startCronEdit(state, job);
    state.cronForm.scheduleKind = "every";
    state.cronForm.everyAmount = "5";
    state.cronForm.everyUnit = "minutes";
    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    const patch = requestPatch(updateCall);
    expect(patch.schedule).toEqual({ kind: "every", everyMs: 300_000 });
  });

  it('keeps implicit announce delivery implicit when editing a job that shows "last" in the form', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-implicit-delivery" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-implicit-delivery" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const job = {
      id: "job-implicit-delivery",
      name: "Implicit delivery",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
      delivery: { mode: "announce" as const, to: "123" },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [job],
    });

    startCronEdit(state, job);
    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-implicit-delivery",
    });
    expectRecordFields(requireRecord(requestPatch(updateCall).delivery, "delivery"), {
      mode: "announce",
      to: "123",
    });
    expect(
      (updateCall[1] as { patch?: { delivery?: { channel?: string } } } | undefined)?.patch
        ?.delivery?.channel,
    ).toBeUndefined();
  });

  it('sends delivery.channel="last" when editing clears an explicit channel back to implicit-last', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-clear-delivery-channel" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-clear-delivery-channel" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const job = {
      id: "job-clear-delivery-channel",
      name: "Clear delivery channel",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
      delivery: { mode: "announce" as const, channel: "telegram", to: "123" },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [job],
    });

    startCronEdit(state, job);
    state.cronForm.deliveryChannel = "last";
    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expect(
      (updateCall[1] as { patch?: { delivery?: { channel?: string } } } | undefined)?.patch
        ?.delivery?.channel,
    ).toBe("last");
  });

  it("includes model/thinking/stagger/bestEffort in cron.update patch", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-2" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-2" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-2",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "advanced edit",
        scheduleKind: "cron",
        cronExpr: "0 9 * * *",
        staggerAmount: "30",
        staggerUnit: "seconds",
        payloadKind: "agentTurn",
        payloadText: "run it",
        payloadModel: "opus",
        payloadThinking: "low",
        deliveryMode: "announce",
        deliveryBestEffort: true,
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-2",
    });
    const patch = requestPatch(updateCall);
    expectRecordFields(patch, {
      schedule: { kind: "cron", expr: "0 9 * * *", staggerMs: 30_000 },
      payload: {
        kind: "agentTurn",
        message: "run it",
        model: "opus",
        thinking: "low",
      },
    });
    expectNestedRecordFields(patch, "delivery", {
      mode: "announce",
      bestEffort: true,
    });
  });

  it("sends lightContext=false in cron.update when clearing prior light-context setting", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-clear-light" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-clear-light" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-clear-light",
      cronJobs: [
        {
          id: "job-clear-light",
          name: "Light job",
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "run", lightContext: true },
          state: {},
        },
      ],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "Light job",
        scheduleKind: "cron",
        cronExpr: "0 9 * * *",
        payloadKind: "agentTurn",
        payloadText: "run",
        payloadLightContext: false,
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-clear-light",
    });
    expectRecordFields(requireRecord(requestPatch(updateCall).payload, "payload"), {
      kind: "agentTurn",
      lightContext: false,
    });
  });

  it("includes custom failureAlert fields in cron.update patch", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert job",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "3",
        failureAlertCooldownSeconds: "120",
        failureAlertChannel: "telegram",
        failureAlertTo: "123456",
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-alert",
    });
    expectRecordFields(requireRecord(requestPatch(updateCall).failureAlert, "failureAlert"), {
      after: 3,
      cooldownMs: 120_000,
      channel: "telegram",
      to: "123456",
      mode: "announce",
      accountId: undefined,
    });
  });

  it("includes failure alert mode/accountId in cron.update patch", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert-mode" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert-mode" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert-mode",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert mode job",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "1",
        failureAlertDeliveryMode: "webhook",
        failureAlertAccountId: "bot-a",
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-alert-mode",
    });
    expectRecordFields(requireRecord(requestPatch(updateCall).failureAlert, "failureAlert"), {
      after: 1,
      mode: "webhook",
      accountId: "bot-a",
    });
  });

  it('keeps implicit failure alert delivery implicit when editing a job that shows "last" in the form', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert-implicit-channel" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert-implicit-channel" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const job = {
      id: "job-alert-implicit-channel",
      name: "Implicit failure alert",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
      delivery: { mode: "announce" as const, channel: "telegram", to: "123" },
      failureAlert: { after: 2, to: "123" },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [job],
    });

    startCronEdit(state, job);
    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-alert-implicit-channel",
    });
    expectRecordFields(requireRecord(requestPatch(updateCall).failureAlert, "failureAlert"), {
      after: 2,
      to: "123",
      mode: "announce",
    });
    expect(
      (updateCall[1] as { patch?: { failureAlert?: { channel?: string } } } | undefined)?.patch
        ?.failureAlert?.channel,
    ).toBeUndefined();
  });

  it('sends failureAlert.channel="last" when editing clears an explicit failure channel back to implicit-last', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-clear-failure-channel" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-clear-failure-channel" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const job = {
      id: "job-clear-failure-channel",
      name: "Clear failure channel",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
      delivery: { mode: "announce" as const, channel: "telegram", to: "123" },
      failureAlert: { after: 2, channel: "telegram", to: "123" },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [job],
    });

    startCronEdit(state, job);
    state.cronForm.failureAlertChannel = "last";
    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expect(
      (updateCall[1] as { patch?: { failureAlert?: { channel?: string } } } | undefined)?.patch
        ?.failureAlert?.channel,
    ).toBe("last");
  });

  it("omits failureAlert.cooldownMs when custom cooldown is left blank", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert-no-cooldown" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert-no-cooldown" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert-no-cooldown",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert job no cooldown",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "3",
        failureAlertCooldownSeconds: "",
        failureAlertChannel: "telegram",
        failureAlertTo: "123456",
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-alert-no-cooldown",
    });
    expectRecordFields(requireRecord(requestPatch(updateCall).failureAlert, "failureAlert"), {
      after: 3,
      channel: "telegram",
      to: "123456",
    });
    expect(
      (updateCall[1] as { patch?: { failureAlert?: { cooldownMs?: number } } })?.patch
        ?.failureAlert,
    ).not.toHaveProperty("cooldownMs");
  });

  it("includes failureAlert=false when disabled per job", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-no-alert" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-no-alert" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-no-alert",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert off",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "disabled",
      },
    });

    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expectRecordFields(requestPayload(updateCall), {
      id: "job-no-alert",
    });
    expect(requestPatch(updateCall).failureAlert).toBe(false);
  });

  it("maps cron stagger, model, thinking, and best effort into form", () => {
    const state = createState();
    const job = {
      id: "job-10",
      name: "Advanced job",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 7 * * *", tz: "UTC", staggerMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: {
        kind: "agentTurn" as const,
        message: "hi",
        model: "opus",
        thinking: "high",
      },
      delivery: { mode: "announce" as const, bestEffort: true },
      state: {},
    };
    startCronEdit(state, job);

    expect(state.cronForm.deleteAfterRun).toBe(true);
    expect(state.cronForm.scheduleKind).toBe("cron");
    expect(state.cronForm.scheduleExact).toBe(false);
    expect(state.cronForm.staggerAmount).toBe("1");
    expect(state.cronForm.staggerUnit).toBe("minutes");
    expect(state.cronForm.payloadModel).toBe("opus");
    expect(state.cronForm.payloadThinking).toBe("high");
    expect(state.cronForm.deliveryBestEffort).toBe(true);
  });

  it("maps failureAlert overrides into form fields", () => {
    const state = createState();
    const job = {
      id: "job-11",
      name: "Failure alerts",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "hello" },
      failureAlert: {
        after: 4,
        cooldownMs: 30_000,
        channel: "telegram",
        to: "999",
      },
      state: {},
    };

    startCronEdit(state, job);

    expect(state.cronForm.failureAlertMode).toBe("custom");
    expect(state.cronForm.failureAlertAfter).toBe("4");
    expect(state.cronForm.failureAlertCooldownSeconds).toBe("30");
    expect(state.cronForm.failureAlertChannel).toBe("telegram");
    expect(state.cronForm.failureAlertTo).toBe("999");
    expect(state.cronForm.failureAlertDeliveryMode).toBe("announce");
    expect(state.cronForm.failureAlertAccountId).toBe("");
  });

  it("validates key cron form errors", () => {
    const errors = validateCronForm({
      ...DEFAULT_CRON_FORM,
      name: "",
      scheduleKind: "cron",
      cronExpr: "",
      payloadKind: "agentTurn",
      payloadText: "",
      timeoutSeconds: "0",
      deliveryMode: "webhook",
      deliveryTo: "ftp://bad",
    });
    expect(errors.name).toBe("cron.errors.nameRequired");
    expect(errors.cronExpr).toBe("cron.errors.cronExprRequired");
    expect(errors.payloadText).toBe("cron.errors.agentMessageRequired");
    expect(errors.timeoutSeconds).toBe("cron.errors.timeoutInvalid");
    expect(errors.deliveryTo).toBe("cron.errors.webhookUrlInvalid");
  });

  it("does not require cron expression fields for on-exit schedules", () => {
    const errors = validateCronForm({
      ...DEFAULT_CRON_FORM,
      name: "on exit",
      scheduleKind: "on-exit",
      cronExpr: "",
      payloadKind: "agentTurn",
      payloadText: "report",
    });
    expect(errors.cronExpr).toBeUndefined();
  });

  it("blocks add/update submit when validation errors exist", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "",
        payloadText: "",
      },
    });
    const saved = await addCronJob(state);
    expect(saved.saved).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expectRecordFields(state.cronFieldErrors, {
      name: "cron.errors.nameRequired",
      payloadText: "cron.errors.agentMessageRequired",
    });
  });

  it("canceling edit resets form to defaults and clears edit mode", () => {
    const state = createState();
    const job = {
      id: "job-cancel",
      name: "Editable",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 6 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
      delivery: { mode: "announce" as const, to: "123" },
      state: {},
    };
    startCronEdit(state, job);
    state.cronForm.name = "changed";
    state.cronFieldErrors = { name: "Name is required." };

    cancelCronEdit(state);

    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronForm).toEqual({ ...DEFAULT_CRON_FORM });
    // Fresh forms start visually clean; validation re-arms on change/submit.
    expect(state.cronFieldErrors).toEqual({});
  });

  it("cloning a job switches to create mode and applies copy naming", () => {
    const state = createState({
      cronJobs: [
        {
          id: "job-1",
          name: "Daily ping",
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "ping" },
          state: {},
        },
      ],
      cronEditingJobId: "job-1",
    });

    const sourceJob = state.cronJobs[0];
    if (!sourceJob) {
      throw new Error("Expected source cron job");
    }
    startCronClone(state, sourceJob);

    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronRunsJobId).toBe("job-1");
    expect(state.cronForm.name).toBe("Daily ping copy");
    expect(state.cronForm.payloadText).toBe("ping");
  });

  it("submits cron.add after cloning", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-new" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });
    const sourceJob = {
      id: "job-1",
      name: "Daily ping",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 9 * * *" },
      sessionTarget: "main" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "systemEvent" as const, text: "ping" },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [sourceJob],
      cronEditingJobId: "job-1",
    });

    startCronClone(state, sourceJob);
    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeUndefined();
    expect((addCall[1] as { name?: string } | undefined)?.name).toBe("Daily ping copy");
  });

  it("loads paged jobs with query/filter/sort params", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.list") {
        expectRecordFields(requireRecord(payload, "cron.list payload"), {
          limit: 50,
          offset: 0,
          query: "daily",
          enabled: "enabled",
          scheduleKind: "cron",
          lastRunStatus: "error",
          sortBy: "updatedAtMs",
          sortDir: "desc",
        });
        return {
          jobs: [
            {
              id: "job-1",
              name: "Daily",
              enabled: true,
              createdAtMs: 0,
              updatedAtMs: 0,
              schedule: { kind: "cron", expr: "0 9 * * *" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "ping" },
            },
          ],
          total: 1,
          hasMore: false,
          nextOffset: null,
        };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobsQuery: "daily",
      cronJobsEnabledFilter: "enabled",
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "error",
      cronJobsSortBy: "updatedAtMs",
      cronJobsSortDir: "desc",
    });

    await loadCronJobsPage(state, { tableFilters: true });

    expect(state.cronJobs).toHaveLength(1);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronJobsHasMore).toBe(false);
  });

  it("keeps table-only filters out of shared cron jobs loads", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.list") {
        const listPayload = requireRecord(payload, "cron.list payload");
        expect(listPayload).not.toHaveProperty("scheduleKind");
        expect(listPayload).not.toHaveProperty("lastRunStatus");
        return { jobs: [], total: 0, hasMore: false, nextOffset: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "error",
    });

    await loadCronJobsPage(state);

    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.not.objectContaining({
        scheduleKind: expect.anything(),
        lastRunStatus: expect.anything(),
      }),
    );
  });

  it("reloads cron jobs after filters change during an in-flight table load", async () => {
    let resolveFirst!: (value: EmptyCronListResponse) => void;
    const firstResponse = new Promise<EmptyCronListResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method !== "cron.list") {
        return {};
      }
      if (request.mock.calls.length === 1) {
        return firstResponse;
      }
      expectRecordFields(requireRecord(payload, "pending cron.list payload"), {
        scheduleKind: "cron",
        lastRunStatus: "unknown",
      });
      return { jobs: [], total: 0, hasMore: false, nextOffset: null };
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
    });

    const firstLoad = loadCronJobsPage(state, { tableFilters: true });
    updateCronJobsFilter(state, {
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });
    await loadCronJobsPage(state, { tableFilters: true });
    resolveFirst({ jobs: [], total: 0, hasMore: false, nextOffset: null });
    await firstLoad;

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cronJobsReloadPending).toBe(false);
    expect(state.cronJobsReloadPendingTableFilters).toBe(false);
  });

  it("reloads cron jobs after filters change during an in-flight append load", async () => {
    let resolveAppend!: (value: EmptyCronListResponse) => void;
    const appendResponse = new Promise<EmptyCronListResponse>((resolve) => {
      resolveAppend = resolve;
    });
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method !== "cron.list") {
        return {};
      }
      if (request.mock.calls.length === 1) {
        expectRecordFields(requireRecord(payload, "append cron.list payload"), {
          offset: 1,
        });
        return appendResponse;
      }
      expectRecordFields(requireRecord(payload, "pending append cron.list payload"), {
        offset: 0,
        scheduleKind: "cron",
        lastRunStatus: "unknown",
      });
      return { jobs: [], total: 0, hasMore: false, nextOffset: null };
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [
        {
          id: "existing",
          name: "Existing",
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "ping" },
        },
      ],
      cronJobsHasMore: true,
      cronJobsNextOffset: 1,
    });

    const appendLoad = loadCronJobsPage(state, { append: true, tableFilters: true });
    updateCronJobsFilter(state, {
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });
    await loadCronJobsPage(state, { tableFilters: true });
    resolveAppend({ jobs: [], total: 0, hasMore: false, nextOffset: null });
    await appendLoad;

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cronJobsReloadPending).toBe(false);
    expect(state.cronJobsReloadPendingTableFilters).toBe(false);
  });

  it("uses the latest queued cron jobs table-filter mode", async () => {
    let resolveFirst!: (value: EmptyCronListResponse) => void;
    const firstResponse = new Promise<EmptyCronListResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method !== "cron.list") {
        return {};
      }
      if (request.mock.calls.length === 1) {
        return firstResponse;
      }
      const pendingPayload = requireRecord(payload, "latest pending cron.list payload");
      expect(pendingPayload).not.toHaveProperty("scheduleKind");
      expect(pendingPayload).not.toHaveProperty("lastRunStatus");
      return { jobs: [], total: 0, hasMore: false, nextOffset: null };
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });

    const firstLoad = loadCronJobsPage(state);
    await loadCronJobsPage(state, { tableFilters: true });
    await loadCronJobsPage(state);
    resolveFirst({ jobs: [], total: 0, hasMore: false, nextOffset: null });
    await firstLoad;

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cronJobsReloadPending).toBe(false);
    expect(state.cronJobsReloadPendingTableFilters).toBe(false);
  });

  it("drops malformed cron jobs before they enter UI state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            { id: "bad-missing-payload", name: "Broken", enabled: true },
            {
              id: "job-ok",
              name: "Daily",
              enabled: true,
              createdAtMs: 0,
              updatedAtMs: 0,
              schedule: { kind: "cron", expr: "0 9 * * *" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "ping" },
            },
          ],
          total: 2,
          hasMore: false,
          nextOffset: null,
        };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
    });

    await loadCronJobsPage(state);

    expect(state.cronJobs.map((job) => job.id)).toEqual(["job-ok"]);
    expect(state.cronJobsTotal).toBe(2);
    expect(state.cronJobsHasMore).toBe(false);
  });

  it("loads and appends paged run history", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method !== "cron.runs") {
        return {};
      }
      const offset = (payload as { offset?: number } | undefined)?.offset ?? 0;
      if (offset === 0) {
        return {
          entries: [{ ts: 2, jobId: "job-1", status: "ok", summary: "newest" }],
          total: 2,
          hasMore: true,
          nextOffset: 1,
        };
      }
      return {
        entries: [{ ts: 1, jobId: "job-1", status: "ok", summary: "older" }],
        total: 2,
        hasMore: false,
        nextOffset: null,
      };
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
    });

    await expect(loadCronRuns(state, "job-1")).resolves.toBe("ok");
    expect(state.cronRuns).toHaveLength(1);
    expect(state.cronRunsHasMore).toBe(true);

    await loadMoreCronRuns(state);
    expect(state.cronRuns).toHaveLength(2);
    expect(state.cronRuns[0]?.summary).toBe("newest");
    expect(state.cronRuns[1]?.summary).toBe("older");
  });

  it("scopes jobs and run history requests to the selected agent", async () => {
    const request = vi.fn(async (method: string) =>
      method === "cron.runs"
        ? { entries: [], total: 0, hasMore: false, nextOffset: null }
        : { jobs: [], total: 0, hasMore: false, nextOffset: null },
    );
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronAgentId: "writer",
    });

    await loadCronJobsPage(state);
    await loadCronRuns(state, null);

    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(request).toHaveBeenCalledWith(
      "cron.runs",
      expect.objectContaining({ agentId: "writer" }),
    );
  });

  it("returns an error status when run history loading fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("cron.runs unavailable");
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
    });

    await expect(loadCronRuns(state, null)).resolves.toBe("error");

    expect(state.cronError).toBe("Error: cron.runs unavailable");
  });

  it("runs cron job in due mode when requested", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.run") {
        expectRecordFields(requireRecord(payload, "cron.run payload"), {
          id: "job-due",
          mode: "due",
        });
        return { ok: true, enqueued: true, runId: "run-due" };
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, hasMore: false, nextOffset: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronRunsScope: "job",
      cronRunsJobId: "job-due",
    });
    await runCronJob(state, "job-due", "due");

    expect(request).toHaveBeenCalledWith("cron.run", { id: "job-due", mode: "due" });
    expect(request).toHaveBeenCalledWith("cron.runs", expect.any(Object));
  });

  it.each([
    ["not-due", "This automation is not due yet."],
    ["already-running", "This automation is already running."],
    ["restart-recovery-pending", "Scheduler recovery is still in progress."],
    ["stopped", "The scheduler is stopped."],
  ] as const)(
    "surfaces cron.run %s outcomes without reloading run history",
    async (reason, message) => {
      const request = vi.fn(async (method: string) => {
        if (method === "cron.run") {
          return { ok: true, ran: false, reason };
        }
        return {};
      });
      const state = createState({
        client: { request } as unknown as CronState["client"],
        cronRunsScope: "job",
        cronRunsJobId: "job-blocked",
      });

      await runCronJob(state, "job-blocked", "force");

      expect(state.cronError).toBe(message);
      expect(request).toHaveBeenCalledWith("cron.run", { id: "job-blocked", mode: "force" });
      expect(request).not.toHaveBeenCalledWith("cron.runs", expect.anything());
    },
  );

  it("reloads the skipped run recorded for an invalid persisted specification", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.run") {
        return { ok: true, ran: false, reason: "invalid-spec" };
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, hasMore: false, nextOffset: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronRunsScope: "job",
      cronRunsJobId: "job-invalid",
    });

    await runCronJob(state, "job-invalid", "force");

    expect(state.cronError).toBe("This automation has an invalid schedule or payload.");
    expect(request).toHaveBeenCalledWith(
      "cron.runs",
      expect.objectContaining({ id: "job-invalid" }),
    );
  });
});

describe("loadCronFailingCount", () => {
  it("queries the unfiltered enabled+error total and stores it", async () => {
    const request = vi.fn(async () => ({ jobs: [], total: 4, offset: 0, limit: 1 }));
    const state = createState({ client: { request } as unknown as CronState["client"] });
    await loadCronFailingCount(state);

    expect(request).toHaveBeenCalledWith("cron.list", {
      enabled: "enabled",
      lastRunStatus: "error",
      limit: 1,
      offset: 0,
    });
    expect(state.cronFailingCount).toBe(4);
  });

  it("refreshes after job mutations such as pause/resume", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (
        method === "cron.list" &&
        (payload as { lastRunStatus?: string })?.lastRunStatus === "error"
      ) {
        return { jobs: [], total: 1, offset: 0, limit: 1 };
      }
      if (method === "cron.list") {
        return { jobs: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0 };
      }
      return {};
    });
    const state = createState({ client: { request } as unknown as CronState["client"] });
    await toggleCronJob(state, { id: "job-1" } as never, false);

    expect(state.cronFailingCount).toBe(1);
  });

  it("degrades to null on request failure without touching cronError", async () => {
    const request = vi.fn(async () => {
      throw new Error("nope");
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronFailingCount: 2,
    });
    await loadCronFailingCount(state);

    expect(state.cronFailingCount).toBeNull();
    expect(state.cronError).toBeNull();
  });
});

describe("loadCronScopeStats", () => {
  it("loads filter-independent totals and next wake time for the selected agent", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ jobs: [], total: 7 })
      .mockResolvedValueOnce({ jobs: [{ state: { nextRunAtMs: 1234 } }], total: 1 });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronAgentId: "writer",
    });

    await loadCronScopeStats(state);

    expect(state.cronScopedTotal).toBe(7);
    expect(state.cronScopedNextWakeAtMs).toBe(1234);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "cron.list",
      expect.objectContaining({ agentId: "writer", includeDisabled: true }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
