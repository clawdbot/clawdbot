/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import "./memory-import-page.ts";

type MemoryImportPageElement = HTMLElement & {
  updateComplete: Promise<boolean>;
  requestUpdate(): void;
};

function waitForMemoryImport(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

function createPlan(agentId = "research") {
  const workspace = `/tmp/openclaw-${agentId}`;
  return {
    agentId,
    workspace,
    providers: [
      {
        providerId: "codex",
        label: "Codex",
        description: "Import Codex memory.",
        planFingerprint: "a".repeat(64),
        found: true,
        source: "/tmp/codex",
        target: workspace,
        summary: {
          total: 1,
          planned: 1,
          migrated: 0,
          skipped: 0,
          conflicts: 0,
          errors: 0,
          sensitive: 0,
        },
        items: [
          {
            id: "memory:codex:MEMORY.md",
            status: "planned",
            source: "/tmp/codex/MEMORY.md",
            target: `${workspace}/memory/imports/codex/MEMORY.md`,
            details: {
              collectionId: "codex",
              collectionLabel: "Codex",
              relativePath: "MEMORY.md",
            },
          },
        ],
      },
    ],
  };
}

function createContext(request: ReturnType<typeof vi.fn>): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "research",
    sessionKey: "agent:research:main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    gateway: { snapshot, subscribe },
    agents: {
      state: {
        client,
        connected: true,
        agentsLoading: false,
        agentsError: null,
        agentsList: {
          defaultId: "research",
          agents: [{ id: "research", name: "Research" }],
        },
      },
      ensureList: vi.fn(),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: "research" },
      set: vi.fn(),
      subscribe,
    },
  } as unknown as ApplicationContext;
}

