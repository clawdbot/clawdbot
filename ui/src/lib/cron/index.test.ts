// @vitest-environment node
// Control UI tests cover cron behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob, CronJobsListResult, CronRunsResult } from "../../api/types.ts";
import { parseCronDurationMs } from "../../lib/cron/decimal.ts";
import {
  addCronJob,
  cancelCronEdit,
  createInitialCronState,
  loadCronModelSuggestions,
  toggleCronJob,
  loadCronJobsPage,
  loadCronRuns,
  loadCronScopeStats,
  loadMoreCronRuns,
  normalizeCronFormState,
  removeCronJob,
  resolveConfiguredCronModelSuggestions,
  runCronJob,
  startCronEdit,
  startCronClone,
  updateCronJobsFilter,
  updateCronRunsFilter,
  validateCronForm,
  type CronState,
} from "../../lib/cron/index.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";

function createState(overrides: Partial<CronState> = {}): CronState {
  return {
    ...createInitialCronState({ connected: true }),
    ...overrides,
  };
}

function createCronRequest(jobId: string, options: { existing?: boolean } = {}) {
  const existingJob = createCronJob({ id: jobId, name: "Existing job" });
  const jobs = options.existing ? [existingJob] : [];
  return vi.fn(async (method: string, _payload?: unknown) => {
    if (method === "cron.add") {
      return { id: jobId };
    }
    if (method === "cron.update") {
      return existingJob;
    }
    if (method === "cron.list") {
      return cronJobsListResponse(jobs as CronJob[]);
    }
    if (method === "cron.status") {
      return { enabled: true, jobs: jobs.length, nextWakeAtMs: null };
    }
    return {};
  });
}

function createMethodRequest(responses: Readonly<Record<string, unknown>>) {
  return vi.fn(async (method: string) => responses[method] ?? {});
}

function createCronJob(overrides: Partial<CronJob> & Pick<CronJob, "id" | "name">): CronJob {
  return {
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    configRevision: "config-revision-1",
    schedule: { kind: "cron", expr: "0 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
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

function createStateWithRequest(request: unknown, overrides: Partial<CronState> = {}): CronState {
  return createState({
    client: { request } as unknown as CronState["client"],
    ...overrides,
  });
}

function createCronForm(overrides: Partial<CronState["cronForm"]> = {}): CronState["cronForm"] {
  return { ...DEFAULT_CRON_FORM, ...overrides };
}

function createCronSubmitHarness(
  jobId: string,
  options: {
    method?: "cron.add" | "cron.update";
    listExisting?: boolean;
    jobs?: CronJob[];
    form?: Partial<CronState["cronForm"]>;
    state?: Partial<CronState>;
  } = {},
) {
  const method = options.method ?? "cron.add";
  const request = createCronRequest(jobId, {
    existing: options.listExisting ?? method === "cron.update",
  });
  const loadedJobs = options.jobs?.map((job) =>
    createCronJob({
      ...job,
      id: job.id,
      name: job.name ?? options.form?.name ?? "Existing job",
      configRevision: job.configRevision ?? "config-revision-1",
    }),
  );
  const editingJob =
    method === "cron.update"
      ? (loadedJobs?.find((job) => job.id === jobId) ??
        createCronJob({ id: jobId, name: options.form?.name ?? "Existing job" }))
      : null;
  const state = createStateWithRequest(request, {
    ...options.state,
    ...(loadedJobs ? { cronJobs: loadedJobs } : editingJob ? { cronJobs: [editingJob] } : {}),
    cronForm: createCronForm(options.form),
  });
  if (editingJob) {
    startCronEdit(state, editingJob);
    state.cronForm = createCronForm(options.form);
  }
  const submit = async () => {
    const result = await addCronJob(state);
    return { call: findRequestCall(request.mock.calls, method), result };
  };
  return { request, state, submit };
}

function createCronEditHarness(job: CronJob) {
  const request = createCronRequest(job.id, { existing: true });
  const state = createStateWithRequest(request, { cronJobs: [job] });
  startCronEdit(state, job);
  const submit = async () => {
    await addCronJob(state);
    return findRequestCall(request.mock.calls, "cron.update");
  };
  return { request, state, submit };
}

const requireRecord = createRequireRecord("record", "expected-label-record");

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

function cronJobsListResponse(
  jobs: CronJob[],
  overrides: Partial<Omit<CronJobsListResult, "jobs">> = {},
): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "cron-jobs-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
    ...overrides,
  };
}

function emptyCronListResponse(
  overrides: Partial<Omit<CronJobsListResult, "jobs">> = {},
): CronJobsListResult {
  return cronJobsListResponse([], overrides);
}

function createCronRunsResult(
  entries: CronRunsResult["entries"],
  overrides: Partial<Omit<CronRunsResult, "entries">> = {},
): CronRunsResult {
  return {
    entries,
    total: entries.length,
    hasMore: false,
    nextOffset: null,
    ...overrides,
  };
}

function createCronRunsRace(
  currentEntries: CronRunsResult["entries"],
  stateOverrides: Partial<CronState> = {},
) {
  const older = createDeferred<CronRunsResult>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => older.promise)
    .mockResolvedValueOnce(createCronRunsResult(currentEntries));
  return { older, state: createStateWithRequest(request, stateOverrides) };
}

