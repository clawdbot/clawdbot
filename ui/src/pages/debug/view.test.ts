// Control UI tests cover debug behavior.
import { render, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./debug-overlay.ts";
import "./debug-page.ts";
import { renderDebug } from "./view.ts";

type DebugProps = Parameters<typeof renderDebug>[0];
const DIAGNOSTIC_METHODS = [
  "diagnostics.lanes",
  "status",
  "health",
  "models.list",
  "last-heartbeat",
] as const;
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
  debugLanes: unknown[];
  debugModels: unknown[];
  debugStatus: unknown;
  loadDiagnostics: () => Promise<void>;
};

type TestDebugOverlay = HTMLElement & {
  readonly updateComplete: Promise<boolean>;
  context: ApplicationContext;
  toggle: () => void;
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

function createDebugApplicationContext(
  request: (method: string) => Promise<unknown>,
): ApplicationContext {
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
  return { agentSelection, basePath: "", gateway } as ApplicationContext;
}

async function mountDebugPage(
  request: (method: string) => Promise<unknown>,
): Promise<TestDebugPage> {
  const page = document.createElement("openclaw-debug-page") as TestDebugPage;
  page.context = createDebugApplicationContext(request);
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
        dynamic: null,
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
  expect(page.debugLanes).toEqual([expect.objectContaining({ lane: marker })]);
}

function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    loading: false,
    status: null,
    health: null,
    models: [],
    heartbeat: null,
    lanes: [],
    dynamic: null,
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
          dynamic: {
            laneCount: 23,
            activeCount: 9,
            queuedCount: 4,
            queuedLaneCount: 3,
          },
        }),
      ),
      container,
    );

    const row = container.querySelector(".command-lane-row");
    expect(row?.classList).toContain("command-lane-row--saturated");
    expect(row?.classList).toContain("command-lane-row--queued");
    expect(normalizedText(row)).toContain("main 2/2 3 interactive · 2/4 lane");
    expect(normalizedText(container.querySelector(".command-lane-row--dynamic"))).toContain(
      "Session lanes · 23 9 4 —",
    );
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
});

describe("DebugOverlay", () => {
  it("graphs bounded status samples without clamping CPU and resets history on reopen", async () => {
    vi.useFakeTimers();
    let sampleCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "status") {
        sampleCount += 1;
        return {
          eventLoop: {
            utilization: 0.42,
            cpuCoreRatio: 1 + sampleCount / 10,
            delayP99Ms: 10 + sampleCount,
            delayMaxMs: 87,
          },
          processMemory: {
            rssBytes: (400 + sampleCount) * 1_048_576,
            heapUsedBytes: 100 * 1_048_576,
            heapTotalBytes: 200 * 1_048_576,
          },
        };
      }
      if (method === "system.info") {
        return {
          diskAvailableBytes: (700 - sampleCount) * 1_073_741_824,
          diskTotalBytes: 1_000 * 1_073_741_824,
          diskPath: "/var/lib/openclaw",
        };
      }
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      return diagnosticResponse(method);
    });
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = createDebugApplicationContext(request);
    document.body.append(overlay);

    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(0);
      await overlay.updateComplete;

      const vitalUpdated = async () => {
        await overlay.updateComplete;
        for (const tile of overlay.querySelectorAll("openclaw-debug-sparkline")) {
          await (tile as LitElement).updateComplete;
        }
      };
      await vitalUpdated();

      // One sample: tiles show current values, charts wait for a second point.
      expect(overlay.querySelectorAll(".debug-overlay__vital")).toHaveLength(4);
      expect(normalizedText(overlay.querySelector(".debug-overlay__vital--cpu"))).toContain(
        "loop 42%",
      );
      expect(overlay.querySelector(".debug-vital__chart")).toBeNull();

      await vi.advanceTimersByTimeAsync(2_000);
      await vitalUpdated();

      expect(normalizedText(overlay.querySelector(".debug-overlay__vital--cpu"))).toContain("120%");
      expect(normalizedText(overlay.querySelector(".debug-overlay__vital--memory"))).toContain(
        "402 MB",
      );
      expect(normalizedText(overlay.querySelector(".debug-overlay__vital--memory"))).toContain(
        "heap 100 MB",
      );
      expect(normalizedText(overlay.querySelector(".debug-overlay__vital--delay"))).toContain(
        "12ms",
      );
      expect(normalizedText(overlay.querySelector(".debug-overlay__vital--delay"))).toContain(
        "max 87ms",
      );
      expect(normalizedText(overlay.querySelector(".debug-overlay__vital--disk"))).toContain(
        "698 GB free",
      );
      expect(normalizedText(overlay.querySelector(".debug-overlay__vital--disk"))).toContain(
        "1000 GB total",
      );
      expect(overlay.querySelector(".debug-overlay__vital--disk")?.getAttribute("title")).toBe(
        "/var/lib/openclaw",
      );
      expect(overlay.querySelectorAll(".debug-vital__chart")).toHaveLength(4);
      // Healthy event loop: no tile carries the degraded tint.
      expect(overlay.querySelector(".debug-overlay__vital[data-degraded]")).toBeNull();

      await vi.advanceTimersByTimeAsync(180_000);
      await vitalUpdated();

      const points = overlay
        .querySelector(".debug-overlay__vital--cpu polyline")
        ?.getAttribute("points")
        ?.split(" ");
      expect(points).toHaveLength(90);

      overlay.toggle();
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(0);
      await vitalUpdated();

      expect(overlay.querySelectorAll(".debug-overlay__vital")).toHaveLength(4);
      expect(overlay.querySelector(".debug-vital__chart")).toBeNull();
    } finally {
      overlay.remove();
      vi.useRealTimers();
    }
  });
});
