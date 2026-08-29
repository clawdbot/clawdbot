// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";

function catalog(id: string, hostCount: number): SessionCatalog {
  return {
    id,
    label: id,
    capabilities: { continueSession: true, archive: true },
    hosts: Array.from({ length: hostCount }, (_, hostIndex) => ({
      hostId: `${id}-host-${hostIndex}`,
      label: `Host ${hostIndex}`,
      kind: "node",
      connected: true,
      sessions: [
        {
          threadId: `${id}-thread-${hostIndex}`,
          name: `Session ${hostIndex}`,
          status: "idle",
          archived: false,
          canContinue: true,
          canArchive: true,
        },
      ],
    })),
  };
}

describe("SessionCatalogLiveState", () => {
  it("compares a host event only with the catalog and host it can replace", () => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const changed = catalog("changed", 1);
    const unrelated = catalog("unrelated", 100);
    Object.defineProperty(unrelated, "toJSON", {
      value: () => {
        throw new Error("unrelated catalog serialized");
      },
    });

    let result: ReturnType<SessionCatalogLiveState["applyHost"]>;
    expect(() => {
      result = live.applyHost({
        payload: {
          progressId,
          agentId: "main",
          catalog: { ...changed, hosts: [changed.hosts[0]!] },
        },
        agentId: "main",
        catalogs: [changed, unrelated],
        pageDepths: new Map(),
      });
    }).not.toThrow();
    expect(result!).toBeNull();
  });

  it.each([
    {
      metadata: "capabilities",
      update: (current: SessionCatalog): SessionCatalog => ({
        ...current,
        capabilities: {
          ...current.capabilities,
          createSession: { model: "openai/gpt-5.6-luna" },
        },
      }),
    },
    {
      metadata: "catalog error",
      update: (current: SessionCatalog): SessionCatalog => ({
        ...current,
        error: { code: "unavailable", message: "Catalog temporarily unavailable" },
      }),
    },
  ])("applies $metadata without marking a material change", ({ update }) => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = catalog("changed", 1);

    const result = live.applyHost({
      payload: {
        progressId,
        agentId: "main",
        catalog: { ...update(current), hosts: [current.hosts[0]!] },
      },
      agentId: "main",
      catalogs: [current],
      pageDepths: new Map(),
    });

    expect(result?.catalogs[0]).toEqual(update(current));
    expect(result?.materialChange).toBe(false);
    expect(live.sawChange).toBe(false);
  });

  it.each([
    ["mode-less client", { deviceId: "legacy-client" }, false],
    ["browser with a node role", { deviceId: "browser", mode: "webchat", roles: ["node"] }, false],
    [
      "operator with a node role",
      { deviceId: "operator", mode: "operator", roles: ["node"] },
      false,
    ],
    ["node with an operator role", { deviceId: "node", mode: "node", roles: ["operator"] }, true],
    ["legacy node role", { deviceId: "legacy-node", roles: ["node"] }, true],
  ] as const)("classifies %s presence for catalog refreshes", (_name, entry, expected) => {
    const live = new SessionCatalogLiveState();

    expect(live.observePresence({ presence: [entry] })).toBe(expected);
  });
});