async function mountPage(context: ApplicationContext): Promise<MemoryImportPageElement> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-memory-import-page") as MemoryImportPageElement;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MemoryImportPage", () => {
  it("settles a failed roster load until Refresh retries it", async () => {
    const roster = createDeferredCore<unknown>();
    const request = vi.fn((method: string) =>
      method === "agents.list" ? roster.promise : Promise.resolve(createPlan()),
    );
    const context = createContext(request);
    const agents = createAgentCapability(context.gateway);
    // The application shell owns the initial shared roster request.
    const initial = agents.ensureList();
    const page = await mountPage({ ...context, agents });
    try {
      roster.reject(new Error("Agent roster unavailable"));
      request.mockImplementation((method: string) =>
        method === "agents.list" ? createDeferredCore().promise : Promise.resolve(createPlan()),
      );
      await initial;
      await page.updateComplete;
      await page.updateComplete;
      expect(request).toHaveBeenCalledTimes(1);
      expect(page.textContent).toContain("Agent roster unavailable");

      request.mockImplementation((method: string) =>
        Promise.resolve(
          method === "agents.list"
            ? { defaultId: "research", agents: [{ id: "research", name: "Research" }] }
            : createPlan(),
        ),
      );
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Refresh")
        ?.click();
      await waitForMemoryImport(() =>
        expect(page.querySelector("[data-test-id='memory-import-provider-button']")).not.toBeNull(),
      );
      expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(2);
      expect(page.textContent).not.toContain("Agent roster unavailable");
      request.mockImplementation((method: string) =>
        method === "agents.list"
          ? Promise.reject(new Error("Agent roster unavailable"))
          : Promise.resolve(createPlan()),
      );
      await agents.refreshList();
      await page.updateComplete;
      expect(page.textContent).not.toContain("Agent roster unavailable");
      expect(page.querySelector("[data-test-id='memory-import-provider-button']")).not.toBeNull();
    } finally {
      page.parentElement?.remove();
      agents.dispose();
    }
  });

  it("does not plan memory import without admin access", async () => {
    const request = vi.fn();
    const context = createContext(request);
    context.gateway.snapshot.hello = {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      features: { methods: ["migrations.memory.plan"] },
    } as ApplicationGatewaySnapshot["hello"];
    const page = await mountPage(context);

    await page.updateComplete;
    expect(request).not.toHaveBeenCalled();
    expect(page.textContent).toContain("Memory import requires operator.admin access.");
  });

  it("keeps a failed plan stable until the operator explicitly refreshes", async () => {
    const request = vi.fn(async () => {
      throw new Error("planning unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
    });
    const page = await mountPage(createContext(request));

    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(1));
    await page.updateComplete;
    await Promise.resolve();
    await page.updateComplete;
    expect(request).toHaveBeenCalledTimes(1);
    expect(page.textContent).toContain("planning unavailable: OPENAI_API_KEY=sk-123...cdef");
    expect(page.textContent).not.toContain("sk-1234567890abcdef");

    const refresh = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    if (!refresh) {
      throw new Error("expected Refresh button");
    }
    refresh.click();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("keeps apply recovery results visible when the follow-up plan fails", async () => {
    let planRequests = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        planRequests += 1;
        if (planRequests > 1) {
          throw new Error("post-apply planning unavailable");
        }
        return createPlan();
      }
      if (method === "migrations.memory.apply") {
        return {
          providerId: "codex",
          source: "/tmp/codex",
          summary: {
            total: 1,
            planned: 0,
            migrated: 0,
            skipped: 0,
            conflicts: 0,
            errors: 1,
            sensitive: 0,
          },
          items: [
            {
              id: "memory:codex:MEMORY.md",
              status: "error",
              reason: "replacement interrupted",
              details: {
                recoveryRecordPath: "/tmp/migration-report/recovery-required.json",
              },
            },
          ],
          reportDir: "/tmp/migration-report",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));

    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
      ?.click();
    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']"),
      ).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();

    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(3));
    await page.updateComplete;
    expect(page.textContent).toContain("post-apply planning unavailable");
    expect(page.textContent).toContain("replacement interrupted");
    expect(page.textContent).toContain("/tmp/migration-report");
    expect(
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
        ?.disabled,
    ).toBe(true);
  });

  it("unlocks the page after a successful import refresh", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "migrations.memory.apply") {
        return {
          providerId: "codex",
          source: "/tmp/codex",
          summary: {
            total: 1,
            planned: 0,
            migrated: 1,
            skipped: 0,
            conflicts: 0,
            errors: 0,
            sensitive: 0,
          },
          items: [{ id: "memory:codex:MEMORY.md", status: "migrated" }],
          reportDir: "/tmp/migration-report",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));

    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
      ?.click();
    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']"),
      ).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();

    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
          ?.disabled,
      ).toBe(false),
    );
  });

  it("reuses the same frozen idempotency key when a failed apply is retried", async () => {
    let applyRequests = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "migrations.memory.apply") {
        applyRequests += 1;
        if (applyRequests === 1) {
          throw new Error("response lost");
        }
        return {
          providerId: "codex",
          source: "/tmp/codex",
          summary: {
            total: 1,
            planned: 0,
            migrated: 1,
            skipped: 0,
            conflicts: 0,
            errors: 0,
            sensitive: 0,
          },
          items: [{ id: "memory:codex:MEMORY.md", status: "migrated" }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));

    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
      ?.click();
    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']"),
      ).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();
    await waitForMemoryImport(() => expect(page.textContent).toContain("response lost"));
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();

    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(4));
    const firstApply = request.mock.calls[1]?.[1] as { idempotencyKey?: string } | undefined;
    const retryApply = request.mock.calls[2]?.[1] as { idempotencyKey?: string } | undefined;
    expect(firstApply?.idempotencyKey).toMatch(/\S/u);
    expect(retryApply).toEqual(firstApply);
  });

  it("clears confirmation state across a gateway disconnect", async () => {
    const request = vi.fn(async (method: string, params: { agentId?: string }) => {
      if (method === "migrations.memory.plan") {
        return createPlan(params.agentId ?? "research");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const context = createContext(request);
    const page = await mountPage(context);

    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
      ?.click();
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-import-confirm']")).not.toBeNull(),
    );

    context.gateway.snapshot.phase = "stopped";
    page.requestUpdate();
    await page.updateComplete;
    await page.updateComplete;
    expect(page.querySelector("[data-test-id='memory-import-confirm']")).toBeNull();

    const replacementClient = { request } as unknown as GatewayBrowserClient;
    context.gateway.snapshot.client = replacementClient;
    context.gateway.snapshot.phase = "connected";
    page.requestUpdate();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(2));
    expect(page.querySelector("[data-test-id='memory-import-confirm']")).toBeNull();
  });

  it("preserves an attempted import key across a gateway disconnect", async () => {
    const result = {
      providerId: "codex",
      source: "/tmp/codex",
      summary: {
        total: 1,
        planned: 0,
        migrated: 1,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [{ id: "memory:codex:MEMORY.md", status: "migrated" }],
    };
    let finishFirstApply!: (value: typeof result) => void;
    let applyRequests = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "migrations.memory.apply") {
        applyRequests += 1;
        if (applyRequests === 1) {
          return await new Promise<typeof result>((resolve) => {
            finishFirstApply = resolve;
          });
        }
        return result;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const context = createContext(request);
    const page = await mountPage(context);

    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
      ?.click();
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-import-confirm']")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(2));
    const firstApply = request.mock.calls[1]?.[1] as { idempotencyKey?: string } | undefined;

    context.gateway.snapshot.phase = "stopped";
    context.gateway.snapshot.client = null;
    page.requestUpdate();
    await page.updateComplete;
    expect(page.querySelector("[data-test-id='memory-import-confirm']")).toBeNull();
    finishFirstApply(result);
    await Promise.resolve();

    const replacementClient = { request } as unknown as GatewayBrowserClient;
    context.gateway.snapshot.client = replacementClient;
    context.gateway.snapshot.phase = "connected";
    page.requestUpdate();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-import-confirm']")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(4));

    const retryApply = request.mock.calls[3]?.[1] as { idempotencyKey?: string } | undefined;
    expect(firstApply?.idempotencyKey).toMatch(/\S/u);
    expect(retryApply).toEqual(firstApply);
  });

  it("drops pending state and rejects confirmation when shared agent selection changes", async () => {
    const request = vi.fn(async (method: string, params: { agentId?: string }) => {
      if (method === "migrations.memory.plan") {
        return createPlan(params.agentId ?? "research");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const context = createContext(request);
    const mutableContext = context as unknown as {
      agents: {
        state: {
          agentsList: {
            defaultId: string;
            agents: Array<{ id: string; name: string }>;
          };
        };
      };
      agentSelection: { state: { selectedId: string } };
    };
    mutableContext.agents.state.agentsList.agents.push({ id: "writer", name: "Writer" });
    const page = await mountPage(context);

    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
      ?.click();
    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']"),
      ).not.toBeNull(),
    );

    mutableContext.agentSelection.state.selectedId = "writer";
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();
    expect(request).toHaveBeenCalledTimes(1);

    page.requestUpdate();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "writer" });
    expect(page.querySelector("[data-test-id='memory-import-confirm']")).toBeNull();
  });

  it("previews past-session candidates with the selected date range", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "memory.sessionBackfill.preview") {
        return {
          days: 1,
          candidates: 2,
          staged: 0,
          truncated: true,
          perDay: [
            { day: "2026-07-01", candidateCount: 2, sample: ["First memory", "Second memory"] },
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-preview']")).not.toBeNull(),
    );
    const dates = page.querySelectorAll<HTMLInputElement>(
      ".memory-import__backfill-dates input[type='date']",
    );
    dates[0]!.value = "2026-07-01";
    dates[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    dates[1]!.value = "2026-07-31";
    dates[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-preview']")?.click();

    await waitForMemoryImport(() => expect(page.textContent).toContain("First memory"));
    expect(page.textContent).toContain("preview shows the first bounded batch");
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.preview",
      { agentId: "research", from: "2026-07-01", to: "2026-07-31", limitDays: 14 },
    ]);
  });

  it("applies backfill chunks until a call returns zero new candidates", async () => {
    let applyCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "memory.sessionBackfill.apply") {
        applyCalls += 1;
        if (applyCalls === 1) {
          return {
            days: 2,
            candidates: 3,
            staged: 2,
            perDay: [{ day: "2026-07-01", candidateCount: 3, sample: [] }],
            cursor: { advanced: true, exhausted: false, hasMore: true },
          };
        }
        if (applyCalls === 2) {
          return {
            days: 1,
            candidates: 1,
            staged: 1,
            perDay: [{ day: "2026-07-01", candidateCount: 1, sample: [] }],
            cursor: { advanced: true, exhausted: false, hasMore: false },
          };
        }
        return {
          days: 0,
          candidates: 0,
          staged: 0,
          perDay: [],
          cursor: { advanced: false, exhausted: true, hasMore: false },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-apply']")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-apply']")?.click();

    await waitForMemoryImport(() =>
      expect(page.textContent).toContain("3 staged; promotion happens via dreaming"),
    );
    expect(applyCalls).toBe(3);
    expect(page.textContent).toContain("4 session candidates processed");
    expect(page.textContent).toContain("1 day processed");

    const from = page.querySelector<HTMLInputElement>(
      ".memory-import__backfill-dates input[type='date']",
    );
    if (!from) {
      throw new Error("expected backfill from-date input");
    }
    from.value = "2026-07-01";
    from.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    expect(page.textContent).not.toContain("3 staged; promotion happens via dreaming");
  });

  it("confirms rollback and surfaces gateway errors", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "memory.sessionBackfill.rollback") {
        throw new Error("rollback unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-rollback']")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback']")?.click();
    await waitForMemoryImport(() =>
      expect(
        page.querySelector("[data-test-id='memory-backfill-rollback-confirm']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback-confirm']")
      ?.click();

    await waitForMemoryImport(() => expect(page.textContent).toContain("rollback unavailable"));
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.rollback",
      { agentId: "research" },
    ]);
  });
});
