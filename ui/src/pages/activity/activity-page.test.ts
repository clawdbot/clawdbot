/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
} from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import type { ActivityRouteData, RunInspectorState } from "./run-inspector-model.ts";
import type { ActivityEntry } from "./tool-activity.ts";
import * as liveActivity from "./view.ts";
import "./activity-page.ts";

type TestActivityPage = HTMLElement & {
  context: ApplicationContext;
  entries: ActivityEntry[];
  expandedIds: Set<string>;
  clearEntries: () => void;
  routeData: ActivityRouteData;
  render: () => unknown;
  runInspector: RunInspectorState;
  loadRunInspector: (
    gateway: ApplicationContext["gateway"],
    client: GatewayBrowserClient,
    selector: { kind: "run"; id: string },
  ) => Promise<void>;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
};

function gateway(): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    eventLog: [],
    eventLogRevision: 0,
    subscribe: vi.fn(() => () => undefined),
    subscribeEventLog: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

function staleEntry(): ActivityEntry {
  return {
    id: "stale",
    toolCallId: "stale",
    runId: "stale",
    toolName: "stale",
    entryKind: "tool",
    status: "done",
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    outputTruncated: false,
    summary: "stale",
    hiddenArgumentCount: 0,
  };
}

const activeGateways = new Set<ApplicationContext["gateway"]>();
const activePages = new Set<TestActivityPage>();

function activityHello(recoveryScope = "activity-owner-a"): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: ["operator.read"], recoveryScope },
  };
}

function activityGateway() {
  const store = createGatewayStoreTestStore({
    settings: {
      ...loadSettings(),
      gatewayUrl: "wss://activity.example.test",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
    },
  });
  activeGateways.add(store.gateway);
  store.gateway.start();
  store.current().opts.onHello?.(activityHello());
  return store;
}

function bindActivity(source: ApplicationContext["gateway"]): TestActivityPage {
  const page = document.createElement("openclaw-activity-page") as TestActivityPage;
  page.context = { gateway: source } as unknown as ApplicationContext;
  page.routeData = { mode: "live", selector: null };
  activePages.add(page);
  page.subscriptions.hostConnected();
  return page;
}

function toolEvent(id: string) {
  return createGatewayEvent("session.tool", {
    stream: "tool",
    runId: `run-${id}`,
    sessionKey: "main",
    data: {
      toolCallId: id,
      name: "read",
      phase: "result",
      result: { text: `${id} output` },
    },
  });
}

