/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { RunInspectorState } from "./run-inspector-model.ts";
import type { ActivityEntry } from "./tool-activity.ts";
import "./activity-page.ts";

type TestActivityPage = HTMLElement & {
  context: ApplicationContext;
  entries: ActivityEntry[];
  routeData: {
    mode: "run";
    selector: { kind: "run"; id: string };
    selectorId: string | null;
    decisionCursor: string | null;
  };
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
    subscribe: vi.fn(() => () => undefined),
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

afterEach(() => {
  localStorage.clear();
});

describe("ActivityPage gateway lifecycle", () => {
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
    page.routeData = {
      mode: "run",
      selector: { kind: "run", id: "run-1" },
      selectorId: null,
      decisionCursor: null,
    };

    await page.loadRunInspector(activeGateway, client, page.routeData.selector);

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
    page.routeData = {
      mode: "run",
      selector: { kind: "run", id: "run-1" },
      selectorId: "receipt-1",
      decisionCursor: "cursor-1",
    };

    await page.loadRunInspector(activeGateway, client, page.routeData.selector);

    expect(page.runInspector).toEqual({ status: "error", recovery });
  });
});
