import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage header", () => {
  it("uses the shared settings header with concise context and scope actions", async () => {
    const gateway = createGateway(
      { request: createRequest() } as unknown as GatewayBrowserClient,
      false,
    );
    const context = createContext(gateway);
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main" }, { id: "research" }],
    };
    const page = createPage(context, { render: true });

    await page.updateComplete;

    expect(page.querySelector(".page-title")?.textContent).toBe("Automations");
    expect(page.querySelector(".content-header--settings")).not.toBeNull();
    expect(page.querySelector(".page-subtitle")?.textContent).toBe(
      "Scheduled tasks and recurring agent runs.",
    );
    expect(page.querySelector(".page-header-actions .agent-scope-control")).not.toBeNull();
  });
});

describe("CronPage editor state sync", () => {
  it.each(["visible", "later page", "another agent"])(
    "opens a linked job's history when the job is on %s",
    async (placement) => {
      const job: CronJob = {
        id: "linked-job",
        agentId: placement === "another agent" ? "writer" : "main",
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
        if (method === "cron.get") {
          return job;
        }
        if (method === "cron.status") {
          return { enabled: true, jobs: 1, triggersEnabled: true };
        }
        if (method === "cron.runs") {
          const filter = params as { id?: string; agentId?: string };
          if (filter.id === job.id && filter.agentId && filter.agentId !== job.agentId) {
            throw new Error("Automation not found");
          }
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
      const inventory = cronListResponse(
        placement === "visible"
          ? [job]
          : Array.from({ length: 50 }, (_, index) => ({
              ...job,
              id: `other-${index}`,
              name: `Other automation ${index}`,
            })),
      );
      if (placement === "later page") {
        inventory.total = 51;
        inventory.hasMore = true;
        inventory.nextOffset = 50;
      }
      jobs.resolve(inventory);

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
    },
  );

  it.each([
    "selecting another job",
    "changing agent scope",
    "opening another link",
    "disconnecting",
  ])("ignores a pending job link after %s", async (action) => {
    const linked = createCronViewJob("linked-job", { state: {} });
    const selected = createCronViewJob("selected-job", { state: {} });
    const pending = createDeferred<CronJob>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.get") {
        return (params as { id: string }).id === linked.id ? pending.promise : selected;
      }
      if (method === "cron.list") {
        return cronListResponse([selected]);
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const context = createContext(gateway);
    const page = createPage(context, { render: true });
    page.routeSearch = "?job=linked-job";
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("cron.get", { id: linked.id }),
    );
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-selected-job"]')).not.toBeNull(),
    );

    if (action === "selecting another job") {
      (page.querySelector('[data-test-id="cron-row-selected-job"]') as HTMLElement).click();
    } else if (action === "changing agent scope") {
      context.agentSelection.setScope("writer");
    } else if (action === "opening another link") {
      page.routeSearch = "?job=selected-job";
    } else {
      gateway.emitSnapshot({ phase: "stopped" });
    }
    const expectedJobId =
      action === "selecting another job" || action === "opening another link" ? selected.id : null;
    await waitForCronPage(() => expect(page.cron.cronEditingJobId).toBe(expectedJobId));
    pending.resolve(linked);
    // Drain the held response and its page update before checking the user's selection.
    await pending.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;
    expect(page.cron.cronEditingJobId).toBe(expectedJobId);
    expect(page.cron.cronError).toBeNull();
  });

  it("shows an exact job lookup failure instead of silently discarding the link", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "cron.get") {
        throw new Error("Automation no longer exists");
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    page.routeSearch = "?job=removed-job";

    await waitForCronPage(() => expect(page.textContent).toContain("Automation no longer exists"));
    expect(page.cron.cronEditingJobId).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "cron.get")).toHaveLength(1);
  });

  it.each(["another link", "another row", "a new task"])(
    "clears a failed job link when opening %s",
    async (destination) => {
      const job = createCronViewJob("current-job", { state: {} });
      const fallbackRequest = createRequest();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "cron.get") {
          if ((params as { id: string }).id === "removed-job") {
            throw new Error("Automation no longer exists");
          }
          return job;
        }
        if (method === "cron.list") {
          return cronListResponse([job]);
        }
        return fallbackRequest(method);
      });
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
      const page = createPage(createContext(gateway), { render: true });
      page.routeSearch = "?job=removed-job";
      await waitForCronPage(() =>
        expect(page.textContent).toContain("Automation no longer exists"),
      );

      if (destination === "another link") {
        page.routeSearch = "?job=current-job";
      } else {
        const selector =
          destination === "another row"
            ? '[data-test-id="cron-row-current-job"]'
            : '[data-test-id="cron-new-task"]';
        (page.querySelector(selector) as HTMLElement).click();
      }
      await waitForCronPage(() =>
        expect(
          destination === "a new task" ? page.cron.cronCreateOpen : page.cron.cronEditingJobId,
        ).toBe(destination === "a new task" ? true : job.id),
      );
      expect(page.cron.cronError).toBeNull();
      expect(page.textContent).not.toContain("Automation no longer exists");
    },
  );

  it("drops pending heartbeat scratch when admin access is removed", async () => {
    const job = createCronViewJob("heartbeat-job", {
      payload: { kind: "heartbeat" },
      sessionTarget: "main",
    });
    const scratch = createDeferred<object>();
    const request = vi.fn(async (method: string) =>
      method === "cron.list"
        ? cronListResponse([job])
        : method === "cron.scratch.get"
          ? scratch.promise
          : {},
    );
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });

    const row = `[data-test-id="cron-row-${job.id}"]`;
    await waitForCronPage(() => expect(page.querySelector(row)).not.toBeNull());
    (page.querySelector(`${row} .cron-table__name-text`) as HTMLElement).click();
    await waitForCronPage(() =>
      expect(request.mock.calls.filter(([method]) => method === "cron.scratch.get")).toHaveLength(
        1,
      ),
    );

    gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
    await page.updateComplete;
    scratch.resolve({
      scratch: { content: "private checklist", revision: 1, updatedAtMs: 1 },
      currentRevision: 1,
      maxBytes: 262_144,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;

    expect(page.cron.cronForm.payloadText).toBe("");
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
      gateway.emitSnapshot({ hello: operatorHello(scopes) });
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
          delivery: { mode: "none" },
        }),
      );
    });
  });

  it("scopes list and run history requests to the selected agent", async () => {
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

  it.each([false, true])("completes create & run now after navigation=%s", async (navigated) => {
    const addRequested = createDeferred();
    const added = createDeferred<{ id: string }>();
    const request = vi.fn(async (method: string) => {
      if (method === "cron.add") {
        addRequested.resolve();
        return added.promise;
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
    await addRequested.promise;
    const submittedState = page.cron;
    let currentPage = page;
    if (navigated) {
      page.remove();
      currentPage = createPage(createContext(gateway, "writer"));
      await currentPage.updateComplete;
    }
    added.resolve({ id: "job-fresh" });

    await waitForCronPage(() => {
      const methods = request.mock.calls.map((call) => call[0]);
      expect(methods.indexOf("cron.run")).toBeGreaterThan(methods.indexOf("cron.add"));
    });
    expect(request).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(request).toHaveBeenCalledWith("cron.run", { id: "job-fresh", mode: "force" });
    await waitForCronPage(() => expect(submittedState.cronCreateOpen).toBe(false));
    if (navigated) {
      expect(currentPage.cron).not.toBe(submittedState);
      expect(currentPage.cron.cronError).toBeNull();
    } else {
      await waitForCronPage(() =>
        expect(page.textContent).toContain("Run queued. Run ID: run-fresh"),
      );
    }
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

    gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
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
