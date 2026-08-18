// Control UI tests cover debug behavior.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./debug-page.ts";
import { renderDebug } from "./view.ts";

type DebugProps = Parameters<typeof renderDebug>[0];
const DIAGNOSTIC_METHODS = ["status", "health", "models.list", "last-heartbeat"] as const;
type DiagnosticMethod = (typeof DIAGNOSTIC_METHODS)[number];

type TestDebugPage = HTMLElement & {
  readonly updateComplete: Promise<boolean>;
  callDebugMethod: () => Promise<void>;
  context: ApplicationContext;
  debugCallError: string | null;
  debugCallMethod: string;
  debugCallResult: string | null;
  debugDiagnosticsError: string | null;
  debugHealth: unknown;
  debugHeartbeat: unknown;
  debugLanes: unknown[] | null;
  debugModels: unknown[];
  debugStatus: unknown;
  loadDiagnostics: () => Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function mountDebugPage(
  request: (method: string) => Promise<unknown>,
): Promise<TestDebugPage> {
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = {
    snapshot: { phase: "connected", client } as ApplicationGatewaySnapshot,
    eventLog: [],
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  const agentSelection = {
    state: { selectedId: "main" },
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agentSelection"];
  const page = document.createElement("openclaw-debug-page") as TestDebugPage;
  page.context = { agentSelection, basePath: "", gateway } as ApplicationContext;
  document.body.append(page);
  await vi.waitFor(() => expect(page.debugStatus).not.toBeNull());
  return page;
}

function diagnosticResponse(method: string, marker = "initial"): unknown {
  switch (method) {
    case "status":
      return { version: marker };
    case "health":
      return { marker, ok: true };
    case "models.list":
      return { models: [{ id: marker }] };
    case "last-heartbeat":
      return { source: marker };
    case "diagnostics.lanes":
      return {
        ts: 1,
        lanes: [
          {
            lane: marker,
            activeCount: 1,
            queuedCount: 2,
            maxConcurrent: 1,
            draining: false,
            generation: 0,
            blockedBy: "lane",
          },
        ],
      };
    default:
      throw new Error(`Unexpected diagnostics method: ${method}`);
  }
}

function expectSnapshots(page: TestDebugPage, marker: string): void {
  expect(page.debugStatus).toEqual({ version: marker });
  expect(page.debugHealth).toEqual({ marker, ok: true });
  expect(page.debugModels).toEqual([{ id: marker }]);
  expect(page.debugHeartbeat).toEqual({ source: marker });
}

function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    loading: false,
    status: null,
    health: null,
    models: [],
    heartbeat: null,
    lanes: [],
    diagnosticsError: null,
    eventLog: [],
    methods: [],
    callMethod: "",
    callParams: "{}",
    callResult: null,
    callError: null,
    onCallMethodChange: () => undefined,
    onCallParamsChange: () => undefined,
    onRefresh: () => undefined,
    onOpenOverlay: () => undefined,
    onCall: () => undefined,
    ...overrides,
  };
}

function normalizedText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/gu, " ").trim();
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.unstubAllGlobals();
});

describe("renderDebug", () => {
  it("keeps the security audit command styled as monospace", async () => {
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          status: {
            securityAudit: {
              summary: {
                critical: 0,
                warn: 1,
                info: 2,
              },
            },
          },
        }),
      ),
      container,
    );

    const command = container.querySelector<HTMLElement>(".settings-row__desc .mono");
    if (!command) {
      throw new Error("expected debug security audit command");
    }
    const status = container.querySelector(".settings-status");
    expect(status?.className).toContain("settings-status--warn");
    expect(normalizedText(status)).toBe("1 个警告 · 2 条信息");
    expect(command.textContent).toBe("openclaw security audit --deep");
  });

  it("does not render Invalid Date for Date-invalid event timestamps", () => {
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          eventLog: [
            {
              ts: 8_640_000_000_000_001,
              event: "gateway",
              payload: { ok: true },
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("gateway");
    expect(container.textContent).not.toContain("Invalid Date");
  });

  it("renders lane diagnostics as an emphasized table", () => {
    const container = document.createElement("div");
    render(
      renderDebug(
        createProps({
          lanes: [
            {
              lane: "main",
              activeCount: 2,
              queuedCount: 3,
              maxConcurrent: 2,
              draining: false,
              generation: 0,
              group: "interactive",
              groupActive: 2,
              groupBudget: 4,
              blockedBy: "lane",
            },
          ],
        }),
      ),
      container,
    );

    const row = container.querySelector(".command-lane-row");
    expect(row?.classList).toContain("command-lane-row--saturated");
    expect(row?.classList).toContain("command-lane-row--queued");
    expect(normalizedText(row)).toContain("main 2/2 3 interactive · 2/4 lane");
  });
});

