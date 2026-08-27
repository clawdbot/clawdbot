import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { CronState } from "../../lib/cron/index.ts";
import "./cron-page.ts";

type CronTestPage = HTMLElement & {
  context: ApplicationContext;
  routeSearch: string;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  render: () => typeof nothing;
  cron: CronState;
  cronModelSuggestions: string[];
};

function waitForCronPage(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

type TestGateway = ApplicationContext["gateway"] & {
  emitSnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  emitRetiredEvent: (event: Parameters<GatewayEventListener>[0]) => void;
};

function createGateway(client: GatewayBrowserClient, connected: boolean): TestGateway {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const snapshotListeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const allEventListeners: GatewayEventListener[] = [];
  return {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      allEventListeners.push(listener);
      return () => eventListeners.delete(listener);
    },
    emitSnapshot(patch: Partial<ApplicationGatewaySnapshot>) {
      Object.assign(snapshot, patch);
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
    emitRetiredEvent(event: Parameters<GatewayEventListener>[0]) {
      for (const listener of allEventListeners) {
        listener(event);
      }
    },
  } as unknown as TestGateway;
}

function createContext(
  gateway: TestGateway,
  scopeId: string | null = "main",
  selectedId: string | null = scopeId,
): ApplicationContext {
  const subscribe = () => () => undefined;
  let selectionState = { selectedId, scopeId };
  const selectionListeners = new Set<(state: typeof selectionState) => void>();
  return {
    basePath: "",
    gateway,
    agents: {
      state: {
        agentsList: { defaultId: "main", agents: [{ id: "main" }] },
        agentsLoading: false,
        agentsError: null,
      },
      ensureList: vi.fn(async () => undefined),
      subscribe,
    },
    channels: {
      state: {
        channelsSnapshot: null,
      },
      refresh: vi.fn(async () => undefined),
      subscribe,
    },
    runtimeConfig: {
      state: { configSnapshot: null },
      subscribe,
    },
    agentSelection: {
      get state() {
        return selectionState;
      },
      set(agentId: string | null) {
        selectionState = { selectedId: agentId, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      setScope(agentId: string | null) {
        selectionState = { ...selectionState, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      subscribe(listener: (state: typeof selectionState) => void) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

function createPage(context: ApplicationContext, options: { render?: boolean } = {}): CronTestPage {
  const page = document.createElement("openclaw-cron-page") as CronTestPage;
  page.context = context;
  if (!options.render) {
    page.render = () => nothing;
  }
  document.body.append(page);
  return page;
}

function cronListResponse(jobs: CronJob[]): CronJobsListResult {
  return {
    jobs: jobs.map((job) => ({
      configRevision: job.configRevision ?? `config-revision-${job.id}`,
      ...job,
    })),
    snapshotRevision: "cron-page-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function createRequest(
  cronStatus: { enabled: boolean; jobs: number; triggersEnabled: boolean } = {
    enabled: true,
    jobs: 0,
    triggersEnabled: true,
  },
) {
  return vi.fn(async (method: string) => {
    if (method === "cron.status") {
      return { ...cronStatus };
    }
    if (method === "cron.list") {
      return cronListResponse([]);
    }
    if (method === "cron.runs") {
      return { entries: [], total: 0, offset: 0, hasMore: false };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    return {};
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage editor state sync", () => {
  it("opens a linked job's history after its jobs load and highlights the linked run", async () => {
    const job: CronJob = {
      id: "linked-job",
      name: "Linked automation",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "digest" },
      state: {},
    };
    const jobs = createDeferred<CronJobsListResult>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.list") {
        return jobs.promise;
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, triggersEnabled: true };
      }
      if (method === "cron.runs") {
        const entries =
          (params as { id?: string }).id === job.id
            ? [
                {
                  ts: 2,
                  jobId: job.id,
                  action: "finished",
                  runId: "cron:linked-job:2",
                  summary: "Another run",
                },
                {
                  ts: 1,
                  jobId: job.id,
                  action: "finished",
                  runId: "cron:linked-job:1",
                  summary: "Linked run",
                },
              ]
            : [];
        return { entries, total: entries.length, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    page.routeSearch = "?job=linked-job&run=cron%3Alinked-job%3A1";

    await waitForCronPage(() => expect(page.cron.cronLoading).toBe(true));
    expect(page.cron.cronEditingJobId).toBeNull();
    jobs.resolve(cronListResponse([job]));

    await waitForCronPage(() => {
      expect(page.cron.cronEditingJobId).toBe(job.id);
      expect(
        page
          .querySelector('[data-test-id="cron-detail-tab-history"]')
          ?.getAttribute("aria-selected"),
      ).toBe("true");
      expect(page.querySelector(".cron-run-entry--highlighted")?.textContent).toContain(
        "Linked run",
      );
    });
    expect(page.querySelectorAll(".cron-run-entry--highlighted")).toHaveLength(1);
  });

  it.each([
    { scenario: "an unsaved enable edit", active: false, edited: true, saved: false },
    { scenario: "an unsaved disable edit", active: true, edited: false, saved: false },
    { scenario: "a saved-but-unapplied enable edit", active: false, edited: true, saved: true },
    { scenario: "a saved-but-unapplied disable edit", active: true, edited: false, saved: true },
  ])("keeps trigger authoring owned by cron.status during $scenario", async (scenario) => {
    const request = createRequest({ enabled: true, jobs: 0, triggersEnabled: scenario.active });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const context = createContext(gateway);
    const editedConfig = { cron: { triggers: { enabled: scenario.edited } } };
    Object.assign(context.runtimeConfig.state, {
      configForm: editedConfig,
      configFormDirty: !scenario.saved,
      configNeedsApply: scenario.saved,
      configSnapshot: scenario.saved ? { config: editedConfig, sourceConfig: editedConfig } : null,
    });
    const page = createPage(context, { render: true });

    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: scenario.active }),
    );
    (page.querySelector('[data-test-id="cron-new-task"]') as HTMLButtonElement).click();
    await waitForCronPage(() => expect(page.querySelector("fieldset.cron-editor")).not.toBeNull());

    const triggerToggle = Array.from(page.querySelectorAll("wa-switch.settings-toggle")).find(
      (toggle) => toggle.textContent?.includes("Condition trigger"),
    );
    expect(Boolean(triggerToggle)).toBe(scenario.active);
    if (!scenario.active) {
      expect(page.textContent).toContain("disabled by cron.triggers.enabled");
    }
  });

  it("keeps conflict detail attached to the authoritative job outside active filters", async () => {
    const staleJob: CronJob = {
      id: "filtered-conflict-job",
      name: "Loaded name",
      description: "Loaded description",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 1,
      configRevision: "revision-stale",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "digest" },
      state: {},
    };
    const authoritativeJob: CronJob = {
      ...staleJob,
      name: "Authoritative name",
      description: "Latest Gateway definition",
      updatedAtMs: 2,
      configRevision: "revision-current",
    };
    const conflict = Object.assign(new Error("cron job definition changed"), {
      details: { code: "CRON_JOB_CHANGED" },
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.list") {
        const query = (params as { query?: string } | undefined)?.query;
        return query === "missing from filtered results"
          ? cronListResponse([])
          : cronListResponse([staleJob]);
      }
      if (method === "cron.update") {
        throw conflict;
      }
      if (method === "cron.get") {
        return authoritativeJob;
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]')).not.toBeNull(),
    );
    (page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]') as HTMLElement).click();
    await waitForCronPage(() => expect(page.cron.cronEditingJobId).toBe(staleJob.id));

    page.cron.cronJobsQuery = "missing from filtered results";
    page.requestUpdate();
    await page.updateComplete;
    const name = page.querySelector("#cron-name") as HTMLInputElement;
    name.value = "My stale edit";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement).click();

    await waitForCronPage(() =>
      expect(page.cron.cronEditingConfigRevision).toBe("revision-current"),
    );
    expect(page.cron.cronEditingJob).toEqual(authoritativeJob);
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ query: "missing from filtered results" }),
    );
    expect(request).toHaveBeenCalledWith("cron.get", { id: staleJob.id });
    expect(page.cron.cronJobs).toEqual([]);
    expect(page.cron.cronJobsTotal).toBe(0);
    expect((page.querySelector("#cron-name") as HTMLInputElement).value).toBe(
      authoritativeJob.name,
    );
    expect(page.querySelector(".cron-detail-title")?.textContent).toContain(authoritativeJob.name);
    expect(page.querySelector('[data-test-id="cron-detail-description"]')?.textContent).toContain(
      authoritativeJob.description,
    );
    expect(page.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull();

    (page.querySelector('[data-test-id="cron-back"]') as HTMLButtonElement).click();
    await waitForCronPage(() => expect(page.cron.cronEditingJobId).toBeNull());
    expect(page.cron.cronEditingJob).toBeNull();
    expect(page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]')).toBeNull();
  });

  it.each([
    { scenario: "legacy absent authentication", scopes: undefined, canManage: true },
    { scenario: "read-only authentication", scopes: ["operator.read"], canManage: false },
    { scenario: "write-only authentication", scopes: ["operator.write"], canManage: false },
    { scenario: "administrator authentication", scopes: ["operator.admin"], canManage: true },
  ])("gates scheduler mutations for $scenario", async ({ scopes, canManage }) => {
    const job: CronJob = {
      id: "access-job",
      name: "Readably scheduled task",
      description: "Inspect this task without changing its permissions",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "digest" },
      state: {},
    };
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return cronListResponse([job]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    if (scopes) {
      gateway.emitSnapshot({
        hello: {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes },
        } as ApplicationGatewaySnapshot["hello"],
      });
    }
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-access-job"]')).not.toBeNull(),
    );
    expect(
      page.querySelector('[data-test-id="cron-row-description-access-job"]')?.textContent,
    ).toContain(job.description);
    expect(Boolean(page.querySelector('[data-test-id="cron-new-task"]'))).toBe(canManage);
    expect(Boolean(page.querySelector('[data-test-id="cron-row-run-access-job"]'))).toBe(canManage);
    expect(Boolean(page.querySelector('[data-test-id="cron-row-toggle-access-job"]'))).toBe(
      canManage,
    );
    expect(Boolean(page.querySelector("wa-dropdown.cron-job-menu"))).toBe(canManage);

    (page.querySelector('[data-test-id="cron-row-access-job"]') as HTMLElement).click();
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull(),
    );
    expect(page.querySelector('[data-test-id="cron-detail-description"]')?.textContent).toContain(
      job.description,
    );
    expect(Boolean(page.querySelector('[data-test-id="cron-run-now"]'))).toBe(canManage);
    expect(Boolean(page.querySelector('[data-test-id="cron-toggle-enabled"]'))).toBe(canManage);

    if (!canManage) {
      const editor = page.querySelector("fieldset.cron-editor") as HTMLFieldSetElement;
      expect(editor.disabled).toBe(true);
      expect(page.querySelector('[data-test-id="cron-submit"]')).toBeNull();
      expect(
        request.mock.calls.some(([method]) =>
          ["cron.add", "cron.update", "cron.run", "cron.remove"].includes(method),
        ),
      ).toBe(false);
    }
  });

  it.each([
    {
      scenario: "a new task for the selected agent",
      scopeId: "writer",
      suggested: false,
      expectedAgentId: "writer",
    },
    {
      scenario: "a suggested task for the selected agent",
      scopeId: "writer",
      suggested: true,
      expectedAgentId: "writer",
    },
    {
      scenario: "a new task for the default agent",
      scopeId: "main",
      suggested: false,
      expectedAgentId: "main",
    },
    {
      scenario: "a new task from the all-agents view",
      scopeId: null,
      selectedId: "writer",
      suggested: false,
      expectedAgentId: "writer",
    },
  ])("creates $scenario with its intended agent ownership", async (scenario) => {
    const request = createRequest();
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(
      createContext(gateway, scenario.scopeId, scenario.selectedId ?? scenario.scopeId),
      { render: true },
    );
    await waitForCronPage(() => {
      expect(request).toHaveBeenCalledWith("models.list", {
        agentId: scenario.expectedAgentId,
        view: "configured",
        preparedOnly: true,
      });
    });

    const createSelector = scenario.suggested
      ? '[data-suggestion="repoPulse"]'
      : '[data-test-id="cron-new-task"]';
    await waitForCronPage(() => expect(page.querySelector(createSelector)).not.toBeNull());
    (page.querySelector(createSelector) as HTMLButtonElement).click();

    await waitForCronPage(() => {
      expect(page.querySelector("#cron-name")).not.toBeNull();
      expect(page.querySelector("#cron-payload-text")).not.toBeNull();
    });
    const name = page.querySelector("#cron-name") as HTMLInputElement;
    name.value = "Agent-scoped task";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const payload = page.querySelector("#cron-payload-text") as HTMLTextAreaElement;
    payload.value = "Run for the selected agent";
    payload.dispatchEvent(new Event("input", { bubbles: true }));

    await waitForCronPage(() => {
      const submit = page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement;
      expect(submit).not.toBeNull();
      expect(submit.disabled).toBe(false);
    });
    (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement).click();

    await waitForCronPage(() => {
      expect(request).toHaveBeenCalledWith(
        "cron.add",
        expect.objectContaining({
          name: "Agent-scoped task",
          agentId: scenario.expectedAgentId,
        }),
      );
    });
  });

  it("scopes list, stats, and run history requests to the selected agent", async () => {
    const request = createRequest();
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => {
      expect(request).toHaveBeenCalledWith(
        "cron.list",
        expect.objectContaining({ agentId: "writer" }),
      );
      expect(request).toHaveBeenCalledWith(
        "cron.runs",
        expect.objectContaining({ agentId: "writer" }),
      );
    });
  });

  it("create & run now issues cron.run for the job returned by cron.add", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "cron.add") {
        return { id: "job-fresh" };
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "cron.run") {
        return { ok: true, enqueued: true, runId: "run-fresh" };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway, "writer"), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-new-task"]')).not.toBeNull(),
    );
    (page.querySelector('[data-suggestion="repoPulse"]') as HTMLButtonElement).click();
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-submit-run"]')).not.toBeNull(),
    );
    (page.querySelector('[data-test-id="cron-submit-run"]') as HTMLButtonElement).click();

    await waitForCronPage(() => {
      const methods = request.mock.calls.map((call) => call[0]);
      expect(methods.indexOf("cron.run")).toBeGreaterThan(methods.indexOf("cron.add"));
    });
    expect(request).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(request).toHaveBeenCalledWith("cron.run", { id: "job-fresh", mode: "force" });
    await waitForCronPage(() => expect(page.cron.cronCreateOpen).toBe(false));
    await waitForCronPage(() =>
      expect(page.textContent).toContain("Run queued. Run ID: run-fresh"),
    );
  });

  it("drills from the failing stat into run history filtered to errors", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-stat-failing"]')).not.toBeNull(),
    );
    (page.querySelector('[data-test-id="cron-stat-failing"]') as HTMLButtonElement).click();

    await waitForCronPage(() => expect(page.querySelector(".cron-activity")).not.toBeNull());
    expect(page.cron.cronRunsStatuses).toEqual(["error"]);
    expect(request).toHaveBeenCalledWith(
      "cron.runs",
      expect.objectContaining({ statuses: ["error"] }),
    );
  });

  it("syncs form enabled after header pause and resets runs scope after remove", async () => {
    const job: CronJob = {
      id: "job-1",
      name: "Nightly digest",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "digest" },
      state: {},
    };
    let serverEnabled = true;
    let removed = false;
    const removeRequested = createDeferred();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.list") {
        return cronListResponse(removed ? [] : [{ ...job, enabled: serverEnabled }]);
      }
      if (method === "cron.update") {
        const patch = (params as { patch?: { enabled?: boolean } }).patch;
        if (typeof patch?.enabled === "boolean") {
          serverEnabled = patch.enabled;
        }
        return {
          ...job,
          enabled: serverEnabled,
          updatedAtMs: 1,
          configRevision: "config-revision-job-1-updated",
        };
      }
      if (method === "cron.remove") {
        removed = true;
        removeRequested.resolve();
        return {};
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() => expect(page.querySelector(".cron-table__row")).not.toBeNull());
    (page.querySelector(".cron-table__row") as HTMLElement).click();
    await waitForCronPage(() => expect(page.cron.cronEditingJobId).toBe("job-1"));
    expect(page.cron.cronRunsScope).toBe("job");
    expect(page.cron.cronForm.enabled).toBe(true);

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-toggle-enabled"] wa-switch')).not.toBeNull(),
    );
    const enabledToggle = page.querySelector(
      '[data-test-id="cron-toggle-enabled"] wa-switch',
    ) as HTMLElement & { checked: boolean };
    enabledToggle.checked = false;
    enabledToggle.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForCronPage(() => expect(page.cron.cronForm.enabled).toBe(false));
    expect(serverEnabled).toBe(false);
    expect(request).toHaveBeenCalledWith("cron.update", {
      id: job.id,
      expectedConfigRevision: "config-revision-job-1",
      patch: { enabled: false },
    });

    const findRemoveButton = () =>
      Array.from(page.querySelectorAll<HTMLButtonElement>(".cron-job-menu__item")).find(
        (item) => item.textContent?.trim() === "Remove",
      );
    await waitForCronPage(() => expect(findRemoveButton()?.disabled).toBe(false));
    findRemoveButton()?.click();
    const findConfirmButton = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".exec-approval-actions .btn")).find(
        (button) => button.textContent?.trim() === "Remove",
      );
    await waitForCronPage(() => expect(findConfirmButton()).toBeDefined());
    findConfirmButton()?.click();
    await removeRequested.promise;
    await waitForCronPage(() => expect(page.cron.cronEditingJobId).toBeNull());
    await waitForCronPage(() => expect(page.cron.cronRunsScope).toBe("all"));
  });

  it("renders read-only controls and rejects a stale admin action after a scope downgrade", async () => {
    const job: CronJob = {
      id: "job-1",
      name: "Nightly digest",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "digest" },
      state: {},
    };
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return cronListResponse([job]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-run-job-1"]')).not.toBeNull(),
    );
    const staleRunButton = page.querySelector(
      '[data-test-id="cron-row-run-job-1"]',
    ) as HTMLButtonElement;

    gateway.emitSnapshot({
      hello: { auth: { role: "operator", scopes: ["operator.read"] } } as never,
    });
    staleRunButton.click();
    page.requestUpdate();
    await page.updateComplete;

    expect(request.mock.calls.some(([method]) => method === "cron.run")).toBe(false);
    expect(page.textContent).toContain("Browsing only");
    expect(page.querySelector('[data-test-id="cron-new-task"]')).toBeNull();
    expect(page.querySelector('[data-test-id="cron-row-run-job-1"]')).toBeNull();
    expect(page.querySelector('[data-test-id="cron-row-job-1"]')).not.toBeNull();

    (page.querySelector('[data-test-id="cron-row-job-1"]') as HTMLElement).click();
    await waitForCronPage(() =>
      expect(page.querySelector(".cron-editor")?.matches(":disabled")).toBe(true),
    );
    expect(page.querySelector('[data-test-id="cron-submit"]')).toBeNull();
    expect(page.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull();
  });
});

