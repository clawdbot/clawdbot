// Control UI tests cover debug behavior.
import { render, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { zh_CN } from "../../i18n/locales/zh-CN.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./debug-overlay.ts";
import "./debug-page.ts";
import type { SparklineSample } from "./sparkline-tile.ts";
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

type TestDebugOverlay = LitElement & {
  context: ApplicationContext;
  toggle: () => void;
};

type TestSparkline = LitElement & { samples: readonly SparklineSample[] };

async function updateOverlayVitals(overlay: TestDebugOverlay): Promise<void> {
  await overlay.updateComplete;
  for (const tile of overlay.querySelectorAll<TestSparkline>("openclaw-debug-sparkline")) {
    await tile.updateComplete;
  }
}

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
    const chinese = flattenTranslations(zh_CN);
    expect(status?.className).toContain("settings-status--warn");
    expect(normalizedText(status)).toBe(
      [
        chinese.get("debug.security.warnings")?.replace("{count}", "1"),
        chinese.get("debug.security.info")?.replace("{count}", "2"),
      ].join(" · "),
    );
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
    let diskResponse: "available" | "single" | "empty" | "legacy" | "missing" | "rejected" =
      "available";
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
        if (diskResponse === "rejected") {
          throw new Error("system info unavailable");
        }
        if (diskResponse === "legacy") {
          return { diskAvailableBytes: 500, diskTotalBytes: 1000, diskPath: "/legacy" };
        }
        if (diskResponse === "missing") {
          return {};
        }
        const disks = [
          {
            availableBytes: (700 - sampleCount) * 1_073_741_824,
            totalBytes: 1_000 * 1_073_741_824,
            path: "/",
          },
          {
            availableBytes: (300 - sampleCount * 2) * 1_073_741_824,
            totalBytes: 500 * 1_073_741_824,
            path: "/Volumes/Archive",
          },
        ];
        if (diskResponse === "single") {
          disks.pop();
        } else if (diskResponse === "empty") {
          disks.length = 0;
        }
        return { disks: sampleCount % 2 ? disks : disks.toReversed() };
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

      const vitalUpdated = () => updateOverlayVitals(overlay);
      await vitalUpdated();
      const diskTile = (mountPath: string) =>
        overlay.querySelector<TestSparkline>(`.debug-overlay__vital--disk[title="${mountPath}"]`);
      const rootDisk = diskTile("/");
      const archiveDisk = diskTile("/Volumes/Archive");

      // One sample: tiles show current values, charts wait for a second point.
      expect(overlay.querySelectorAll(".debug-overlay__vital")).toHaveLength(5);
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
      expect(normalizedText(diskTile("/"))).toContain("698 GB free");
      expect(normalizedText(diskTile("/"))).toContain("1000 GB total");
      expect(normalizedText(diskTile("/")?.querySelector(".debug-vital__label"))).toBe("Disk /");
      expect(
        normalizedText(diskTile("/Volumes/Archive")?.querySelector(".debug-vital__label")),
      ).toBe("Disk /Volumes/Archive");
      expect(normalizedText(diskTile("/Volumes/Archive"))).toContain("296 GB free");
      expect(normalizedText(diskTile("/Volumes/Archive"))).toContain("500 GB total");
      expect(diskTile("/")).toBe(rootDisk);
      expect(diskTile("/Volumes/Archive")).toBe(archiveDisk);
      expect(rootDisk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([699, 698]);
      expect(archiveDisk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([
        298, 296,
      ]);
      expect(overlay.querySelectorAll(".debug-vital__chart")).toHaveLength(5);
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

      expect(overlay.querySelectorAll(".debug-overlay__vital")).toHaveLength(5);
      expect(overlay.querySelector(".debug-vital__chart")).toBeNull();

      diskResponse = "single";
      await vi.advanceTimersByTimeAsync(2_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".debug-overlay__vital--disk")).toHaveLength(1);
      expect(diskTile("/")?.samples).toHaveLength(2);
      diskResponse = "available";
      await vi.advanceTimersByTimeAsync(2_000);
      await vitalUpdated();
      expect(diskTile("/")?.samples).toHaveLength(3);
      expect(diskTile("/Volumes/Archive")?.samples).toHaveLength(1);

      for (const response of ["empty", "legacy", "missing", "rejected"] as const) {
        diskResponse = response;
        await vi.advanceTimersByTimeAsync(2_000);
        await vitalUpdated();

        expect(overlay.querySelectorAll(".debug-overlay__vital")).toHaveLength(3);
        expect(overlay.querySelector(".debug-overlay__vital--disk")).toBeNull();
        for (const vital of ["cpu", "memory", "delay"]) {
          expect(overlay.querySelector(`.debug-overlay__vital--${vital}`)).not.toBeNull();
        }
      }
    } finally {
      overlay.remove();
      vi.useRealTimers();
    }
  });

  it.each(["same-client reconnect", "client replacement", "Gateway source replacement"])(
    "discards pending samples and prior disk history on %s",
    async (transition) => {
      vi.useFakeTimers();
      const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
      const pending = deferred<unknown>();
      const firstInfo = {
        disks: [
          { path: "/", totalBytes: 1000 * 1_073_741_824, availableBytes: 700 * 1_073_741_824 },
        ],
        diskPath: "/",
        diskTotalBytes: 1000 * 1_073_741_824,
        diskAvailableBytes: 700 * 1_073_741_824,
      };
      let infoResponse: unknown = firstInfo;
      const request = vi.fn(async (method: string) => {
        if (method === "system.info") {
          return infoResponse;
        }
        if (method === "sessions.list") {
          return { sessions: [] };
        }
        return diagnosticResponse(method);
      });
      const context = createDebugApplicationContext(request);
      let snapshot = context.gateway.snapshot;
      const gateway = {
        ...context.gateway,
        get snapshot() {
          return snapshot;
        },
        subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      const publishSnapshot = (next: ApplicationGatewaySnapshot) => {
        snapshot = next;
        for (const listener of listeners) {
          listener(snapshot);
        }
      };
      const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
      overlay.context = { ...context, gateway };
      document.body.append(overlay);
      try {
        overlay.toggle();
        await vi.advanceTimersByTimeAsync(2_000);
        await updateOverlayVitals(overlay);
        expect(
          overlay.querySelector<TestSparkline>(".debug-overlay__vital--disk")?.samples,
        ).toHaveLength(2);

        infoResponse = pending.promise;
        await vi.advanceTimersByTimeAsync(2_000);
        const callsBeforeTransition = request.mock.calls.filter(
          ([method]) => method === "system.info",
        ).length;
        infoResponse = {
          disks: [{ ...firstInfo.disks[0], availableBytes: 200 * 1_073_741_824 }],
          diskPath: "/",
          diskTotalBytes: firstInfo.diskTotalBytes,
          diskAvailableBytes: 200 * 1_073_741_824,
        };
        if (transition === "same-client reconnect") {
          publishSnapshot({ ...snapshot, phase: "reconnecting" });
          await overlay.updateComplete;
          expect(overlay.querySelector(".debug-overlay__vital--disk")).toBeNull();
          publishSnapshot({ ...snapshot, phase: "connected" });
        } else if (transition === "client replacement") {
          publishSnapshot({
            ...snapshot,
            client: createDebugApplicationContext(request).gateway.snapshot.client,
          });
        } else {
          overlay.context = { ...context, gateway: { ...gateway } };
          overlay.requestUpdate();
        }
        await vi.advanceTimersByTimeAsync(0);
        await updateOverlayVitals(overlay);
        expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(
          callsBeforeTransition + 1,
        );

        pending.resolve(firstInfo);
        await vi.advanceTimersByTimeAsync(0);
        await updateOverlayVitals(overlay);
        const disk = overlay.querySelector<TestSparkline>(".debug-overlay__vital--disk");
        expect(normalizedText(disk)).toContain("200 GB free");
        expect(disk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([200]);
        expect(disk?.querySelector("polyline")).toBeNull();

        await vi.advanceTimersByTimeAsync(2_000);
        await updateOverlayVitals(overlay);
        expect(disk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([200, 200]);
      } finally {
        overlay.remove();
        vi.useRealTimers();
      }
      expect(listeners.size).toBe(0);
    },
  );
});