describe("DebugPage", () => {
  it.each([
    { label: "response", staleError: false },
    { label: "error", staleError: true },
  ])(
    "ignores an older manual RPC $label after the latest call succeeds",
    async ({ staleError }) => {
      const older = deferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "manual.first") {
          return older.promise;
        }
        if (method === "manual.latest") {
          return { result: "latest response" };
        }
        return diagnosticResponse(method);
      });
      const page = await mountDebugPage(request);

      page.debugCallMethod = "manual.first";
      const olderCall = page.callDebugMethod();
      page.debugCallMethod = "manual.latest";
      await page.callDebugMethod();
      if (staleError) {
        older.reject(new Error("stale manual failure"));
      } else {
        older.resolve({ result: "stale response" });
      }
      await olderCall;

      expect(page.debugCallResult).toContain("latest response");
      expect(page.debugCallResult).not.toContain("stale response");
      expect(page.debugCallError).toBeNull();
    },
  );

  it.each(DIAGNOSTIC_METHODS)(
    "preserves every last-good snapshot and recovers after %s fails",
    async (failedMethod) => {
      let failure: DiagnosticMethod | null = null;
      let marker = "initial";
      const request = vi.fn(async (method: string) => {
        if (method === failure) {
          throw new Error(`${method} unavailable`);
        }
        return diagnosticResponse(method, marker);
      });
      const page = await mountDebugPage(request);
      expectSnapshots(page, "initial");

      marker = "uncommitted";
      failure = failedMethod;
      await page.loadDiagnostics();
      await page.updateComplete;

      expect(page.debugDiagnosticsError).toContain(`${failedMethod} unavailable`);
      expectSnapshots(page, "initial");
      const alert = page.querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.closest(".settings-section")?.querySelector("h2")?.textContent.trim()).toBe(
        "Snapshots",
      );
      expect(alert?.classList).toContain("settings-row");
      expect(page.querySelector(".callout")).toBeNull();

      marker = "recovered";
      failure = null;
      await page.loadDiagnostics();

      expect(page.debugDiagnosticsError).toBeNull();
      expectSnapshots(page, "recovered");
    },
  );

  it("keeps failed Manual RPC state separate from diagnostics failure and recovery", async () => {
    let diagnosticsUnavailable = false;
    const request = vi.fn(async (method: string) => {
      if (method === "manual.latest") {
        throw new Error("manual request failed");
      }
      if (method === "health" && diagnosticsUnavailable) {
        throw new Error("background snapshots unavailable");
      }
      return diagnosticResponse(method);
    });
    const page = await mountDebugPage(request);
    page.debugCallMethod = "manual.latest";
    await page.callDebugMethod();

    expect(page.debugCallError).toContain("manual request failed");
    expect(page.debugDiagnosticsError).toBeNull();

    diagnosticsUnavailable = true;
    await page.loadDiagnostics();

    expect(page.debugDiagnosticsError).toContain("background snapshots unavailable");
    expect(page.debugCallError).toContain("manual request failed");
  });

  it("keeps the page available when lane diagnostics are denied", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "diagnostics.lanes") {
        throw new Error("operator.read denied");
      }
      return diagnosticResponse(method);
    });
    const page = await mountDebugPage(request);
    await page.updateComplete;

    expect(page.debugStatus).toEqual({ version: "initial" });
    expect(page.debugDiagnosticsError).toBeNull();
    expect(page.debugLanes).toBeNull();
    expect(page.textContent).toContain("Lane diagnostics are unavailable");
  });
});