describe("CronPage lifecycle", () => {
  it("registers idempotently when the module is evaluated again", async () => {
    const registered = customElements.get("openclaw-cron-page");
    expect(registered).toBeDefined();

    const freshModulePath = "./cron-page.ts?custom-element-idempotence";
    await expect(import(/* @vite-ignore */ freshModulePath)).resolves.toBeDefined();

    expect(customElements.get("openclaw-cron-page")).toBe(registered);
  });

  it("replaces all mutable page state on each connection epoch", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway));
    await page.updateComplete;
    const connectedState = page.cron;
    page.cron = {
      ...connectedState,
      cronStatus: { enabled: true, triggersEnabled: true, jobs: 1 },
      cronJobs: [{ id: "old" } as never],
      cronCreateOpen: true,
    };
    page.cronModelSuggestions = ["old/model"];

    gateway.emitSnapshot({ phase: "stopped" });
    const disconnectedState = page.cron;

    expect(disconnectedState).not.toBe(connectedState);
    expect(disconnectedState.cronStatus).toBeNull();
    expect(disconnectedState.cronJobs).toEqual([]);
    expect(page.cronModelSuggestions).toEqual([]);
    expect(disconnectedState.cronCreateOpen).toBe(false);

    gateway.emitSnapshot({ phase: "connected" });
    expect(page.cron).not.toBe(disconnectedState);
  });

  it("refreshes trigger authoring from scheduler status after reconnect", async () => {
    const schedulerStatus = { enabled: true, jobs: 0, triggersEnabled: true };
    const request = createRequest(schedulerStatus);
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const context = createContext(gateway);
    Object.assign(context.runtimeConfig.state, {
      configForm: { cron: { triggers: { enabled: true } } },
      configNeedsApply: true,
    });
    const page = createPage(context, { render: true });

    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: true }),
    );
    schedulerStatus.triggersEnabled = false;
    gateway.emitSnapshot({ phase: "stopped" });
    expect(page.cron.cronStatus).toBeNull();
    gateway.emitSnapshot({ phase: "connected" });

    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: false }),
    );
    expect(request.mock.calls.filter(([method]) => method === "cron.status")).toHaveLength(2);
    (page.querySelector('[data-test-id="cron-new-task"]') as HTMLButtonElement).click();
    await waitForCronPage(() => expect(page.querySelector("fieldset.cron-editor")).not.toBeNull());

    const triggerToggle = Array.from(page.querySelectorAll("wa-switch.settings-toggle")).find(
      (toggle) => toggle.textContent?.includes("Condition trigger"),
    );
    expect(triggerToggle).toBeUndefined();
    expect(page.textContent).toContain("disabled by cron.triggers.enabled");
  });

  it("rejects model suggestions from an earlier connection epoch", async () => {
    const staleModels = createDeferred<{ models: Array<{ id: string }> }>();
    let modelRequestCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        modelRequestCount += 1;
        return modelRequestCount === 1 ? staleModels.promise : { models: [{ id: "fresh/model" }] };
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, false);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(modelRequestCount).toBe(1));
    gateway.emitSnapshot({ phase: "stopped" });
    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["fresh/model"]));

    staleModels.resolve({ models: [{ id: "stale/model" }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(page.cronModelSuggestions).toEqual(["fresh/model"]);
  });

  it("ignores a cron event callback retained by a replaced gateway source", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const firstGateway = createGateway(client, true);
    const secondGateway = createGateway(client, true);
    const firstContext = createContext(firstGateway);
    const secondContext = createContext(secondGateway);
    const page = createPage(firstContext);
    await waitForCronPage(() => expect(request).toHaveBeenCalled());

    page.context = secondContext;
    page.requestUpdate();
    await page.updateComplete;
    await waitForCronPage(() => expect(page.cron.client).toBe(client));
    request.mockClear();
    vi.mocked(secondContext.channels.refresh).mockClear();

    firstGateway.emitRetiredEvent({ event: "cron" } as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    expect(secondContext.channels.refresh).not.toHaveBeenCalled();
  });
});
