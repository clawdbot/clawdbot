// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { publishActiveSessionLineage } from "../../components/app-sidebar-child-session-data.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:device-session";

function placement(status: "available" | "offline") {
  return {
    state: "active" as const,
    generation: 4,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId: "environment-device",
    activeOwnerEpoch: 7,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "manifest-device",
    remoteWorkspaceDir: "/workspace",
    runner: { kind: "device" as const, status },
  };
}

function capabilityWithList(result: ReturnType<typeof sessionsResult>) {
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return result;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  return createTestSessionCapability(createGatewayHarness(client).gateway);
}

describe("supplemental session reconciliation", () => {
  it("publishes an owner change but not unchanged lineage rows and defaults", async () => {
    const canonical = {
      key,
      kind: "direct" as const,
      sessionId: "session-device",
      updatedAt: 10,
    };
    const sessions = capabilityWithList(sessionsResult([canonical], 10));
    try {
      await sessions.refresh({ force: true });
      const published = vi.fn();
      sessions.subscribe(published);
      const result = sessions.state.result;
      sessions.reconcile(canonical, result?.defaults, { resultAgentId: "main" });
      expect(sessions.state.result).toBe(result);
      expect(sessions.state.agentId).toBe("main");
      expect(published).toHaveBeenCalledOnce();
      published.mockClear();
      const owner = {
        activeSessionLineageRoot: null,
        activeSessionLineageSelectedRow: null,
        childSessionRowsByParent: {},
        context: { sessions },
        sessionsResult: sessions.state.result,
      };

      publishActiveSessionLineage(
        owner,
        key,
        { rowsByParent: {}, topmostRow: canonical, lookupFailed: false },
        sessions.canonicalListRevision,
      );

      expect(owner.activeSessionLineageSelectedRow).toEqual(canonical);
      expect(sessions.state.result?.sessions).toEqual([canonical]);
      expect(published).not.toHaveBeenCalled();
    } finally {
      sessions.dispose();
    }
  });

  it("preserves a matching canonical row when history started before its list", async () => {
    const sessions = capabilityWithList(
      sessionsResult(
        [
          {
            key,
            kind: "direct",
            sessionId: "session-device",
            updatedAt: 10,
            placement: placement("offline"),
          },
        ],
        10,
      ),
    );
    const sourceCanonicalListRevision = sessions.canonicalListRevision;

    await sessions.refresh({ force: true });
    const published = vi.fn();
    sessions.subscribe(published);
    sessions.reconcile(
      {
        key,
        kind: "direct",
        sessionId: "session-device",
        updatedAt: 10,
        placement: placement("available"),
      },
      { modelProvider: "openai", model: "gpt-5.6-luna", contextTokens: 128_000 },
      { sourceCanonicalListRevision },
    );

    expect(sessions.state.result?.sessions[0]?.placement).toMatchObject({
      runner: { kind: "device", status: "offline" },
    });
    expect(sessions.state.result?.defaults).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      contextTokens: 128_000,
    });
    expect(published).toHaveBeenCalledOnce();
    sessions.dispose();
  });

  it("adds a routed row absent from a newer canonical list", async () => {
    const sessions = capabilityWithList(sessionsResult([], 10));
    const sourceCanonicalListRevision = sessions.canonicalListRevision;

    await sessions.refresh({ force: true });
    sessions.reconcile(
      {
        key: "agent:main:archived-routed",
        kind: "direct",
        sessionId: "session-routed",
        updatedAt: 10,
        archived: true,
      },
      undefined,
      { archivedFilter: "all", sourceCanonicalListRevision },
    );

    expect(sessions.state.result?.sessions).toEqual([
      expect.objectContaining({
        key: "agent:main:archived-routed",
        archived: true,
        sessionId: "session-routed",
      }),
    ]);
    sessions.dispose();
  });

  it("keeps a newer canonical placement when an older sidebar lineage finishes", async () => {
    const canonical = {
      key,
      kind: "direct" as const,
      sessionId: "session-device",
      updatedAt: 10,
      placement: placement("offline"),
    };
    const sessions = capabilityWithList(sessionsResult([canonical], 10));
    const sourceCanonicalListRevision = sessions.canonicalListRevision;
    await sessions.refresh({ force: true });
    const cached = {
      ...canonical,
      updatedAt: 20,
      derivedTitle: "My device session",
      lastMessagePreview: "Most recent message",
      placement: placement("available"),
    };
    const owner = {
      activeSessionLineageRoot: null,
      activeSessionLineageSelectedRow: cached,
      childSessionRowsByParent: { "agent:main:parent": [cached] },
      context: { sessions },
      sessionsResult: sessions.state.result,
    };

    publishActiveSessionLineage(
      owner,
      key,
      {
        rowsByParent: { "agent:main:parent": [cached] },
        topmostRow: cached,
        lookupFailed: false,
      },
      sourceCanonicalListRevision,
    );

    expect(sessions.state.result?.sessions[0]?.placement).toEqual(placement("offline"));
    expect(owner.activeSessionLineageSelectedRow).toMatchObject({
      placement: placement("offline"),
      derivedTitle: "My device session",
      lastMessagePreview: "Most recent message",
    });
    sessions.dispose();
  });

  it("publishes an archived lineage missing from a newer canonical list", async () => {
    const sessions = capabilityWithList(sessionsResult([], 10));
    const sourceCanonicalListRevision = sessions.canonicalListRevision;
    await sessions.refresh({ force: true });
    const archived = {
      key: "agent:main:archived-routed",
      kind: "direct" as const,
      sessionId: "session-routed",
      updatedAt: 10,
      archived: true,
    };
    const owner = {
      activeSessionLineageRoot: null,
      activeSessionLineageSelectedRow: null,
      childSessionRowsByParent: {},
      context: { sessions },
      sessionsResult: sessions.state.result,
    };

    publishActiveSessionLineage(
      owner,
      archived.key,
      { rowsByParent: {}, topmostRow: archived, lookupFailed: false },
      sourceCanonicalListRevision,
    );

    expect(sessions.state.result?.sessions).toEqual([archived]);
    sessions.dispose();
  });
});
