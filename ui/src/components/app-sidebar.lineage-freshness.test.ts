/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../api/types.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

describe("sidebar routed-lineage freshness", () => {
  it("refreshes canonical placement while retaining same-session presentation", async () => {
    const parentKey = "agent:main:parent";
    const key = "agent:main:device-child";
    const parent = {
      key: parentKey,
      kind: "direct" as const,
      updatedAt: 1,
      childSessions: [key],
    };
    const available = {
      key,
      kind: "direct" as const,
      sessionId: "session-device-child",
      parentSessionKey: parentKey,
      updatedAt: 2,
      derivedTitle: "My device session",
      lastMessagePreview: "Most recent message",
      placement: {
        state: "active" as const,
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: "worker:device",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "manifest",
        remoteWorkspaceDir: "/workspace",
        runner: { kind: "device" as const, status: "available" as const },
      },
    };
    const offline = {
      ...available,
      derivedTitle: undefined,
      lastMessagePreview: undefined,
      placement: {
        ...available.placement,
        runner: { kind: "device" as const, status: "offline" as const },
      },
    };
    const result = (selected: typeof available | typeof offline): SessionsListResult => ({
      ts: 2,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [parent, selected],
    });
    const gateway = createGateway(createTestGatewayClient(vi.fn()));
    const harness = createSessionsHarness("main", [parentKey, key]);
    harness.list.mockResolvedValue({ ...result(available), count: 1, sessions: [available] });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = key;
    harness.publishList({ result: result(available) });

    await waitForFast(() =>
      expect(sidebar.sessionData.activeSessionLineageSelectedRow?.placement).toMatchObject({
        runner: { kind: "device", status: "available" },
      }),
    );
    await waitForFast(() =>
      expect(sidebar.sessionData.childSessionRowsByParent[parentKey]?.[0]?.placement).toMatchObject(
        {
          runner: { kind: "device", status: "available" },
        },
      ),
    );
    harness.publishList({ result: result(offline) });

    expect(sidebar.sessionData.activeSessionLineageSelectedRow).toMatchObject({
      placement: { runner: { kind: "device", status: "offline" } },
      derivedTitle: "My device session",
      lastMessagePreview: "Most recent message",
    });
  });
});