function createCronJobsReloadHarness(stateOverrides: Partial<CronState> = {}) {
  const first = createDeferred<CronJobsListResult>();
  const payloads: unknown[] = [];
  const request = vi.fn(async (method: string, payload?: unknown) => {
    if (method !== "cron.list") {
      return {};
    }
    payloads.push(payload);
    return payloads.length === 1 ? first.promise : emptyCronListResponse();
  });
  return {
    first,
    payloads,
    request,
    state: createStateWithRequest(request, stateOverrides),
  };
}

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
          entries: {
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

    await loadCronModelSuggestions(state, "writer");

    expect(request).toHaveBeenCalledWith("models.list", {
      agentId: "writer",
      view: "configured",
      preparedOnly: true,
    });
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

  it.each([
    {
      changed: "payloadKind",
      form: { sessionTarget: "isolated", payloadKind: "systemEvent" },
      expected: { sessionTarget: "main", payloadKind: "systemEvent" },
    },
    {
      changed: "payloadKind",
      form: { sessionTarget: "main", payloadKind: "agentTurn" },
      expected: { sessionTarget: "isolated", payloadKind: "agentTurn" },
    },
    {
      changed: "sessionTarget",
      form: { sessionTarget: "main", payloadKind: "agentTurn" },
      expected: { sessionTarget: "main", payloadKind: "systemEvent" },
    },
    {
      changed: "sessionTarget",
      form: { sessionTarget: "isolated", payloadKind: "systemEvent" },
      expected: { sessionTarget: "isolated", payloadKind: "agentTurn" },
    },
  ] as const)(
    "keeps editable actions and sessions compatible when $changed changes",
    (scenario) => {
      const normalized = normalizeCronFormState(
        { ...DEFAULT_CRON_FORM, ...scenario.form },
        { [scenario.changed]: scenario.form[scenario.changed] },
      );

      expect(normalized).toMatchObject(scenario.expected);
      if (normalized.sessionTarget === "main") {
        expect(normalized.deliveryMode).toBe("none");
      }
    },
  );

  it.each(["current", "session:project-alpha"] as const)(
    "preserves the supported %s target while editing an agent action",
    (sessionTarget) => {
      expect(
        normalizeCronFormState(
          { ...DEFAULT_CRON_FORM, sessionTarget },
          { payloadKind: "agentTurn" },
        ),
      ).toMatchObject({ sessionTarget, payloadKind: "agentTurn" });
    },
  );

  it("preserves locked main-session script payloads", () => {
    expect(
      normalizeCronFormState({
        ...DEFAULT_CRON_FORM,
        sessionTarget: "main",
        payloadKind: "script",
        payloadLocked: true,
      }),
    ).toMatchObject({ sessionTarget: "main", payloadKind: "script", deliveryMode: "none" });
  });

  it.each([
    ["cron.add", null],
    ["cron.update", "no-timeout-job"],
  ] as const)(
    "preserves an explicit zero timeout in %s payloads",
    async (method, _editingJobId) => {
      const { submit } = createCronSubmitHarness("no-timeout-job", {
        method,
        listExisting: false,
        form: {
          name: "No timeout",
          payloadText: "Run until complete",
          timeoutSeconds: "0",
        },
      });

      const submitted = await submit();
      expect(submitted.result).toEqual({ saved: true, jobId: "no-timeout-job" });

      const call = submitted.call;
      const job = method === "cron.update" ? requestPatch(call) : requestPayload(call);
      expectNestedRecordFields(job, "payload", {
        kind: "agentTurn",
        message: "Run until complete",
        timeoutSeconds: 0,
      });
    },
  );

  it.each(["", "   "])("omits an inherited timeout from cron.add: %j", async (timeoutSeconds) => {
    const { submit } = createCronSubmitHarness("inherited-timeout-job", {
      form: {
        name: "Inherited timeout",
        payloadText: "Use the default timeout",
        timeoutSeconds,
      },
    });

    const submitted = await submit();
    expect(submitted.result).toEqual({ saved: true, jobId: "inherited-timeout-job" });
    const payload = requireRecord(requestPayload(submitted.call).payload, "cron.add agent payload");
    expect(payload).not.toHaveProperty("timeoutSeconds");
  });

  it("forwards webhook delivery in cron.add payload", async () => {
    const { submit } = createCronSubmitHarness("job-1", {
      form: {
        name: "webhook job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        wakeMode: "next-heartbeat",
        payloadText: "run this",
        deliveryMode: "webhook",
        deliveryTo: "https://example.invalid/cron",
      },
    });

    const submitted = await submit();

    expect(submitted.result.saved).toBe(true);
    const payload = requestPayload(submitted.call);
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
      const request = createMethodRequest({
        "cron.add": response,
        "cron.list": emptyCronListResponse(),
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      });
      const state = createStateWithRequest(request, {
        cronForm: createCronForm({
          name: "id echo",
          scheduleKind: "cron",
          cronExpr: "0 * * * *",
          payloadText: "run this",
        }),
      });

      const saved = await addCronJob(state);

      expect(saved).toEqual({
        saved: true,
        jobId: "job" in response ? "job-wrapped" : "job-bare",
      });
    }
  });

  it("forwards sessionKey and delivery accountId in cron.add payload", async () => {
    const { submit } = createCronSubmitHarness("job-3", {
      form: {
        name: "account-routed",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        payloadText: "run this",
        sessionKey: "agent:ops:main",
        deliveryMode: "announce",
        deliveryAccountId: "ops-bot",
      },
    });

    const { call } = await submit();

    const payload = requestPayload(call);
    expectRecordFields(payload, {
      sessionKey: "agent:ops:main",
    });
    expectNestedRecordFields(payload, "delivery", {
      mode: "announce",
      accountId: "ops-bot",
    });
  });

  it("omits a blank delivery accountId from cron.add payloads", async () => {
    const { submit } = createCronSubmitHarness("job-blank-account-id", {
      form: {
        name: "implicit account",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryAccountId: "   ",
      },
    });

    const { call } = await submit();

    expect(requireRecord(requestPayload(call).delivery, "delivery").accountId).toBeUndefined();
  });

  it('omits delivery.channel when the form still uses the "last" sentinel', async () => {
    const { submit } = createCronSubmitHarness("job-last-add", {
      form: {
        name: "implicit channel",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        wakeMode: "next-heartbeat",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryChannel: "last",
      },
    });

    const { call } = await submit();

    expectRecordFields(requireRecord(requestPayload(call).delivery, "delivery"), {
      mode: "announce",
    });
    expect(
      (call[1] as { delivery?: { channel?: string } } | undefined)?.delivery?.channel,
    ).toBeUndefined();
  });

  it("forwards lightContext in cron payload", async () => {
    const { submit } = createCronSubmitHarness("job-light", {
      form: {
        name: "light-context job",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        payloadText: "run this",
        payloadLightContext: true,
      },
    });

    const { call } = await submit();

    expectNestedRecordFields(requestPayload(call), "payload", {
      kind: "agentTurn",
      lightContext: true,
    });
  });

  it('defaults a fresh cron.add to delivery: { mode: "none" }', async () => {
    const request = createCronRequest("job-none-add");
    const state = createStateWithRequest(request);
    state.cronForm.name = "none delivery job";
    state.cronForm.payloadText = "run this";

    await addCronJob(state);
    const call = findRequestCall(request.mock.calls, "cron.add");

    expect((call[1] as { delivery?: unknown } | undefined)?.delivery).toEqual({
      mode: "none",
    });
  });

  it('sends delivery: { mode: "none" } explicitly in cron.update patch', async () => {
    const { submit } = createCronSubmitHarness("job-none-update", {
      method: "cron.update",
      form: {
        name: "switch to none",
        wakeMode: "next-heartbeat",
        payloadText: "do work",
        deliveryMode: "none",
      },
    });

    const { call } = await submit();

    expect((call[1] as { patch?: { delivery?: unknown } } | undefined)?.patch?.delivery).toEqual({
      mode: "none",
    });
  });

  it("sends explicit null model/thinking clears when blanking stored overrides on edit", async () => {
    const { submit } = createCronSubmitHarness("job-clear-overrides", {
      method: "cron.update",
      jobs: [
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
      form: {
        name: "clear overrides",
        wakeMode: "next-heartbeat",
        payloadText: "do work",
        payloadModel: "",
        payloadThinking: "",
      },
    });

    const { call } = await submit();

    expectNestedRecordFields(requestPatch(call), "payload", {
      kind: "agentTurn",
      message: "do work",
      model: null,
      thinking: null,
    });
  });

  it("does not send null model/thinking for a new job with blank fields", async () => {
    const { submit } = createCronSubmitHarness("job-new-blank", {
      listExisting: true,
      form: {
        name: "new blank",
        wakeMode: "next-heartbeat",
        payloadText: "do work",
        payloadModel: "",
        payloadThinking: "",
      },
    });

    const { call } = await submit();

    // A new job never had a stored override, so a blank field stays omitted
    // (no explicit null clear) rather than being mistaken for a cleared value.
    expectNestedRecordFields(requestPayload(call), "payload", {
      kind: "agentTurn",
      message: "do work",
      model: undefined,
      thinking: undefined,
      tokenBudget: undefined,
    });
  });

  it("sends a new job's tokenBudget and omits blank (unlimited)", async () => {
    const { submit } = createCronSubmitHarness("job-budget-new", {
      form: {
        name: "budgeted job",
        payloadText: "do work",
        payloadTokenBudget: "120000",
      },
    });

    const { call } = await submit();

    expectNestedRecordFields(requestPayload(call), "payload", {
      kind: "agentTurn",
      tokenBudget: 120000,
    });
  });

  it("clears a stored tokenBudget with an explicit null on update", async () => {
    const { submit } = createCronSubmitHarness("job-budget-clear", {
      method: "cron.update",
      jobs: [
        createCronJob({
          id: "job-budget-clear",
          name: "job-budget-clear",
          payload: { kind: "agentTurn", message: "run", tokenBudget: 90000 },
        }),
      ],
      form: { name: "budget clear", payloadText: "do work", payloadTokenBudget: "" },
    });

    const { call } = await submit();

    expectNestedRecordFields(requestPatch(call), "payload", {
      kind: "agentTurn",
      tokenBudget: null,
    });
  });

  it("preserves an unrelated stored tokenBudget when editing other fields", async () => {
    const { submit } = createCronSubmitHarness("job-budget-keep", {
      method: "cron.update",
      jobs: [
        createCronJob({
          id: "job-budget-keep",
          name: "job-budget-keep",
          payload: { kind: "agentTurn", message: "run", tokenBudget: 250000 },
        }),
      ],
      form: { name: "budget keep", payloadText: "changed prompt", payloadTokenBudget: "250000" },
    });

    const { call } = await submit();

    expectNestedRecordFields(requestPatch(call), "payload", {
      kind: "agentTurn",
      message: "changed prompt",
      tokenBudget: 250000,
    });
  });

  it("does not submit stale announce delivery when unsupported", async () => {
    const { state, submit } = createCronSubmitHarness("job-2", {
      form: {
        name: "main job",
        everyAmount: "1",
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payloadKind: "systemEvent",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
    });

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      name: "main job",
    });
    // Delivery is explicitly sent as { mode: "none" } to clear the announce delivery on the backend.
    // Previously this was sent as undefined, which left announce in place (bug #31075).
    expect((call[1] as { delivery?: unknown } | undefined)?.delivery).toEqual({
      mode: "none",
    });
    // After submit, the form returns to the targetless internal-only default.
    expect(state.cronForm.deliveryMode).toBe("none");
  });

  it("submits cron.update when editing an existing job", async () => {
    const { state, submit } = createCronSubmitHarness("job-1", {
      method: "cron.update",
      form: {
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

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-1",
      expectedConfigRevision: "config-revision-1",
    });
    expectRecordFields(requestPatch(call), {
      name: "edited job",
      description: "",
      agentId: null,
      schedule: { kind: "cron", expr: "0 8 * * *", staggerMs: 0 },
      payload: { kind: "systemEvent", text: "updated" },
      delivery: { mode: "none" },
    });
    expect(requestPatch(call)).not.toHaveProperty("deleteAfterRun");
    expect(state.cronEditingJobId).toBe("job-1");
    expect(state.cronEditingJob?.name).toBe("Existing job");
    expect(state.cronEditingConfigRevision).toBe("config-revision-1");
  });

  it("requires a loaded config revision before form saves and toggles", async () => {
    const job = createCronJob({
      id: "job-missing-revision",
      name: "Missing revision",
      configRevision: undefined,
    });
    const request = vi.fn(async () => {
      throw new Error("unguarded mutation should not be issued");
    });
    const saveState = createStateWithRequest(request, { cronJobs: [job] });
    startCronEdit(saveState, job);
    saveState.cronForm.name = "Unsafe edit";

    await expect(addCronJob(saveState)).resolves.toEqual({ saved: false });
    expect(saveState.cronEditingJobId).toBe(job.id);
    expect(saveState.cronError).toContain("configuration revision");
    expect(request).not.toHaveBeenCalled();

    const toggleState = createStateWithRequest(request, { cronJobs: [job] });
    await expect(toggleCronJob(toggleState, job, false)).resolves.toBe(false);
    expect(toggleState.cronError).toContain("configuration revision");
    expect(request).not.toHaveBeenCalled();
  });

  it("freezes the edit revision across list refreshes and reloads the exact job after conflict", async () => {
    const staleJob = createCronJob({
      id: "job-conflict",
      name: "Loaded name",
      description: "loaded description",
      configRevision: "revision-stale",
    });
    const listedJob = {
      ...staleJob,
      name: "Listed name",
      description: "newer listed definition",
      updatedAtMs: 2,
      configRevision: "revision-current",
    };
    const authoritativeJob = {
      ...listedJob,
      name: "Authoritative name",
      description: "third writer definition",
      updatedAtMs: 3,
      configRevision: "revision-newest",
    };
    const conflict = Object.assign(new Error("cron job definition changed"), {
      name: "GatewayRequestError",
      details: {
        code: "CRON_JOB_CHANGED",
        expectedConfigRevision: "revision-stale",
        actualConfigRevision: "revision-current",
      },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "cron.update") {
        throw conflict;
      }
      if (method === "cron.list") {
        return cronJobsListResponse([listedJob]);
      }
      if (method === "cron.get") {
        return authoritativeJob;
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, { cronJobs: [staleJob] });
    startCronEdit(state, staleJob);
    state.cronForm.name = "My stale edit";
    state.cronJobs = [listedJob];

    await expect(addCronJob(state)).resolves.toEqual({ saved: false });

    expect(request).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({
        id: staleJob.id,
        expectedConfigRevision: "revision-stale",
      }),
    );
    expect(request).toHaveBeenCalledWith("cron.get", { id: staleJob.id });
    expect(state.cronEditingJobId).toBe(staleJob.id);
    expect(state.cronEditingJob).toEqual(authoritativeJob);
    expect(state.cronEditingConfigRevision).toBe("revision-newest");
    expect(state.cronJobs).toEqual([listedJob]);
    expect(state.cronForm.name).toBe("Authoritative name");
    expect(state.cronForm.description).toBe("third writer definition");
    expect(state.cronError).toContain("latest definition is loaded");
  });

  it("keeps an exact conflict refresh out of the filtered jobs cache", async () => {
    const staleJob = createCronJob({
      id: "job-filtered-conflict",
      name: "Loaded name",
      description: "loaded description",
      configRevision: "revision-stale",
    });
    const authoritativeJob = {
      ...staleJob,
      name: "Authoritative name",
      description: "latest definition",
      updatedAtMs: 2,
      configRevision: "revision-current",
    };
    const savedJob = {
      ...authoritativeJob,
      name: "Retried name",
      updatedAtMs: 3,
      configRevision: "revision-saved",
    };
    const conflict = Object.assign(new Error("cron job definition changed"), {
      details: { code: "CRON_JOB_CHANGED" },
    });
    const updateRevisions: unknown[] = [];
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.update") {
        updateRevisions.push(requireRecord(payload, "cron.update payload").expectedConfigRevision);
        if (updateRevisions.length === 1) {
          throw conflict;
        }
        return savedJob;
      }
      if (method === "cron.list") {
        return emptyCronListResponse({ snapshotRevision: "filtered-snapshot" });
      }
      if (method === "cron.get") {
        return authoritativeJob;
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, {
      cronJobs: [staleJob],
      cronJobsQuery: "missing from filtered results",
    });
    startCronEdit(state, staleJob);
    state.cronForm.name = "My stale edit";

    await expect(addCronJob(state)).resolves.toEqual({ saved: false });

    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ query: "missing from filtered results" }),
    );
    expect(request).toHaveBeenCalledWith("cron.get", { id: staleJob.id });
    expect(state.cronJobs).toEqual([]);
    expect(state.cronJobsTotal).toBe(0);
    expect(state.cronEditingJobId).toBe(authoritativeJob.id);
    expect(state.cronEditingJob).toEqual(authoritativeJob);
    expect(state.cronEditingConfigRevision).toBe("revision-current");
    expect(state.cronForm.name).toBe("Authoritative name");
    expect(state.cronForm.description).toBe("latest definition");

    state.cronForm.name = "Retried name";
    await expect(addCronJob(state)).resolves.toEqual({
      saved: true,
      jobId: authoritativeJob.id,
    });
    expect(updateRevisions).toEqual(["revision-stale", "revision-current"]);
    expect(state.cronJobs).toEqual([]);
    expect(state.cronEditingJob).toEqual(savedJob);
    expect(state.cronEditingConfigRevision).toBe("revision-saved");
  });

  it("keeps a stale form paired with its frozen revision when conflict refresh fails", async () => {
    const staleJob = createCronJob({
      id: "job-conflict-deferred",
      name: "Loaded name",
      configRevision: "revision-stale",
    });
    const listedJob = {
      ...staleJob,
      name: "Newer listed name",
      configRevision: "revision-current",
    };
    const conflict = Object.assign(new Error("cron job definition changed"), {
      details: { code: "CRON_JOB_CHANGED" },
    });
    const firstList = createDeferred<CronJobsListResult>();
    const updateRevisions: unknown[] = [];
    let listCalls = 0;
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.update") {
        updateRevisions.push(requireRecord(payload, "cron.update payload").expectedConfigRevision);
        throw conflict;
      }
      if (method === "cron.list") {
        listCalls += 1;
        return listCalls === 1 ? firstList.promise : cronJobsListResponse([listedJob]);
      }
      if (method === "cron.get") {
        throw new Error("exact job refresh unavailable");
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, { cronJobs: [staleJob] });
    startCronEdit(state, staleJob);
    state.cronForm.name = "My stale edit";

    const inFlightList = loadCronJobsPage(state, { tableFilters: true });
    await vi.waitFor(() => expect(listCalls).toBe(1));
    await expect(addCronJob(state)).resolves.toEqual({ saved: false });

    expect(state.cronForm.name).toBe("My stale edit");
    expect(state.cronEditingConfigRevision).toBe("revision-stale");
    expect(state.cronError).toContain("could not be loaded");

    firstList.resolve(cronJobsListResponse([listedJob], { snapshotRevision: "newer-list" }));
    await inFlightList;
    expect(state.cronJobs).toEqual([listedJob]);
    expect(state.cronForm.name).toBe("My stale edit");
    expect(state.cronEditingConfigRevision).toBe("revision-stale");

    await expect(addCronJob(state)).resolves.toEqual({ saved: false });
    expect(updateRevisions).toEqual(["revision-stale", "revision-stale"]);
  });

  it("commits authoritative update state before a failed jobs reconciliation", async () => {
    const loadedJob = createCronJob({
      id: "job-authoritative-save",
      name: "Loaded name",
      configRevision: "revision-loaded",
    });
    const updatedJob = {
      ...loadedJob,
      name: "Saved name",
      updatedAtMs: 2,
      configRevision: "revision-saved",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "cron.update") {
        return updatedJob;
      }
      if (method === "cron.list") {
        throw new Error("reconciliation unavailable");
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, { cronJobs: [loadedJob] });
    startCronEdit(state, loadedJob);
    state.cronForm.name = "Saved name";

    await expect(addCronJob(state)).resolves.toEqual({
      saved: true,
      jobId: loadedJob.id,
    });

    expect(state.cronJobs).toEqual([updatedJob]);
    expect(state.cronEditingJob).toEqual(updatedJob);
    expect(state.cronEditingConfigRevision).toBe("revision-saved");
  });

  it("commits authoritative toggle state and advances an open editor revision", async () => {
    const loadedJob = createCronJob({
      id: "job-authoritative-toggle",
      name: "Toggle job",
      enabled: true,
      configRevision: "revision-loaded",
    });
    const updatedJob = {
      ...loadedJob,
      enabled: false,
      updatedAtMs: 2,
      configRevision: "revision-toggled",
    };
    const listResponse = createDeferred<CronJobsListResult>();
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return updatedJob;
      }
      if (method === "cron.list") {
        return listResponse.promise;
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, { cronJobs: [loadedJob] });
    startCronEdit(state, loadedJob);
    state.cronForm.name = "Unsaved rename";

    const toggle = toggleCronJob(state, loadedJob, false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.list", expect.anything()));

    expect(request).toHaveBeenCalledWith("cron.update", {
      id: loadedJob.id,
      expectedConfigRevision: "revision-loaded",
      patch: { enabled: false },
    });
    expect(state.cronJobs).toEqual([updatedJob]);
    expect(state.cronEditingJob).toEqual(updatedJob);
    expect(state.cronEditingConfigRevision).toBe("revision-toggled");
    expect(state.cronForm.name).toBe("Unsaved rename");

    listResponse.resolve(cronJobsListResponse([updatedJob]));
    await expect(toggle).resolves.toBe(true);

    await addCronJob(state);
    const updateCalls = request.mock.calls.filter(([method]) => method === "cron.update");
    expect(updateCalls[1]?.[1]).toEqual(
      expect.objectContaining({
        expectedConfigRevision: "revision-toggled",
        patch: expect.objectContaining({ name: "Unsaved rename" }),
      }),
    );
  });

  it("removes confirmed jobs locally before a failed reconciliation", async () => {
    const removedJob = createCronJob({ id: "job-remove-local", name: "Remove locally" });
    const remainingJob = createCronJob({ id: "job-remaining", name: "Keep locally" });
    const request = vi.fn(async (method: string) => {
      if (method === "cron.remove") {
        return { ok: true, removed: true };
      }
      if (method === "cron.list") {
        throw new Error("reconciliation unavailable");
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, {
      cronJobs: [removedJob, remainingJob],
      cronJobsTotal: 2,
      cronRunsJobId: removedJob.id,
      cronRuns: [{ ts: 1, jobId: removedJob.id, action: "finished", status: "ok" }],
      cronRunsTotal: 1,
    });
    startCronEdit(state, removedJob);

    await removeCronJob(state, removedJob);

    expect(state.cronJobs).toEqual([remainingJob]);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronEditingJob).toBeNull();
    expect(state.cronRunsJobId).toBeNull();
    expect(state.cronRuns).toEqual([]);
  });

  it("sends null delivery.accountId in cron.update to clear persisted account routing", async () => {
    const job = createCronJob({
      id: "job-clear-account-id",
      name: "clear account",
      delivery: { mode: "announce", accountId: "ops-bot" },
    });
    const { submit } = createCronSubmitHarness(job.id, {
      method: "cron.update",
      jobs: [job],
      form: {
        name: "clear account",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        wakeMode: "next-heartbeat",
        payloadText: "run",
        deliveryMode: "announce",
        deliveryAccountId: "   ",
      },
    });

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-clear-account-id",
    });
    expectRecordFields(requireRecord(requestPatch(call).delivery, "delivery"), {
      mode: "announce",
      accountId: null,
    });
  });

  it("sends null delivery.to in cron.update to clear a persisted destination", async () => {
    const job = createCronJob({
      id: "job-clear-to",
      name: "clear to",
      delivery: { mode: "announce", channel: "telegram", to: "12345" },
    });
    const { submit } = createCronSubmitHarness(job.id, {
      method: "cron.update",
      jobs: [job],
      form: {
        name: "clear to",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        wakeMode: "next-heartbeat",
        payloadText: "run",
        deliveryMode: "announce",
        deliveryTo: "   ",
      },
    });

    const { call } = await submit();

    expectRecordFields(requireRecord(requestPatch(call).delivery, "delivery"), {
      mode: "announce",
      to: null,
    });
  });

  it("maps a cron job into editable form fields", () => {
    const state = createState();
    const job = createCronJob({
      id: "job-9",
      name: "Weekly report",
      description: "desc",
      sessionKey: "agent:ops:main",
      enabled: false,
      schedule: { kind: "every", everyMs: 7_200_000 },
      payload: { kind: "agentTurn", message: "ship it", timeoutSeconds: 45 },
      delivery: { mode: "announce", channel: "telegram", to: "123", accountId: "bot-2" },
    });

    startCronEdit(state, job);

    expect(state.cronEditingJobId).toBe("job-9");
    expect(state.cronEditingJob).toEqual(job);
    expect(state.cronEditingConfigRevision).toBe("config-revision-1");
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

  it("preserves an explicit zero timeout when opening an existing job", () => {
    const state = createState();
    const job = createCronJob({
      id: "no-timeout-job",
      name: "No timeout",
      schedule: { kind: "every", everyMs: 60_000 },
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Run until complete", timeoutSeconds: 0 },
    });

    startCronEdit(state, job);

    expect(state.cronForm.timeoutSeconds).toBe("0");
  });

  it("preserves command payloads when editing Control UI metadata", async () => {
    const job = createCronJob({
      id: "job-command",
      name: "Command",
      schedule: { kind: "every", everyMs: 600_000 },
      payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    });
    const { state, submit } = createCronEditHarness(job);

    state.cronForm.name = "Command renamed";
    const call = await submit();

    const patch = requestPatch(call);
    expect(patch.name).toBe("Command renamed");
    expect(patch).not.toHaveProperty("payload");
  });

  it("loads and preserves script payloads as read-only metadata edits", async () => {
    const script = "const result = await agent('check status')";
    const scriptJob = createCronJob({
      id: "job-script",
      name: "Script",
      schedule: { kind: "every", everyMs: 600_000 },
      payload: {
        kind: "script",
        script,
        toolBudget: 4,
      },
      delivery: { mode: "none" },
    });
    const request = createMethodRequest({
      "cron.list": cronJobsListResponse([scriptJob]),
      "cron.update": { id: scriptJob.id },
      "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
    });
    const state = createStateWithRequest(request);

    await loadCronJobsPage(state);
    expect(state.cronJobs).toEqual([scriptJob]);

    startCronEdit(state, scriptJob);
    expect(state.cronForm.payloadKind).toBe("script");
    expect(state.cronForm.payloadLocked).toBe(true);
    expect(state.cronForm.payloadText).toBe(script);

    state.cronForm.name = "Script renamed";
    await addCronJob(state);

    const patch = requestPatch(findRequestCall(request.mock.calls, "cron.update"));
    expect(patch.name).toBe("Script renamed");
    expect(patch).not.toHaveProperty("payload");
  });

  it("preserves on-exit schedules when editing Control UI metadata", async () => {
    const job = createCronJob({
      id: "job-on-exit",
      name: "On exit",
      schedule: { kind: "on-exit", command: "make build", cwd: "/repo" },
      payload: { kind: "agentTurn", message: "report" },
      delivery: { mode: "none" },
    });
    const { state, submit } = createCronEditHarness(job);

    state.cronForm.name = "On exit renamed";
    state.cronForm.cronExpr = "";
    const call = await submit();

    const patch = requestPatch(call);
    expect(patch.name).toBe("On exit renamed");
    expect(patch).not.toHaveProperty("schedule");
    expect(state.cronFieldErrors).toEqual({});
  });

  it("preserves stream schedules when editing Control UI metadata", async () => {
    const job = createCronJob({
      id: "job-stream",
      name: "Stream",
      schedule: { kind: "stream", command: ["node", "events.mjs"] },
      payload: { kind: "agentTurn", message: "report" },
      delivery: { mode: "none" },
    });
    const { state, submit } = createCronEditHarness(job);

    state.cronForm.name = "Stream renamed";
    const call = await submit();

    const patch = requestPatch(call);
    expect(patch.name).toBe("Stream renamed");
    expect(patch).not.toHaveProperty("schedule");
    expect(state.cronFieldErrors).toEqual({});
  });

  it.each([
    {
      name: "anchored interval",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_725_000_000_123 },
    },
    {
      name: "subsecond cron stagger",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 1_234 },
    },
  ] as const)("preserves the exact $name schedule on metadata-only edits", async ({ schedule }) => {
    const job = createCronJob({ id: "job-exact-schedule", name: "Exact schedule", schedule });
    const { state, submit } = createCronEditHarness(job);
    state.cronForm.description = "metadata only";

    expect(requestPatch(await submit())).not.toHaveProperty("schedule");
  });

  it("preserves configured duration precision when editing a staggered cron expression", async () => {
    const job = createCronJob({
      id: "job-exact-stagger",
      name: "Exact stagger",
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 1_001 },
    });
    const { state, submit } = createCronEditHarness(job);
    const displayedAmount = state.cronForm.staggerAmount;
    state.cronForm.cronExpr = "*/5 * * * *";

    const call = await submit();

    expect({ displayedAmount, schedule: requestPatch(call).schedule }).toEqual({
      displayedAmount: "1.001",
      schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 1_001 },
    });
    expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
  });

  it.each([
    { staggerAmount: "1.001", staggerUnit: "seconds", staggerMs: 1_001 },
    { staggerAmount: "4.1", staggerUnit: "minutes", staggerMs: 246_000 },
    { staggerAmount: "1e3", staggerUnit: "seconds", staggerMs: 1_000_000 },
    { staggerAmount: "0x10", staggerUnit: "seconds", staggerMs: 16_000 },
    { staggerAmount: "0b10", staggerUnit: "seconds", staggerMs: 2_000 },
    { staggerAmount: "0o10", staggerUnit: "seconds", staggerMs: 8_000 },
    { staggerAmount: "+1", staggerUnit: "seconds", staggerMs: 1_000 },
  ] as const)(
    "preserves configured duration precision for $staggerAmount $staggerUnit stagger",
    async ({ staggerAmount, staggerUnit, staggerMs }) => {
      const { submit } = createCronSubmitHarness("job-decimal-stagger", {
        form: {
          name: "Decimal stagger",
          scheduleKind: "cron",
          cronExpr: "0 * * * *",
          staggerAmount,
          staggerUnit,
          payloadText: "run",
        },
      });

      const { call, result } = await submit();

      expect(result.saved).toBe(true);
      expect(requestPayload(call).schedule).toEqual({ kind: "cron", expr: "0 * * * *", staggerMs });
      expect(validateCronAddParams(requestPayload(call))).toBe(true);
    },
  );

  it("rejects stagger fractions below configured duration precision before the RPC", async () => {
    const { state, request } = createCronSubmitHarness("job-submillisecond-stagger", {
      form: {
        name: "Submillisecond stagger",
        scheduleKind: "cron",
        staggerAmount: "0.0001",
        staggerUnit: "seconds",
        payloadText: "run",
      },
    });

    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.staggerAmount).toBe("cron.errors.staggerAmountInvalid");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { scheduleKind: "every", amount: "8640000000000", valid: true },
    { scheduleKind: "every", amount: "8640000000000.001", valid: false },
    { scheduleKind: "cron", amount: "8640000000000", valid: true },
    { scheduleKind: "cron", amount: "8640000000000.001", valid: false },
  ] as const)(
    "bounds configured duration precision for $scheduleKind at $amount seconds",
    async ({ scheduleKind, amount, valid }) => {
      const { state, request } = createCronSubmitHarness("job-duration-boundary", {
        form: {
          name: "Duration boundary",
          scheduleKind,
          everyAmount: amount,
          everyUnit: "seconds",
          cronExpr: "0 * * * *",
          staggerAmount: amount,
          staggerUnit: "seconds",
          payloadText: "run",
        },
      });

      expect((await addCronJob(state)).saved).toBe(valid);
      if (valid) {
        const payload = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
        expect(payload.schedule).toEqual(
          scheduleKind === "every"
            ? { kind: "every", everyMs: 8_640_000_000_000_000 }
            : { kind: "cron", expr: "0 * * * *", staggerMs: 8_640_000_000_000_000 },
        );
        expect(validateCronAddParams(payload)).toBe(true);
      } else {
        expect(state.cronFieldErrors).toHaveProperty(
          scheduleKind === "every" ? "everyAmount" : "staggerAmount",
        );
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it("applies schedule edits when changing an on-exit job to a regular schedule", async () => {
    const job = createCronJob({
      id: "job-on-exit",
      name: "On exit",
      schedule: { kind: "on-exit", command: "make build", cwd: "/repo" },
      payload: { kind: "agentTurn", message: "report" },
      delivery: { mode: "none" },
    });
    const { state, submit } = createCronEditHarness(job);

    state.cronForm.scheduleKind = "every";
    state.cronForm.everyAmount = "5";
    state.cronForm.everyUnit = "minutes";
    const call = await submit();

    const patch = requestPatch(call);
    expect(patch.schedule).toEqual({ kind: "every", everyMs: 300_000 });
  });

  it('keeps implicit announce delivery implicit when editing a job that shows "last" in the form', async () => {
    const job = createCronJob({
      id: "job-implicit-delivery",
      name: "Implicit delivery",
      delivery: { mode: "announce", to: "123" },
    });
    const { submit } = createCronEditHarness(job);

    const call = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-implicit-delivery",
    });
    expectRecordFields(requireRecord(requestPatch(call).delivery, "delivery"), {
      mode: "announce",
      to: "123",
    });
    expect(
      (call[1] as { patch?: { delivery?: { channel?: string } } } | undefined)?.patch?.delivery
        ?.channel,
    ).toBeUndefined();
  });

  it('sends delivery.channel="last" when editing clears an explicit channel back to implicit-last', async () => {
    const job = createCronJob({
      id: "job-clear-delivery-channel",
      name: "Clear delivery channel",
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    });
    const { state, submit } = createCronEditHarness(job);

    state.cronForm.deliveryChannel = "last";
    const call = await submit();

    expect(
      (call[1] as { patch?: { delivery?: { channel?: string } } } | undefined)?.patch?.delivery
        ?.channel,
    ).toBe("last");
  });

  it("includes trigger/model/thinking/stagger/bestEffort in cron.update patch", async () => {
    const { submit } = createCronSubmitHarness("job-2", {
      method: "cron.update",
      form: {
        name: "advanced edit",
        scheduleKind: "cron",
        cronExpr: "0 9 * * *",
        staggerAmount: "30",
        staggerUnit: "seconds",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
        triggerOnce: true,
        payloadKind: "agentTurn",
        payloadText: "run it",
        payloadModel: "opus",
        payloadThinking: "low",
        deliveryMode: "announce",
        deliveryBestEffort: true,
      },
    });

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-2",
    });
    const patch = requestPatch(call);
    expectRecordFields(patch, {
      schedule: { kind: "cron", expr: "0 9 * * *", staggerMs: 30_000 },
      trigger: { script: "json({ fire: true })", once: true },
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

  it.each(["cron.add", "cron.update"] as const)(
    "preserves the trigger draft and inventory when %s rejects its syntax",
    async (method) => {
      const existingJob = createCronJob({
        id: "job-condition-syntax",
        name: "Conditional job",
        trigger: { script: "return { fire: true }" },
      });
      const { request, state } = createCronSubmitHarness(existingJob.id, {
        method,
        jobs: [existingJob],
        state: { cronCreateOpen: method === "cron.add" },
        form: {
          name: "Conditional job",
          scheduleKind: "every",
          everyAmount: "1",
          everyUnit: "minutes",
          payloadText: "run",
          triggerEnabled: true,
          triggerScript: "const x = ;",
        },
      });
      const originalInventory = structuredClone(state.cronJobs);
      const message =
        "cron trigger script has a syntax error: Unexpected token (line 1, column 10)";
      request.mockRejectedValue(new Error(message));

      await expect(addCronJob(state)).resolves.toEqual({ saved: false });

      expect(state.cronError).toBe(message);
      expect(state.cronForm.triggerScript).toBe("const x = ;");
      expect(state.cronJobs).toEqual(originalInventory);
      expect(state.cronCreateOpen).toBe(method === "cron.add");
      if (method === "cron.update") {
        expect(state.cronEditingJobId).toBe(existingJob.id);
        expect(state.cronEditingJob?.trigger).toEqual(existingJob.trigger);
      }
    },
  );

  it("clears an existing condition trigger from cron.update", async () => {
    const job = createCronJob({
      id: "job-clear-trigger",
      name: "Conditional job",
      trigger: { script: "json({ fire: true })", once: true },
    });
    const { state, submit } = createCronEditHarness(job);
    state.cronForm.triggerEnabled = false;

    const call = await submit();

    expect(requestPatch(call).trigger).toBeNull();
  });

  it("requires an explicit clear before saving an existing script payload with a condition trigger", async () => {
    const job = createCronJob({
      id: "job-script-trigger-conflict",
      name: "Conflicting script",
      schedule: { kind: "every", everyMs: 30_000 },
      payload: { kind: "script", script: "json({ state: {} })" },
      trigger: { script: "json({ fire: true })" },
      delivery: { mode: "none" },
    });
    const { request, state, submit } = createCronEditHarness(job);

    expect(state.cronForm.triggerEnabled).toBe(true);
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.triggerScript).toBe("cron.errors.triggerScriptPayloadUnsupported");
    expect(request).not.toHaveBeenCalled();

    state.cronForm.triggerEnabled = false;
    const call = await submit();

    expect(requestPatch(call).trigger).toBeNull();
    expect(requestPatch(call)).not.toHaveProperty("payload");
  });

  it.each(["agentTurn", "systemEvent", "command"] as const)(
    "preserves condition-trigger authoring for %s payloads",
    (payloadKind) => {
      expect(
        validateCronForm({
          ...DEFAULT_CRON_FORM,
          name: "Supported conditional automation",
          payloadKind,
          payloadLocked: payloadKind === "command",
          payloadText: "run",
          triggerEnabled: true,
          triggerScript: "json({ fire: true })",
        }).triggerScript,
      ).toBeUndefined();
    },
  );

  it("revalidates condition triggers when the payload changes to or from script", () => {
    const form = {
      ...DEFAULT_CRON_FORM,
      name: "Payload transition",
      payloadText: "run",
      triggerEnabled: true,
      triggerScript: "json({ fire: true })",
    };

    expect(validateCronForm({ ...form, payloadKind: "script", payloadLocked: true })).toMatchObject(
      {
        triggerScript: "cron.errors.triggerScriptPayloadUnsupported",
      },
    );
    expect(validateCronForm({ ...form, payloadKind: "agentTurn" }).triggerScript).toBeUndefined();
  });

  it("sends lightContext=false in cron.update when clearing prior light-context setting", async () => {
    const job = createCronJob({
      id: "job-clear-light",
      name: "Light job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run", lightContext: true },
    });
    const { submit } = createCronSubmitHarness(job.id, {
      method: "cron.update",
      jobs: [job],
      form: {
        name: "Light job",
        scheduleKind: "cron",
        cronExpr: "0 9 * * *",
        payloadKind: "agentTurn",
        payloadText: "run",
        payloadLightContext: false,
      },
    });

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-clear-light",
    });
    expectRecordFields(requireRecord(requestPatch(call).payload, "payload"), {
      kind: "agentTurn",
      lightContext: false,
    });
  });

  it("includes custom failureAlert fields in cron.update patch", async () => {
    const { submit } = createCronSubmitHarness("job-alert", {
      method: "cron.update",
      form: {
        name: "alert job",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertDeliveryMode: "announce",
        failureAlertAfter: "3",
        failureAlertCooldownSeconds: "120",
        failureAlertChannel: "telegram",
        failureAlertTo: "123456",
      },
    });

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-alert",
    });
    expectRecordFields(requireRecord(requestPatch(call).failureAlert, "failureAlert"), {
      after: 3,
      cooldownMs: 120_000,
      channel: "telegram",
      to: "123456",
      mode: "announce",
      accountId: undefined,
    });
  });

  it("includes failure alert mode/accountId in cron.update patch", async () => {
    const { submit } = createCronSubmitHarness("job-alert-mode", {
      method: "cron.update",
      form: {
        name: "alert mode job",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "1",
        failureAlertDeliveryMode: "webhook",
        failureAlertAccountId: "bot-a",
      },
    });

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-alert-mode",
    });
    expectRecordFields(requireRecord(requestPatch(call).failureAlert, "failureAlert"), {
      after: 1,
      mode: "webhook",
      accountId: "bot-a",
    });
  });

  it('keeps implicit failure alert delivery implicit when editing a job that shows "last" in the form', async () => {
    const job = createCronJob({
      id: "job-alert-implicit-channel",
      name: "Implicit failure alert",
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      failureAlert: { after: 2, to: "123" },
    });
    const { submit } = createCronEditHarness(job);

    const call = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-alert-implicit-channel",
    });
    expectRecordFields(requireRecord(requestPatch(call).failureAlert, "failureAlert"), {
      after: 2,
      to: "123",
      mode: undefined,
    });
    expect(
      (call[1] as { patch?: { failureAlert?: { channel?: string } } } | undefined)?.patch
        ?.failureAlert?.channel,
    ).toBeUndefined();
  });

  it('sends failureAlert.channel="last" when editing clears an explicit failure channel back to implicit-last', async () => {
    const job = createCronJob({
      id: "job-clear-failure-channel",
      name: "Clear failure channel",
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      failureAlert: { after: 2, channel: "telegram", to: "123" },
    });
    const { state, submit } = createCronEditHarness(job);

    state.cronForm.failureAlertChannel = "last";
    const call = await submit();

    expect(
      (call[1] as { patch?: { failureAlert?: { channel?: string } } } | undefined)?.patch
        ?.failureAlert?.channel,
    ).toBe("last");
  });

  it("omits failureAlert.cooldownMs when custom cooldown is left blank", async () => {
    const { submit } = createCronSubmitHarness("job-alert-no-cooldown", {
      method: "cron.update",
      form: {
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

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-alert-no-cooldown",
    });
    expectRecordFields(requireRecord(requestPatch(call).failureAlert, "failureAlert"), {
      after: 3,
      channel: "telegram",
      to: "123456",
    });
    expect(
      (call[1] as { patch?: { failureAlert?: { cooldownMs?: number } } })?.patch?.failureAlert,
    ).not.toHaveProperty("cooldownMs");
  });

  it("clears persisted failure alert routing fields when their edit inputs are blanked", async () => {
    const job = createCronJob({
      id: "job-clear-alert-fields",
      name: "Clear failure alert fields",
      delivery: { mode: "announce" },
      failureAlert: {
        after: 2,
        channel: "telegram",
        to: "123456",
        cooldownMs: 60_000,
        accountId: "bot-a",
      },
    });
    const { state, submit } = createCronEditHarness(job);

    state.cronForm.failureAlertAfter = "";
    state.cronForm.failureAlertTo = "";
    state.cronForm.failureAlertCooldownSeconds = "";
    state.cronForm.failureAlertAccountId = "";
    const call = await submit();

    expectRecordFields(requireRecord(requestPatch(call).failureAlert, "failureAlert"), {
      after: null,
      to: null,
      cooldownMs: null,
      accountId: null,
    });
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify the websocket JSON wire shape
    const serializedPayload = JSON.parse(JSON.stringify(requestPayload(call))) as unknown;
    expectRecordFields(
      requireRecord(
        requireRecord(requireRecord(serializedPayload, "payload").patch, "patch").failureAlert,
        "failureAlert",
      ),
      { after: null, to: null, cooldownMs: null, accountId: null },
    );
  });

  it("clears a persisted failure alert override when switching back to inherit", async () => {
    const request = createMethodRequest({ "cron.update": { id: "job-inherit-alert" } });
    const job = createCronJob({
      id: "job-inherit-alert",
      name: "Inherit failure alerts",
      failureAlert: { after: 2, channel: "telegram" },
    });
    const state = createStateWithRequest(request, {
      cronJobs: [job],
    });

    startCronEdit(state, job);
    state.cronForm.failureAlertMode = "inherit";
    await addCronJob(state);

    const updateCall = findRequestCall(request.mock.calls, "cron.update");
    expect(requestPatch(updateCall).failureAlert).toBeNull();
  });

  it("includes failureAlert=false when disabled per job", async () => {
    const { submit } = createCronSubmitHarness("job-no-alert", {
      method: "cron.update",
      form: {
        name: "alert off",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "disabled",
      },
    });

    const { call } = await submit();

    expectRecordFields(requestPayload(call), {
      id: "job-no-alert",
    });
    expect(requestPatch(call).failureAlert).toBe(false);
  });

  it("maps cron trigger, stagger, model, thinking, and best effort into form", () => {
    const state = createState();
    const job = createCronJob({
      id: "job-10",
      name: "Advanced job",
      deleteAfterRun: true,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC", staggerMs: 60_000 },
      trigger: { script: "json({ fire: true })", once: true },
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        model: "opus",
        thinking: "high",
        tokenBudget: 250000,
      },
      delivery: { mode: "announce", bestEffort: true },
    });
    startCronEdit(state, job);

    expect(state.cronForm.deleteAfterRun).toBe(true);
    expect(state.cronForm.scheduleKind).toBe("cron");
    expect(state.cronForm.scheduleExact).toBe(false);
    expect(state.cronForm.staggerAmount).toBe("1");
    expect(state.cronForm.staggerUnit).toBe("minutes");
    expect(state.cronForm.triggerEnabled).toBe(true);
    expect(state.cronForm.triggerScript).toBe("json({ fire: true })");
    expect(state.cronForm.triggerOnce).toBe(true);
    expect(state.cronForm.payloadModel).toBe("opus");
    expect(state.cronForm.payloadThinking).toBe("high");
    expect(state.cronForm.payloadTokenBudget).toBe("250000");
    expect(state.cronForm.deliveryBestEffort).toBe(true);
  });

  it("maps failureAlert overrides into form fields", () => {
    const state = createState();
    const job = createCronJob({
      id: "job-11",
      name: "Failure alerts",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "hello" },
      failureAlert: {
        after: 4,
        cooldownMs: 30_000,
        channel: "telegram",
        to: "999",
      },
    });

    startCronEdit(state, job);

    expect(state.cronForm.failureAlertMode).toBe("custom");
    expect(state.cronForm.failureAlertAfter).toBe("4");
    expect(state.cronForm.failureAlertCooldownSeconds).toBe("30");
    expect(state.cronForm.failureAlertChannel).toBe("telegram");
    expect(state.cronForm.failureAlertTo).toBe("999");
    expect(state.cronForm.failureAlertDeliveryMode).toBe("");
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
      timeoutSeconds: "-1",
      payloadTokenBudget: "0",
      triggerEnabled: true,
      triggerScript: "",
      deliveryMode: "webhook",
      deliveryTo: "ftp://bad",
    });
    expect(errors.name).toBe("cron.errors.nameRequired");
    expect(errors.cronExpr).toBe("cron.errors.cronExprRequired");
    expect(errors.payloadText).toBe("cron.errors.agentMessageRequired");
    expect(errors.triggerScript).toBe("cron.errors.triggerScriptRequired");
    expect(errors.timeoutSeconds).toBe("cron.errors.timeoutInvalid");
    expect(errors.payloadTokenBudget).toBe("cron.errors.tokenBudgetInvalid");
    expect(errors.deliveryTo).toBe("cron.errors.webhookUrlInvalid");
  });

  it.each(["0", " 0 ", "0.25", "", "   "])(
    "accepts non-negative and inherited agent-turn timeouts: %j",
    (timeoutSeconds) => {
      const errors = validateCronForm({
        ...DEFAULT_CRON_FORM,
        name: "Valid timeout",
        payloadText: "Run until complete",
        timeoutSeconds,
      });

      expect(errors.timeoutSeconds).toBeUndefined();
    },
  );

  it.each(["-1", "-0.25", "NaN", "Infinity", "not-a-number"])(
    "rejects invalid agent-turn timeouts: %j",
    (timeoutSeconds) => {
      const errors = validateCronForm({
        ...DEFAULT_CRON_FORM,
        name: "Invalid timeout",
        payloadText: "Run until complete",
        timeoutSeconds,
      });

      expect(errors.timeoutSeconds).toBe("cron.errors.timeoutInvalid");
    },
  );

  it.each(["120000", " 250 ", "1"])(
    "accepts positive whole-number agent-turn token budgets: %j",
    (payloadTokenBudget) => {
      const errors = validateCronForm({
        ...DEFAULT_CRON_FORM,
        name: "Valid budget",
        payloadText: "Run until complete",
        payloadTokenBudget,
      });

      expect(errors.payloadTokenBudget).toBeUndefined();
    },
  );

  it.each(["", "   "])(
    "treats blank agent-turn token budget as unlimited: %j",
    (payloadTokenBudget) => {
      const errors = validateCronForm({
        ...DEFAULT_CRON_FORM,
        name: "Blank budget",
        payloadText: "Run until complete",
        payloadTokenBudget,
      });

      expect(errors.payloadTokenBudget).toBeUndefined();
    },
  );

  it.each(["0", "-1", "2.5", "NaN", "Infinity", "not-a-number"])(
    "rejects invalid agent-turn token budgets: %j",
    (payloadTokenBudget) => {
      const errors = validateCronForm({
        ...DEFAULT_CRON_FORM,
        name: "Invalid budget",
        payloadText: "Run until complete",
        payloadTokenBudget,
      });

      expect(errors.payloadTokenBudget).toBe("cron.errors.tokenBudgetInvalid");
    },
  );

  it.each(["0x10", "1e3", "+1", String(Number.MAX_SAFE_INTEGER), "0.000001"])(
    "rejects invalid recurring amounts before submit: %s",
    async (everyAmount) => {
      const request = createCronRequest("job-nondecimal");
      const state = createStateWithRequest(request, {
        cronForm: {
          ...DEFAULT_CRON_FORM,
          name: "decimal interval",
          everyAmount,
          payloadText: "run",
          deliveryMode: "none",
        },
      });

      const saved = await addCronJob(state);

      expect(saved.saved).toBe(false);
      expect(state.cronFieldErrors.everyAmount).toBe("cron.errors.everyAmountInvalid");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["5", "seconds"],
    ["29.999", "seconds"],
    ["0.49", "minutes"],
  ] as const)(
    "rejects a condition-triggered interval below the Gateway minimum: %s %s",
    async (everyAmount, everyUnit) => {
      const request = createCronRequest("job-trigger-too-fast");
      const state = createStateWithRequest(request, {
        cronForm: {
          ...DEFAULT_CRON_FORM,
          name: "Conditional automation",
          everyAmount,
          everyUnit,
          payloadText: "run",
          triggerEnabled: true,
          triggerScript: "json({ fire: true })",
          deliveryMode: "none",
        },
      });

      expect(await addCronJob(state)).toEqual({ saved: false });
      expect(state.cronFieldErrors.everyAmount).toBe("cron.errors.triggerIntervalTooShort");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["30", "seconds"],
    ["0.5", "minutes"],
  ] as const)(
    "accepts a condition-triggered interval at the Gateway minimum: %s %s",
    async (everyAmount, everyUnit) => {
      const { submit } = createCronSubmitHarness("job-trigger-boundary", {
        form: {
          name: "Boundary automation",
          everyAmount,
          everyUnit,
          payloadText: "run",
          triggerEnabled: true,
          triggerScript: "json({ fire: true })",
          deliveryMode: "none",
        },
      });

      const { call, result } = await submit();

      expect(result.saved).toBe(true);
      expect(requestPayload(call).schedule).toEqual({ kind: "every", everyMs: 30_000 });
    },
  );

  it("blocks adding a condition trigger to an existing short-interval automation", async () => {
    const job = createCronJob({
      id: "job-existing-short",
      name: "Existing short interval",
      schedule: { kind: "every", everyMs: 5_000 },
    });
    const { request, state } = createCronEditHarness(job);
    state.cronForm.triggerEnabled = true;
    state.cronForm.triggerScript = "json({ fire: true })";

    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.everyAmount).toBe("cron.errors.triggerIntervalTooShort");
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks shortening an existing condition-triggered automation below the minimum", async () => {
    const job = createCronJob({
      id: "job-shorten-triggered",
      name: "Existing conditional automation",
      schedule: { kind: "every", everyMs: 30_000 },
      trigger: { script: "json({ fire: true })" },
    });
    const { request, state } = createCronEditHarness(job);
    state.cronForm.everyAmount = "5";

    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.everyAmount).toBe("cron.errors.triggerIntervalTooShort");
    expect(request).not.toHaveBeenCalled();
  });

  it("allows a short interval again when removing an existing condition trigger", async () => {
    const job = createCronJob({
      id: "job-remove-short-trigger",
      name: "Previously conditional automation",
      schedule: { kind: "every", everyMs: 30_000 },
      trigger: { script: "json({ fire: true })" },
    });
    const { state, submit } = createCronEditHarness(job);
    state.cronForm.everyAmount = "5";
    state.cronForm.triggerEnabled = false;

    const call = await submit();

    expect(requestPatch(call)).toMatchObject({
      schedule: { kind: "every", everyMs: 5_000 },
      trigger: null,
    });
  });

  it.each([
    ["1.5", "minutes", 90_000],
    ["4.1", "minutes", 246_000],
    ["0.1", "hours", 360_000],
    ["0.000125", "hours", 450],
    ["0.1", "days", 8_640_000],
    ["0.0009765625", "days", 84_375],
  ] as const)(
    "converts %s %s to safe integer milliseconds",
    async (everyAmount, everyUnit, expectedEveryMs) => {
      const { submit } = createCronSubmitHarness("job-decimal", {
        form: {
          name: "decimal interval",
          everyAmount,
          everyUnit,
          payloadText: "run",
          deliveryMode: "none",
        },
      });

      const submitted = await submit();

      expect(submitted.result.saved).toBe(true);
      expect(requestPayload(submitted.call).schedule).toEqual({
        kind: "every",
        everyMs: expectedEveryMs,
      });
    },
  );

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
    const state = createStateWithRequest(request, {
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

  it.each([
    {
      scenario: "an all-agent filter with a selected owner",
      cronAgentId: null,
      selectedAgentId: "writer",
    },
    { scenario: "the default agent", cronAgentId: "main", selectedAgentId: "main" },
    { scenario: "a selected agent", cronAgentId: "writer", selectedAgentId: "writer" },
  ])("canceling edit resets form for $scenario and clears edit mode", (scenario) => {
    const state = createState({ cronAgentId: scenario.cronAgentId });
    const job = createCronJob({
      id: "job-cancel",
      name: "Editable",
      schedule: { kind: "cron", expr: "0 6 * * *" },
      wakeMode: "now",
      delivery: { mode: "announce", to: "123" },
    });
    startCronEdit(state, job);
    state.cronForm.name = "changed";
    state.cronFieldErrors = { name: "Name is required." };

    cancelCronEdit(state, scenario.selectedAgentId);

    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronEditingJob).toBeNull();
    expect(state.cronEditingConfigRevision).toBeNull();
    expect(state.cronForm).toEqual({
      ...DEFAULT_CRON_FORM,
      agentId: scenario.selectedAgentId,
    });
    // Fresh forms start visually clean; validation re-arms on change/submit.
    expect(state.cronFieldErrors).toEqual({});
  });

  it("cloning a job switches to create mode and applies copy naming", () => {
    const state = createState({
      cronJobs: [
        createCronJob({
          id: "job-1",
          name: "Daily ping",
          schedule: { kind: "cron", expr: "0 9 * * *" },
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "ping" },
        }),
      ],
    });

    const sourceJob = state.cronJobs[0];
    if (!sourceJob) {
      throw new Error("Expected source cron job");
    }
    startCronEdit(state, sourceJob);
    startCronClone(state, sourceJob);

    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronEditingJob).toBeNull();
    expect(state.cronEditingConfigRevision).toBeNull();
    expect(state.cronRunsJobId).toBe("job-1");
    expect(state.cronForm.name).toBe("Daily ping copy");
    expect(state.cronForm.payloadText).toBe("ping");
  });

  it("submits cron.add after cloning", async () => {
    const request = createCronRequest("job-new");
    const sourceJob = createCronJob({
      id: "job-1",
      name: "Daily ping",
      agentId: "writer",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    });
    const state = createStateWithRequest(request, {
      cronJobs: [sourceJob],
      cronAgentId: "main",
    });

    startCronEdit(state, sourceJob);
    startCronClone(state, sourceJob);
    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeUndefined();
    expect(addCall[1]).toEqual(
      expect.objectContaining({ name: "Daily ping copy", agentId: "writer" }),
    );
  });

  it.each([
    { name: "omitted cap", policy: {} },
    { name: "empty cap", policy: { toolsAllow: [] } },
    { name: "finite cap", policy: { toolsAllow: ["read"] } },
    { name: "wildcard cap", policy: { toolsAllow: ["*"] }, effectiveUnrestricted: true },
    {
      name: "default-marked cap as a new explicit restriction",
      policy: { toolsAllow: ["read"], toolsAllowIsDefault: true },
    },
  ] satisfies Array<{
    name: string;
    effectiveUnrestricted?: boolean;
    policy: Pick<
      Extract<CronJob["payload"], { kind: "agentTurn" }>,
      "toolsAllow" | "toolsAllowIsDefault"
    >;
  }>)("clone payload policy: retains $name without a capture marker", async (scenario) => {
    const { policy } = scenario;
    const source = createCronJob({
      id: "cap-source",
      name: "Public cap source",
      payload: { kind: "agentTurn", message: "Synthetic clone task", ...policy },
      delivery: { mode: "none" },
    });
    const original = structuredClone(source);
    const request = createCronRequest("cap-clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });

    startCronClone(state, source);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "cap-clone" });

    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    const payload = requireRecord(submitted.payload, "cloned payload");
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
    expect(payload).not.toHaveProperty("toolsAllowIsDefault");
    if ("effectiveUnrestricted" in scenario) {
      // Fresh trusted creation defaults an omitted cap to wildcard.
      expect(payload.toolsAllow ?? ["*"]).toEqual(["*"]);
    } else if ("toolsAllow" in policy) {
      expect(payload.toolsAllow).toEqual(policy.toolsAllow);
    } else {
      expect(payload).not.toHaveProperty("toolsAllow");
    }
  });

  it.each([
    { name: "empty fallbacks", policy: { fallbacks: [] } },
    { name: "explicit fallbacks", policy: { fallbacks: ["openai/gpt-5.5"] } },
    { name: "unsafe-content false", policy: { allowUnsafeExternalContent: false } },
    { name: "unsafe-content true", policy: { allowUnsafeExternalContent: true } },
    { name: "light-context false", policy: { lightContext: false } },
    { name: "light-context true", policy: { lightContext: true } },
    { name: "inherited light context", policy: {} },
  ] satisfies Array<{
    name: string;
    policy: Partial<Extract<CronJob["payload"], { kind: "agentTurn" }>>;
  }>)("clone payload policy: preserves $name for an agent task", async ({ policy }) => {
    const source = createCronJob({
      id: "agent-policy-source",
      name: "Agent policy source",
      payload: { kind: "agentTurn", message: "Synthetic agent task", ...policy },
      delivery: { mode: "none" },
    });
    const original = structuredClone(source);
    const request = createCronRequest("agent-policy-clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });

    startCronClone(state, source);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "agent-policy-clone" });

    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
    expect(submitted.payload).toEqual({
      kind: "agentTurn",
      message: "Synthetic agent task",
      ...policy,
    });
  });

  it("clone payload policy: visible edits replace stored values including unchecked light context", async () => {
    const source = createCronJob({
      id: "edited-payload-source",
      name: "Editable source",
      payload: {
        kind: "agentTurn",
        message: "Original task",
        model: "openai/gpt-5.4",
        thinking: "high",
        timeoutSeconds: 45,
        lightContext: true,
      },
      delivery: { mode: "none" },
    });
    const original = structuredClone(source);
    const request = createCronRequest("edited-payload-clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });
    startCronClone(state, source);
    Object.assign(state.cronForm, {
      payloadText: "  Edited task  ",
      payloadModel: " openai/gpt-5.5 ",
      payloadThinking: " low ",
      timeoutSeconds: "0.25",
      payloadLightContext: false,
    });

    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "edited-payload-clone" });

    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
    expect(submitted.payload).toEqual({
      kind: "agentTurn",
      message: "Edited task",
      model: "openai/gpt-5.5",
      thinking: "low",
      timeoutSeconds: 0.25,
      lightContext: false,
    });
  });

  it("clone payload policy: blank visible overrides stay omitted instead of restoring the source", async () => {
    const source = createCronJob({
      id: "blank-payload-source",
      name: "Blank overrides source",
      payload: {
        kind: "agentTurn",
        message: "Synthetic task",
        model: "openai/gpt-5.5",
        thinking: "high",
        timeoutSeconds: 45,
      },
      delivery: { mode: "none" },
    });
    const original = structuredClone(source);
    const request = createCronRequest("blank-payload-clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });
    startCronClone(state, source);
    Object.assign(state.cronForm, {
      payloadModel: " ",
      payloadThinking: " ",
      timeoutSeconds: " ",
    });

    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "blank-payload-clone" });

    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
    expect(submitted.payload).toEqual({ kind: "agentTurn", message: "Synthetic task" });
  });

  it.each([
    {
      name: "system event with a trigger",
      payload: { kind: "systemEvent", text: "Original event", toolsAllow: ["read"] },
      trigger: { script: "return { fire: true }", once: true },
      target: "systemEvent",
    },
    {
      name: "system event to agent task",
      payload: { kind: "systemEvent", text: "Original event", toolsAllow: [] },
      trigger: { script: "return { fire: true }", once: true },
      target: "agentTurn",
    },
    {
      name: "agent task to system event",
      payload: {
        kind: "agentTurn",
        message: "Original task",
        toolsAllow: ["read"],
        fallbacks: [],
        allowUnsafeExternalContent: true,
        lightContext: false,
      },
      trigger: undefined,
      target: "systemEvent",
    },
    {
      name: "command to new agent task",
      payload: { kind: "command", argv: ["node", "synthetic.mjs"], toolsAllow: [] },
      trigger: undefined,
      target: "agentTurn",
    },
    {
      name: "script to new agent task",
      payload: { kind: "script", script: "return { ok: true }", toolsAllow: ["read"] },
      trigger: undefined,
      target: "agentTurn",
    },
  ] satisfies Array<{
    name: string;
    payload: CronJob["payload"];
    trigger: CronJob["trigger"];
    target: "agentTurn" | "systemEvent";
  }>)("clone payload policy: retains common restrictions for $name", async (scenario) => {
    const source = createCronJob({
      id: "kind-source",
      name: "Kind transition source",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: scenario.payload.kind === "systemEvent" ? "main" : "isolated",
      payload: scenario.payload,
      trigger: scenario.trigger,
      delivery: { mode: "none" },
    });
    const original = structuredClone(source);
    const request = createCronRequest("kind-clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });
    startCronClone(state, source);
    if (scenario.payload.kind === "command" || scenario.payload.kind === "script") {
      expect(state.cronForm.payloadText).toBe("");
      expect(await addCronJob(state)).toEqual({ saved: false });
      expect(state.cronFieldErrors.payloadText).toBe("cron.errors.agentMessageRequired");
      expect(request).not.toHaveBeenCalled();
    }
    Object.assign(state.cronForm, {
      payloadKind: scenario.target,
      sessionTarget: scenario.target === "systemEvent" ? "main" : "isolated",
      payloadText: "New operator-authored task",
    });

    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "kind-clone" });

    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
    expect(submitted.trigger).toEqual(scenario.trigger);
    expect(submitted.payload).toEqual({
      kind: scenario.target,
      ...(scenario.target === "systemEvent"
        ? { text: "New operator-authored task" }
        : { message: "New operator-authored task" }),
      toolsAllow: scenario.payload.toolsAllow,
    });
  });

  it.each([
    { name: "explicit cap", toolsAllowIsDefault: undefined, target: "agentTurn" },
    { name: "default-marked cap", toolsAllowIsDefault: true, target: "agentTurn" },
    { name: "payload kind change", toolsAllowIsDefault: true, target: "systemEvent" },
  ] as const)(
    "clone payload policy: does not echo hidden policy during an update with $name",
    async (scenario) => {
      const source = createCronJob({
        id: "update-policy-source",
        name: "Update policy source",
        payload: {
          kind: "agentTurn",
          message: "Synthetic task",
          toolsAllow: ["read"],
          ...(scenario.toolsAllowIsDefault ? { toolsAllowIsDefault: true } : {}),
          fallbacks: [],
          allowUnsafeExternalContent: true,
          lightContext: false,
        },
        delivery: { mode: "none" },
      });
      const original = structuredClone(source);
      const { state, submit } = createCronEditHarness(source);
      state.cronForm.description = "Metadata changed";
      Object.assign(state.cronForm, {
        payloadKind: scenario.target,
        sessionTarget: scenario.target === "systemEvent" ? "main" : "isolated",
      });

      const call = await submit();

      expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
      expect(source).toEqual(original);
      const payload = requireRecord(requestPatch(call).payload, "updated payload");
      expect(payload.kind).toBe(scenario.target);
      for (const field of [
        "toolsAllow",
        "toolsAllowIsDefault",
        "fallbacks",
        "allowUnsafeExternalContent",
      ]) {
        expect(payload).not.toHaveProperty(field);
      }
    },
  );

  it.each([
    { name: "precise one-shot", schedule: { kind: "at", at: "2030-01-02T03:04:56.789Z" } },
    {
      name: "anchored interval",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_725_000_000_123 },
    },
    {
      name: "subsecond cron stagger",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 1_234 },
    },
    { name: "process exit", schedule: { kind: "on-exit", command: "make build", cwd: "/repo" } },
    {
      name: "event stream",
      schedule: { kind: "stream", command: Array.of("node", "events.mjs"), batchMs: 1_234 },
    },
  ] as const)("clones the exact $name schedule while its fields remain unchanged", async (item) => {
    const request = createCronRequest("job-schedule-clone");
    const sourceJob = createCronJob({
      id: "job-schedule-source",
      name: "Source schedule",
      schedule: item.schedule,
      delivery: { mode: "none" },
    });
    const state = createStateWithRequest(request, { cronJobs: [sourceJob] });

    startCronClone(state, sourceJob);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "job-schedule-clone" });

    expect(requestPayload(findRequestCall(request.mock.calls, "cron.add")).schedule).toEqual(
      item.schedule,
    );
  });

  it("applies an edited schedule when cloning an existing automation", async () => {
    const request = createCronRequest("job-schedule-clone");
    const sourceJob = createCronJob({
      id: "job-schedule-source",
      name: "Source schedule",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_725_000_000_123 },
    });
    const state = createStateWithRequest(request, { cronJobs: [sourceJob] });

    startCronClone(state, sourceJob);
    state.cronForm.everyAmount = "2";
    await addCronJob(state);

    expect(requestPayload(findRequestCall(request.mock.calls, "cron.add")).schedule).toEqual({
      kind: "every",
      everyMs: 120_000,
    });
  });

  it("keeps an existing condition trigger when cloning a script into an editable agent task", async () => {
    const request = createCronRequest("job-script-clone");
    const sourceJob = createCronJob({
      id: "job-script-source",
      name: "Script source",
      schedule: { kind: "every", everyMs: 30_000 },
      payload: { kind: "script", script: "json({ state: {} })" },
      trigger: { script: "json({ fire: true })" },
      delivery: { mode: "none" },
    });
    const state = createStateWithRequest(request, { cronJobs: [sourceJob] });

    startCronClone(state, sourceJob);
    state.cronForm.payloadText = "Continue as an agent task";

    expect(state.cronForm.payloadKind).toBe("agentTurn");
    expect(state.cronForm.triggerEnabled).toBe(true);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "job-script-clone" });
    expect(requestPayload(findRequestCall(request.mock.calls, "cron.add"))).toMatchObject({
      payload: { kind: "agentTurn", message: "Continue as an agent task" },
      trigger: { script: "json({ fire: true })", once: false },
    });
  });

  it("round-trips hidden delivery destinations through clone and edit", async () => {
    const sourceJob = createCronJob({
      id: "job-routing",
      name: "Routed job",
      delivery: {
        mode: "announce",
        threadId: 42,
        bestEffort: true,
        completionDestination: { mode: "webhook", to: "https://example.test/complete" },
        failureDestination: {
          mode: "announce",
          channel: "telegram",
          to: "ops",
          accountId: "alerts",
        },
      },
    });

    const addRequest = createCronRequest("job-copy");
    const cloneState = createState({
      client: { request: addRequest } as unknown as CronState["client"],
      cronJobs: [sourceJob],
    });
    startCronClone(cloneState, sourceJob);
    await addCronJob(cloneState);
    const addPayload = requestPayload(findRequestCall(addRequest.mock.calls, "cron.add"));
    expect(addPayload.delivery).toEqual(sourceJob.delivery);
    expect(validateCronAddParams(addPayload)).toBe(true);

    const updateRequest = createCronRequest(sourceJob.id, { existing: true });
    const editState = createState({
      client: { request: updateRequest } as unknown as CronState["client"],
      cronJobs: [sourceJob],
    });
    startCronEdit(editState, sourceJob);
    editState.cronForm.deliveryThreadId = "thread-42";
    await addCronJob(editState);
    const updatePayload = requestPayload(findRequestCall(updateRequest.mock.calls, "cron.update"));
    expect(requireRecord(updatePayload.patch, "cron.update patch").delivery).toEqual({
      ...sourceJob.delivery,
      threadId: "thread-42",
    });
    expect(validateCronUpdateParams(updatePayload)).toBe(true);
  });

  it("loads paged jobs with query/filter/sort params", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.list") {
        expectRecordFields(requireRecord(payload, "cron.list payload"), {
          limit: 50,
          offset: 0,
          query: "daily",
          enabled: "enabled",
          includeDeliveryPreviews: false,
          scheduleKind: "cron",
          lastRunStatus: "error",
          trigger: "conditional",
          sortBy: "updatedAtMs",
          sortDir: "desc",
        });
        return cronJobsListResponse(
          [
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
              state: {},
            },
          ],
          { snapshotRevision: "daily-jobs" },
        );
      }
      return {};
    });
    const state = createStateWithRequest(request, {
      cronJobsQuery: "daily",
      cronJobsEnabledFilter: "enabled",
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "error",
      cronJobsTriggerFilter: "conditional",
      cronJobsSortBy: "updatedAtMs",
      cronJobsSortDir: "desc",
    });

    await loadCronJobsPage(state, { tableFilters: true });

    expect(state.cronJobs).toHaveLength(1);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronJobsHasMore).toBe(false);
  });

  it("appends jobs only from the accepted snapshot revision", async () => {
    const firstJob = createCronJob({ id: "job-1", name: "First" });
    const secondJob = createCronJob({ id: "job-2", name: "Second" });
    const request = vi.fn(async () =>
      cronJobsListResponse([secondJob], {
        snapshotRevision: "stable-revision",
        total: 2,
        offset: 1,
        limit: 1,
      }),
    );
    const state = createStateWithRequest(request, {
      cronJobs: [firstJob],
      cronJobsSnapshotRevision: "stable-revision",
      cronJobsTotal: 2,
      cronJobsHasMore: true,
      cronJobsNextOffset: 1,
      cronJobsLimit: 1,
    });

    await loadCronJobsPage(state, { append: true });

    expect(state.cronJobs.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(state.cronJobsSnapshotRevision).toBe("stable-revision");
    expect(state.cronJobsHasMore).toBe(false);
    expect(state.cronJobsNextOffset).toBeNull();
  });

  it("restarts at page zero instead of committing an append from a changed snapshot", async () => {
    const staleJob = createCronJob({ id: "stale-only", name: "Stale" });
    const stableJob = createCronJob({ id: "stable", name: "Stable" });
    const currentJob = createCronJob({ id: "current", name: "Current" });
    const responses = [
      cronJobsListResponse([staleJob, stableJob], {
        snapshotRevision: "revision-a",
        total: 3,
        limit: 2,
        hasMore: true,
        nextOffset: 2,
      }),
      emptyCronListResponse({
        snapshotRevision: "revision-b",
        total: 2,
        offset: 2,
        limit: 2,
      }),
      cronJobsListResponse([stableJob, currentJob], {
        snapshotRevision: "revision-b",
        total: 2,
        limit: 2,
      }),
    ];
    const offsets: number[] = [];
    const request = vi.fn(async (_method: string, payload?: unknown) => {
      offsets.push(requireRecord(payload, "cron.list payload").offset as number);
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected cron.list call");
      }
      return response;
    });
    const state = createStateWithRequest(request, { cronJobsLimit: 2 });

    await loadCronJobsPage(state);
    await loadCronJobsPage(state, { append: true });

    expect(offsets).toEqual([0, 2, 0]);
    expect(state.cronJobs.map((job) => job.id)).toEqual(["stable", "current"]);
    expect(state.cronJobsSnapshotRevision).toBe("revision-b");
    expect(state.cronJobsTotal).toBe(2);
    expect(state.cronJobsHasMore).toBe(false);
    expect(state.cronJobsNextOffset).toBeNull();
  });

  it("keeps the last coherent jobs page when snapshot metadata is invalid", async () => {
    const existingJob = createCronJob({ id: "existing", name: "Existing" });
    const request = vi.fn(async () => ({
      jobs: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    }));
    const state = createStateWithRequest(request, {
      cronJobs: [existingJob],
      cronJobsSnapshotRevision: "accepted-revision",
      cronJobsTotal: 1,
      cronJobsHasMore: false,
      cronJobsNextOffset: null,
    });

    await loadCronJobsPage(state);

    expect(state.cronJobs).toEqual([existingJob]);
    expect(state.cronJobsSnapshotRevision).toBe("accepted-revision");
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronJobsError).toContain("cron.list returned an invalid inventory page");
    expect(state.cronError).toBeNull();
  });

  it("keeps table-only filters out of shared cron jobs loads", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.list") {
        const listPayload = requireRecord(payload, "cron.list payload");
        expect(listPayload).not.toHaveProperty("scheduleKind");
        expect(listPayload).not.toHaveProperty("lastRunStatus");
        expect(listPayload).not.toHaveProperty("trigger");
        return emptyCronListResponse();
      }
      return {};
    });
    const state = createStateWithRequest(request, {
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "error",
    });

    await loadCronJobsPage(state);

    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.not.objectContaining({
        scheduleKind: expect.anything(),
        lastRunStatus: expect.anything(),
        trigger: expect.anything(),
      }),
    );
  });

  it("reloads cron jobs after filters change during an in-flight table load", async () => {
    const { first, payloads, request, state } = createCronJobsReloadHarness();

    const firstLoad = loadCronJobsPage(state, { tableFilters: true });
    updateCronJobsFilter(state, {
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });
    await loadCronJobsPage(state, { tableFilters: true });
    first.resolve(emptyCronListResponse());
    await firstLoad;

    expectRecordFields(requireRecord(payloads[1], "pending cron.list payload"), {
      scheduleKind: "cron",
      lastRunStatus: "unknown",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cronJobsReloadPending).toBe(false);
    expect(state.cronJobsReloadPendingTableFilters).toBe(false);
  });

  it("reloads cron jobs after filters change during an in-flight append load", async () => {
    const { first, payloads, request, state } = createCronJobsReloadHarness({
      cronJobs: [
        createCronJob({
          id: "existing",
          name: "Existing",
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "ping" },
        }),
      ],
      cronJobsSnapshotRevision: "revision-a",
      cronJobsTotal: 2,
      cronJobsHasMore: true,
      cronJobsNextOffset: 1,
    });

    const appendLoad = loadCronJobsPage(state, { append: true, tableFilters: true });
    updateCronJobsFilter(state, {
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });
    await loadCronJobsPage(state, { tableFilters: true });
    first.resolve(
      emptyCronListResponse({
        snapshotRevision: "revision-b",
        total: 1,
        offset: 1,
      }),
    );
    await appendLoad;

    expectRecordFields(requireRecord(payloads[0], "append cron.list payload"), {
      offset: 1,
    });
    expectRecordFields(requireRecord(payloads[1], "pending append cron.list payload"), {
      offset: 0,
      scheduleKind: "cron",
      lastRunStatus: "unknown",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cronJobsReloadPending).toBe(false);
    expect(state.cronJobsReloadPendingTableFilters).toBe(false);
    expect(state.cronJobsSnapshotRevision).toBe("cron-jobs-fixture");
  });

  it("uses the latest queued cron jobs table-filter mode", async () => {
    const { first, payloads, request, state } = createCronJobsReloadHarness({
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });

    const firstLoad = loadCronJobsPage(state);
    await loadCronJobsPage(state, { tableFilters: true });
    await loadCronJobsPage(state);
    first.resolve(emptyCronListResponse());
    await firstLoad;

    const pendingPayload = requireRecord(payloads[1], "latest pending cron.list payload");
    expect(pendingPayload).not.toHaveProperty("scheduleKind");
    expect(pendingPayload).not.toHaveProperty("lastRunStatus");
    expect(pendingPayload).not.toHaveProperty("trigger");
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cronJobsReloadPending).toBe(false);
    expect(state.cronJobsReloadPendingTableFilters).toBe(false);
  });

  it("drops malformed cron jobs before they enter UI state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return cronJobsListResponse(
          [
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
          ] as unknown as CronJob[],
          { snapshotRevision: "malformed-job-page" },
        );
      }
      return {};
    });
    const state = createStateWithRequest(request);

    await loadCronJobsPage(state);

    expect(state.cronJobs.map((job) => job.id)).toEqual(["job-ok"]);
    expect(state.cronJobsTotal).toBe(2);
    expect(state.cronJobsHasMore).toBe(false);
  });

  it("keeps list failures separate from other Cron errors", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return emptyCronListResponse({ snapshotRevision: "loaded-empty" });
      }
      if (method === "cron.runs") {
        throw new Error("run history unavailable");
      }
      return {};
    });
    const state = createStateWithRequest(request);

    await loadCronJobsPage(state);
    await expect(loadCronRuns(state, null)).resolves.toBe("error");

    expect(state.cronJobsSnapshotRevision).toBe("loaded-empty");
    expect(state.cronJobsError).toBeNull();
    expect(state.cronError).toBe("run history unavailable");
  });

  it("loads and appends paged run history", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method !== "cron.runs") {
        return {};
      }
      const offset = (payload as { offset?: number } | undefined)?.offset ?? 0;
      if (offset === 0) {
        return {
          entries: [{ ts: 2, jobId: "job-1", action: "finished", status: "ok", summary: "newest" }],
          total: 2,
          hasMore: true,
          nextOffset: 1,
        };
      }
      return {
        entries: [{ ts: 1, jobId: "job-1", action: "finished", status: "ok", summary: "older" }],
        total: 2,
        hasMore: false,
        nextOffset: null,
      };
    });
    const state = createStateWithRequest(request);

    await expect(loadCronRuns(state, "job-1")).resolves.toBe("ok");
    expect(state.cronRuns).toHaveLength(1);
    expect(state.cronRunsHasMore).toBe(true);

    await loadMoreCronRuns(state);
    expect(state.cronRuns).toHaveLength(2);
    expect(state.cronRuns[0]?.summary).toBe("newest");
    expect(state.cronRuns[1]?.summary).toBe("older");
  });

  it("keeps the newest filtered run history when an older overview request finishes last", async () => {
    const currentEntry = {
      ts: 2,
      jobId: "fresh-job",
      action: "finished" as const,
      status: "ok" as const,
      summary: "fresh",
    };
    const { older: olderOverview, state } = createCronRunsRace([currentEntry]);

    const olderLoad = loadCronRuns(state, null);
    updateCronRunsFilter(state, { cronRunsQuery: "fresh" });
    await expect(loadCronRuns(state, null)).resolves.toBe("ok");
    expect(state.cronRuns).toEqual([currentEntry]);

    olderOverview.resolve(
      createCronRunsResult(
        [{ ts: 1, jobId: "stale-job", action: "finished", status: "ok", summary: "stale" }],
        {
          total: 8,
          hasMore: true,
          nextOffset: 1,
        },
      ),
    );

    await expect(olderLoad).resolves.toBe("skipped");
    expect(state.cronRuns).toEqual([currentEntry]);
    expect(state.cronRunsTotal).toBe(1);
    expect(state.cronRunsHasMore).toBe(false);
    expect(state.cronRunsNextOffset).toBeNull();
  });

  it("does not let a deferred overview replace a newly selected job's run history", async () => {
    const selectedEntry = {
      ts: 2,
      jobId: "selected-job",
      action: "finished" as const,
      status: "ok" as const,
      summary: "selected history",
    };
    const { older: olderOverview, state } = createCronRunsRace([selectedEntry]);

    const olderLoad = loadCronRuns(state, null);
    updateCronRunsFilter(state, { cronRunsScope: "job" });
    state.cronRunsJobId = "selected-job";
    await expect(loadCronRuns(state, "selected-job")).resolves.toBe("ok");

    olderOverview.resolve(
      createCronRunsResult([
        {
          ts: 1,
          jobId: "other-job",
          action: "finished",
          status: "ok",
          summary: "wrong task",
        },
      ]),
    );

    await expect(olderLoad).resolves.toBe("skipped");
    expect(state.cronRunsJobId).toBe("selected-job");
    expect(state.cronRuns).toEqual([selectedEntry]);
  });

  it("does not let a deferred selected job replace the current overview", async () => {
    const overviewEntry = {
      ts: 2,
      jobId: "overview-job",
      action: "finished" as const,
      status: "ok" as const,
      summary: "current overview",
    };
    const { older: olderJobHistory, state } = createCronRunsRace([overviewEntry], {
      cronRunsScope: "job",
      cronRunsJobId: "selected-job",
    });

    const olderLoad = loadCronRuns(state, "selected-job");
    updateCronRunsFilter(state, { cronRunsScope: "all" });
    state.cronRunsJobId = null;
    await expect(loadCronRuns(state, null)).resolves.toBe("ok");

    olderJobHistory.resolve(
      createCronRunsResult([
        {
          ts: 1,
          jobId: "selected-job",
          action: "finished",
          status: "ok",
          summary: "stale task",
        },
      ]),
    );

    await expect(olderLoad).resolves.toBe("skipped");
    expect(state.cronRunsJobId).toBeNull();
    expect(state.cronRuns).toEqual([overviewEntry]);
  });

  it("drops an older paginated response after run-history filters are replaced", async () => {
    const currentEntry = {
      ts: 3,
      jobId: "filtered-job",
      action: "finished" as const,
      status: "error" as const,
      summary: "filtered result",
    };
    const { older: olderPage, state } = createCronRunsRace([currentEntry], {
      cronRuns: [
        {
          ts: 2,
          jobId: "previous-job",
          action: "finished",
          status: "ok",
          summary: "previous",
        },
      ],
      cronRunsHasMore: true,
      cronRunsNextOffset: 1,
    });

    const olderLoad = loadCronRuns(state, null, { append: true });
    expect(state.cronRunsLoadingMore).toBe(true);
    updateCronRunsFilter(state, { cronRunsStatuses: ["error"] });
    await expect(loadCronRuns(state, null)).resolves.toBe("ok");
    expect(state.cronRunsLoadingMore).toBe(false);

    olderPage.resolve(
      createCronRunsResult(
        [
          {
            ts: 1,
            jobId: "stale-job",
            action: "finished",
            status: "ok",
            summary: "stale older page",
          },
        ],
        { total: 9, hasMore: true, nextOffset: 2 },
      ),
    );

    await expect(olderLoad).resolves.toBe("skipped");
    expect(state.cronRuns).toEqual([currentEntry]);
    expect(state.cronRunsTotal).toBe(1);
    expect(state.cronRunsHasMore).toBe(false);
    expect(state.cronRunsLoadingMore).toBe(false);
  });

  it("ignores a stale run-history failure after the current request succeeds", async () => {
    const currentEntry = {
      ts: 2,
      jobId: "fresh-job",
      action: "finished" as const,
      status: "ok" as const,
      summary: "fresh",
    };
    const { older: olderFailure, state } = createCronRunsRace([currentEntry]);

    const olderLoad = loadCronRuns(state, null);
    await expect(loadCronRuns(state, null)).resolves.toBe("ok");
    olderFailure.reject(new Error("stale cron history unavailable"));

    await expect(olderLoad).resolves.toBe("skipped");
    expect(state.cronRuns).toEqual([currentEntry]);
    expect(state.cronError).toBeNull();
  });

  it("preserves the current run-history failure when an older response later succeeds", async () => {
    const olderOverview = createDeferred<CronRunsResult>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => olderOverview.promise)
      .mockRejectedValueOnce(new Error("current cron history unavailable"));
    const state = createStateWithRequest(request);

    const olderLoad = loadCronRuns(state, null);
    await expect(loadCronRuns(state, null)).resolves.toBe("error");
    expect(state.cronError).toBe("current cron history unavailable");

    olderOverview.resolve({
      entries: [{ ts: 1, jobId: "stale-job", action: "finished", status: "ok", summary: "stale" }],
      total: 1,
      hasMore: false,
      nextOffset: null,
    });

    await expect(olderLoad).resolves.toBe("skipped");
    expect(state.cronRuns).toEqual([]);
    expect(state.cronError).toBe("current cron history unavailable");
  });

  it("scopes jobs and run history requests to the selected agent", async () => {
    const request = vi.fn(async (method: string) =>
      method === "cron.runs"
        ? { entries: [], total: 0, hasMore: false, nextOffset: null }
        : { jobs: [], total: 0, hasMore: false, nextOffset: null },
    );
    const state = createStateWithRequest(request, {
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
    const state = createStateWithRequest(request);

    await expect(loadCronRuns(state, null)).resolves.toBe("error");

    expect(state.cronError).toBe("cron.runs unavailable");
  });

  it("preserves queued run feedback when due-mode history refresh fails", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.run") {
        expectRecordFields(requireRecord(payload, "cron.run payload"), {
          id: "job-due",
          mode: "due",
        });
        return { ok: true, enqueued: true, runId: "run-due" };
      }
      if (method === "cron.runs") {
        throw new Error("run history refresh unavailable");
      }
      return {};
    });
    const state = createStateWithRequest(request, {
      cronRunsScope: "job",
      cronRunsJobId: "job-due",
    });
    await runCronJob(state, "job-due", "due");

    expect(request).toHaveBeenCalledWith("cron.run", { id: "job-due", mode: "due" });
    expect(request).toHaveBeenCalledWith("cron.runs", expect.any(Object));
    expect(state.cronError).toBe("Run queued. Run ID: run-due");
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
      const state = createStateWithRequest(request, {
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
    const request = createMethodRequest({
      "cron.run": { ok: true, ran: false, reason: "invalid-spec" },
      "cron.runs": createCronRunsResult([]),
    });
    const state = createStateWithRequest(request, {
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

describe("cron every-interval lossless round-trip", () => {
  function everyJob(everyMs: number): CronJob {
    return createCronJob({
      id: "job-interval",
      name: "Interval",
      schedule: { kind: "every", everyMs },
      payload: { kind: "agentTurn", message: "tick" },
      delivery: { mode: "none" },
    });
  }

  function captureUpdateState(job: CronJob) {
    const request = createCronRequest(job.id, { existing: true });
    const state = createStateWithRequest(request, {
      cronJobs: [job],
    });
    return { request, state };
  }

  // Each everyMs the editable form must reproduce exactly: reading a job into the
  // form and rebuilding the schedule may never change the cadence. Legal everyMs
  // spans 1ms through the Gateway's Date timestamp limit, with no sub-minute floor.
  const cases: ReadonlyArray<{ everyMs: number; amount: string; unit: string }> = [
    { everyMs: 1, amount: "0.001", unit: "seconds" },
    { everyMs: 450, amount: "0.45", unit: "seconds" },
    { everyMs: 1_000, amount: "1", unit: "seconds" },
    { everyMs: 30_000, amount: "30", unit: "seconds" },
    { everyMs: 90_000, amount: "90", unit: "seconds" },
    { everyMs: 246_000, amount: "246", unit: "seconds" },
    { everyMs: 60_000, amount: "1", unit: "minutes" },
    { everyMs: 7_200_000, amount: "2", unit: "hours" },
    { everyMs: 86_400_000, amount: "1", unit: "days" },
    { everyMs: 8_639_999_999_999_999, amount: "8639999999999.999", unit: "seconds" },
  ];

  it("reads every job back into the most natural exact unit", () => {
    for (const { everyMs, amount, unit } of cases) {
      const state = createState();
      startCronEdit(state, everyJob(everyMs));
      expect(state.cronForm.everyUnit).toBe(unit);
      expect(state.cronForm.everyAmount).toBe(amount);
      // The rebuilt millisecond value must equal the original, not a rounded one.
      expect(parseCronDurationMs(state.cronForm.everyAmount, state.cronForm.everyUnit)).toBe(
        everyMs,
      );
    }
  });

  it("keeps everyMs unchanged on a metadata-only edit", async () => {
    for (const everyMs of [30_000, 90_000, 450, 8_639_999_999_999_999]) {
      const { request, state } = captureUpdateState(everyJob(everyMs));
      startCronEdit(state, state.cronJobs[0] as CronJob);
      state.cronForm.name = "Renamed only";
      await addCronJob(state);

      const updateCall = findRequestCall(request.mock.calls, "cron.update");
      const patch = requestPatch(updateCall);
      expect(patch).not.toHaveProperty("schedule");
    }
  });

  it("sends the edited interval when the seconds unit is changed", async () => {
    const wholeSeconds = captureUpdateState(everyJob(60_000));
    startCronEdit(wholeSeconds.state, wholeSeconds.state.cronJobs[0] as CronJob);
    wholeSeconds.state.cronForm.everyUnit = "seconds";
    wholeSeconds.state.cronForm.everyAmount = "45";
    await addCronJob(wholeSeconds.state);
    expect(
      requestPatch(findRequestCall(wholeSeconds.request.mock.calls, "cron.update")).schedule,
    ).toEqual({ kind: "every", everyMs: 45_000 });

    const subSecond = captureUpdateState(everyJob(60_000));
    startCronEdit(subSecond.state, subSecond.state.cronJobs[0] as CronJob);
    subSecond.state.cronForm.everyUnit = "seconds";
    subSecond.state.cronForm.everyAmount = "0.45";
    await addCronJob(subSecond.state);
    expect(
      requestPatch(findRequestCall(subSecond.request.mock.calls, "cron.update")).schedule,
    ).toEqual({ kind: "every", everyMs: 450 });
  });

  it("clones a sub-minute job without rounding its interval", async () => {
    const request = createCronRequest("job-clone");
    const sourceJob = everyJob(30_000);
    const state = createStateWithRequest(request, {
      cronJobs: [sourceJob],
    });

    startCronClone(state, sourceJob);
    expect(state.cronForm.everyUnit).toBe("seconds");
    expect(state.cronForm.everyAmount).toBe("30");
    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    expect((addCall[1] as { schedule?: unknown }).schedule).toEqual({
      kind: "every",
      everyMs: 30_000,
    });
  });
});

describe("cron one-shot schedule precision", () => {
  it("omits an unchanged minute but sends a genuinely changed minute", async () => {
    const originalAt = "2030-01-02T03:04:56.789Z";
    const original = createCronJob({
      id: "job-at-precision",
      name: "Precise one-shot",
      schedule: { kind: "at", at: originalAt },
      deleteAfterRun: true,
    });

    const unchanged = createCronEditHarness(original);
    unchanged.state.cronForm.description = "metadata only";
    const unchangedPatch = requestPatch(await unchanged.submit());
    expect(unchangedPatch).not.toHaveProperty("schedule");

    const changed = createCronEditHarness(original);
    const originalMinute = new Date(originalAt);
    originalMinute.setMinutes(originalMinute.getMinutes() + 1);
    originalMinute.setSeconds(0, 0);
    const year = originalMinute.getFullYear();
    const month = String(originalMinute.getMonth() + 1).padStart(2, "0");
    const day = String(originalMinute.getDate()).padStart(2, "0");
    const hour = String(originalMinute.getHours()).padStart(2, "0");
    const minute = String(originalMinute.getMinutes()).padStart(2, "0");
    changed.state.cronForm.scheduleAt = `${year}-${month}-${day}T${hour}:${minute}`;
    const changedPatch = requestPatch(await changed.submit());
    expect(changedPatch.schedule).toEqual({
      kind: "at",
      at: originalMinute.toISOString(),
    });
  });
});

describe("loadCronScopeStats", () => {
  it("loads filter-independent totals and next wake time for the selected agent", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ jobs: [], total: 7 })
      .mockResolvedValueOnce({ jobs: [{ state: { nextRunAtMs: 1234 } }], total: 1 });
    const state = createStateWithRequest(request, {
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

describe("failure alert form round trips", () => {
  it.each([
    { cooldownMs: 0, seconds: "0" },
    { cooldownMs: 1, seconds: "0.001" },
    { cooldownMs: 999, seconds: "0.999" },
    { cooldownMs: 1_001, seconds: "1.001" },
    { cooldownMs: 8_640_000_000_000_001, seconds: "8640000000000.001" },
    { cooldownMs: Number.MAX_SAFE_INTEGER, seconds: "9007199254740.991" },
    { cooldownMs: 1e20, seconds: "100000000000000000" },
  ])(
    "preserves a $cooldownMs ms cooldown when editing metadata",
    async ({ cooldownMs, seconds }) => {
      const job = createCronJob({
        id: "cooldown-metadata",
        name: "Stored cooldown",
        failureAlert: {
          after: 4,
          cooldownMs,
          mode: "webhook",
          to: "https://alerts.example.test/cron",
        },
      });
      const { state, submit } = createCronEditHarness(job);

      expect(state.cronForm.failureAlertCooldownSeconds).toBe(seconds);
      state.cronForm.description = "Only the description changed";
      const call = await submit();

      expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
      expectRecordFields(requireRecord(requestPatch(call).failureAlert, "failureAlert"), {
        cooldownMs,
      });
    },
  );

  it.each([
    { seconds: "1.001", cooldownMs: 1_001 },
    { seconds: "1e-3", cooldownMs: 1 },
    { seconds: "0", cooldownMs: 0 },
    { seconds: "0.0009", cooldownMs: 0 },
    { seconds: "8640000000000.001", cooldownMs: 8_640_000_000_000_001 },
  ])("serializes explicit cooldown seconds $seconds", async ({ seconds, cooldownMs }) => {
    const { submit } = createCronSubmitHarness("authored-cooldown", {
      form: {
        name: "Authored cooldown",
        payloadText: "Run report",
        failureAlertMode: "custom",
        failureAlertCooldownSeconds: seconds,
      },
    });

    const { call } = await submit();

    expect(validateCronAddParams(requestPayload(call))).toBe(true);
    expectRecordFields(requireRecord(requestPayload(call).failureAlert, "failureAlert"), {
      cooldownMs,
    });
  });

  it("preserves finite prefixed-number cooldown spellings accepted by the text field", async () => {
    for (const [seconds, cooldownMs] of [
      ["0x10", 16_000],
      ["0b10", 2_000],
      ["0o10", 8_000],
    ] as const) {
      const { submit } = createCronSubmitHarness("prefixed-cooldown", {
        form: {
          name: "Existing numeric spelling",
          payloadText: "Run report",
          failureAlertMode: "custom",
          failureAlertCooldownSeconds: seconds,
        },
      });

      const { call } = await submit();

      expect(validateCronAddParams(requestPayload(call))).toBe(true);
      expectRecordFields(requireRecord(requestPayload(call).failureAlert, "failureAlert"), {
        cooldownMs,
      });
    }
  });

  it("keeps omitted policy fields inherited when editing metadata", async () => {
    const job = createCronJob({
      id: "inherited-alert-policy",
      name: "Inherited per-field policy",
      failureAlert: {},
    });
    const { state, submit } = createCronEditHarness(job);

    expect(state.cronForm.failureAlertMode).toBe("custom");
    expect(state.cronForm.failureAlertAfter).toBe("");
    expect(state.cronForm.failureAlertCooldownSeconds).toBe("");
    expect(state.cronForm.failureAlertDeliveryMode).toBe("");
    state.cronForm.description = "Only metadata changed";
    const call = await submit();

    // oxlint-disable-next-line unicorn/prefer-structured-clone -- assert omitted fields on the websocket wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual({});
  });

  it("creates an explicit policy without materializing inherited defaults", async () => {
    const { submit } = createCronSubmitHarness("custom-inherited-policy", {
      form: { name: "Use global policy", payloadText: "Run report", failureAlertMode: "custom" },
    });

    const { call } = await submit();

    expect(validateCronAddParams(requestPayload(call))).toBe(true);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- assert omitted fields on the websocket wire
    expect(JSON.parse(JSON.stringify(requestPayload(call).failureAlert))).toEqual({});
  });

  it("preserves an explicit policy, including skipped-run alerts, when cloning", async () => {
    const job = createCronJob({
      id: "clone-source-policy",
      name: "Clone source",
      failureAlert: {
        after: 4,
        cooldownMs: 1_001,
        mode: "webhook",
        to: "https://alerts.example.test/cron",
        includeSkipped: true,
      },
    });
    const request = createCronRequest("cloned-policy");
    const state = createStateWithRequest(request);
    startCronClone(state, job);

    await addCronJob(state);

    const call = findRequestCall(request.mock.calls, "cron.add");
    expect(validateCronAddParams(requestPayload(call))).toBe(true);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- assert the clone's complete stored policy on the websocket wire
    expect(JSON.parse(JSON.stringify(requestPayload(call).failureAlert))).toEqual(job.failureAlert);
  });

  it("preserves an explicit last channel and skipped-run override when cloning", async () => {
    const job = createCronJob({
      id: "clone-inherited-policy",
      name: "Inherited clone",
      failureAlert: { channel: "last", includeSkipped: false },
    });
    const request = createCronRequest("cloned-inherited-policy");
    const state = createStateWithRequest(request);
    startCronClone(state, job);

    await addCronJob(state);

    const call = findRequestCall(request.mock.calls, "cron.add");
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- distinguish an omitted override from false
    expect(JSON.parse(JSON.stringify(requestPayload(call).failureAlert))).toEqual({
      channel: "last",
      includeSkipped: false,
    });
  });

  it("keeps a disabled failure policy disabled when cloning", async () => {
    const job = createCronJob({
      id: "clone-disabled-policy",
      name: "Disabled alerts",
      failureAlert: false,
    });
    const request = createCronRequest("cloned-disabled-policy");
    const state = createStateWithRequest(request);
    startCronClone(state, job);

    await addCronJob(state);

    const call = findRequestCall(request.mock.calls, "cron.add");
    expect(requestPayload(call).failureAlert).toBe(false);
  });

  it("clears mode, threshold, and cooldown overrides without disabling the policy", async () => {
    const job = createCronJob({
      id: "clear-policy-fields",
      name: "Clear only overrides",
      failureAlert: { after: 4, cooldownMs: 1_001, mode: "webhook", includeSkipped: true },
    });
    const { state, submit } = createCronEditHarness(job);
    Object.assign(state.cronForm, {
      failureAlertAfter: "",
      failureAlertCooldownSeconds: "",
      failureAlertDeliveryMode: "",
    });

    const call = await submit();

    expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
    expectRecordFields(requireRecord(requestPatch(call).failureAlert, "failureAlert"), {
      after: null,
      cooldownMs: null,
      mode: null,
    });
  });

  it("preserves inherited alert fields while editing a command with hidden alert controls", async () => {
    const job = createCronJob({
      id: "command-inherited-policy",
      name: "Command alert policy",
      payload: { kind: "command", argv: ["node", "report.mjs"] },
      failureAlert: {},
    });
    const { state, submit } = createCronEditHarness(job);
    state.cronForm.description = "Only metadata changed";

    const call = await submit();

    expect(requestPatch(call)).not.toHaveProperty("payload");
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- hidden controls must not materialize defaults on the wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual({});
  });

  it("rejects a positive alert threshold below one before RPC", async () => {
    const request = createCronRequest("fractional-threshold");
    const state = createStateWithRequest(request, {
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "Fractional threshold",
        payloadText: "Run report",
        failureAlertMode: "custom",
        failureAlertAfter: ".5",
      },
    });

    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.failureAlertAfter).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps flooring a fractional alert threshold of at least one", async () => {
    const { submit } = createCronSubmitHarness("valid-fractional-threshold", {
      form: {
        name: "Valid fractional threshold",
        payloadText: "Run report",
        failureAlertMode: "custom",
        failureAlertAfter: "1.5",
      },
    });

    const { call } = await submit();

    expect(validateCronAddParams(requestPayload(call))).toBe(true);
    expectRecordFields(requireRecord(requestPayload(call).failureAlert, "failureAlert"), {
      after: 1,
    });
  });

  it("rejects a seconds value whose millisecond conversion overflows before RPC", async () => {
    const request = createCronRequest("overflow-policy");
    const state = createStateWithRequest(request, {
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "Overflow policy",
        payloadText: "Run report",
        failureAlertMode: "custom",
        failureAlertCooldownSeconds: "1e308",
      },
    });

    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.failureAlertCooldownSeconds).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
});