afterEach(() => {
  for (const page of activePages) {
    page.subscriptions.hostDisconnected();
  }
  for (const source of activeGateways) {
    source.stop();
  }
  activePages.clear();
  activeGateways.clear();
  setAvatarGatewayOrigin(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe("ActivityPage gateway lifecycle", () => {
  it.each(["sessions", "run"] as const)("skips Live Activity rendering in %s mode", (mode) => {
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { gateway: gateway(), basePath: "" } as unknown as ApplicationContext;
    page.entries = [staleEntry()];
    page.routeData =
      mode === "sessions"
        ? { mode, filters: { personId: null, query: "", time: "7d" }, selector: null }
        : { mode, selector: null, selectorId: null, decisionCursor: null };
    const render = vi.spyOn(liveActivity, "renderActivity");
    try {
      page.render();
      expect(render).not.toHaveBeenCalled();
      page.routeData = { mode: "live", selector: null };
      page.render();
      expect(render).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ entries: page.entries }),
      );
    } finally {
      render.mockRestore();
    }
  });

  it("replays the active gateway on initial bind and source replacement", () => {
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { gateway: gateway() } as unknown as ApplicationContext;
    page.entries = [staleEntry()];

    page.subscriptions.hostConnected();
    expect(page.entries).toEqual([]);

    page.entries = [staleEntry()];
    page.context = { gateway: gateway() } as unknown as ApplicationContext;
    page.subscriptions.hostUpdate();
    expect(page.entries).toEqual([]);

    page.subscriptions.hostDisconnected();
  });

  it.each(["gateway", "account"] as const)(
    "retires the mounted session's activity after a %s change",
    (change) => {
      const { gateway: source, current } = activityGateway();
      const page = bindActivity(source);
      current().opts.onEvent?.(toolEvent("old"));
      expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["old output"]);
      page.expandedIds.add(page.entries[0]!.id);

      if (change === "gateway") {
        source.connect({ gatewayUrl: "wss://other-activity.example.test" });
      } else {
        current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
        current().opts.onHello?.(activityHello("activity-owner-b"));
      }

      expect(page.entries).toEqual([]);
      expect(page.expandedIds.size).toBe(0);
      current().opts.onEvent?.(toolEvent("new"));
      expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["new output"]);
    },
  );

  it("keeps streamed previews and expansion across ordinary appends and reconnects", () => {
    const { gateway: source, current } = activityGateway();
    const page = bindActivity(source);
    current().opts.onEvent?.(toolEvent("first"));
    const firstId = page.entries[0]!.id;
    page.expandedIds.add(firstId);

    current().opts.onEvent?.(toolEvent("second"));
    source.connect();
    current().opts.onHello?.(activityHello());

    expect(page.entries.map((entry) => entry.outputPreview)).toEqual([
      "first output",
      "second output",
    ]);
    expect([...page.expandedIds]).toEqual([firstId]);
  });

  it.each(["stop", "event"] as const)(
    "retires activity when an earlier reset observer triggers a reentrant %s",
    (action) => {
      const { gateway: source, current } = activityGateway();
      let retiring = false;
      const unsubscribe = source.subscribeEventLog((events) => {
        if (!retiring || events.length > 0) {
          return;
        }
        retiring = false;
        if (action === "stop") {
          source.stop();
        } else {
          current().opts.onEvent?.(toolEvent("new"));
        }
      });
      try {
        const page = bindActivity(source);
        current().opts.onEvent?.(toolEvent("old"));
        retiring = true;

        source.connect({ gatewayUrl: "wss://other-activity.example.test" });

        expect(page.entries.map((entry) => entry.outputPreview)).toEqual(
          action === "stop" ? [] : ["new output"],
        );
        if (action === "stop") {
          expect(source.snapshot.phase).toBe("stopped");
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it("preserves manual Clear across navigation and unchanged reconnects", () => {
    const { gateway: source, current } = activityGateway();
    const firstPage = bindActivity(source);
    current().opts.onEvent?.(toolEvent("cleared"));
    firstPage.clearEntries();
    firstPage.subscriptions.hostDisconnected();

    const nextPage = bindActivity(source);
    expect(nextPage.entries).toEqual([]);
    source.connect();
    current().opts.onHello?.(activityHello());
    expect(nextPage.entries).toEqual([]);
    current().opts.onEvent?.(toolEvent("new"));
    expect(nextPage.entries.map((entry) => entry.outputPreview)).toEqual(["new output"]);
    nextPage.subscriptions.hostDisconnected();

    const revisitedPage = bindActivity(source);
    expect(revisitedPage.entries.map((entry) => entry.outputPreview)).toEqual(["new output"]);
  });

  it("stores the safe-only inspection response directly", async () => {
    const result = {
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        missingEvidence: ["run.record"],
        remediation: [],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["run.record"] },
    } satisfies AuditRunInspectResult;
    const client = { request: vi.fn(async () => result) } as unknown as GatewayBrowserClient;
    const activeGateway = {
      snapshot: { client, phase: "connected" },
    } as unknown as ApplicationContext["gateway"];
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { gateway: activeGateway } as unknown as ApplicationContext;
    const selector = { kind: "run", id: "run-1" } as const;
    page.routeData = {
      mode: "run",
      selector,
      selectorId: null,
      decisionCursor: null,
    };

    await page.loadRunInspector(activeGateway, client, selector);

    expect(page.runInspector.status).toBe("ready");
    if (page.runInspector.status === "ready") {
      expect(page.runInspector.result).toBe(result);
    }
  });

  it.each([
    [
      "protocol request",
      new GatewayProtocolRequestError({
        code: "INVALID_REQUEST",
        message: "decision cursor is no longer retained",
      }),
      "restart",
    ],
    [
      "UI Gateway request",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "decision cursor is no longer retained",
      }),
      "restart",
    ],
    [
      "retryable invalid request",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "temporarily unavailable",
        retryable: true,
      }),
      "retry",
    ],
    [
      "non-invalid request",
      new GatewayProtocolRequestError({ code: "UNAVAILABLE", message: "gateway unavailable" }),
      "retry",
    ],
  ] as const)("classifies a %s cursor failure", async (_label, error, recovery) => {
    const client = {
      request: vi.fn(() => Promise.reject(error)),
    } as unknown as GatewayBrowserClient;
    const activeGateway = {
      snapshot: { client, phase: "connected" },
    } as unknown as ApplicationContext["gateway"];
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { gateway: activeGateway } as unknown as ApplicationContext;
    const selector = { kind: "run", id: "run-1" } as const;
    page.routeData = {
      mode: "run",
      selector,
      selectorId: "receipt-1",
      decisionCursor: "cursor-1",
    };

    await page.loadRunInspector(activeGateway, client, selector);

    expect(page.runInspector).toEqual({ status: "error", recovery });
  });
});
