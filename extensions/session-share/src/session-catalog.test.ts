import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  sessionCatalogPaging,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import { describe, expect, it, vi } from "vitest";
import { createSessionShareCatalog } from "./session-catalog.js";

const commands = ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"];
const nativeSession: SessionCatalogSession = {
  threadId: "agent:main:shared",
  name: "Shared session",
  status: "idle",
  archived: false,
  canContinue: false,
  canArchive: false,
  canOpenTerminal: false,
};
const remoteIdentity = {
  type: "remote" as const,
  pluginId: "session-share",
  domain: "source",
  idKind: "github-account",
  id: "4242",
};

function catalogFixture() {
  const config: OpenClawConfig = {};
  const list = vi.fn<PluginRuntime["nodes"]["list"]>().mockResolvedValue({
    nodes: [{ nodeId: "alpha", displayName: " Alpha ", connected: true, commands }],
  });
  const invoke = vi
    .fn<PluginRuntime["nodes"]["invoke"]>()
    .mockImplementation(async ({ command }) =>
      command === commands[0]
        ? { payloadJSON: JSON.stringify({ sessions: [nativeSession] }) }
        : {
            payloadJSON: JSON.stringify({
              threadId: nativeSession.threadId,
              items: [{ type: "userMessage", text: "Published question" }],
            }),
          },
    );
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: { list, invoke },
  });
  const catalog = createSessionShareCatalog(createTestPluginApi({ runtime }));
  return {
    catalog,
    list,
    invoke,
  };
}

describe("session-share receiver catalog", () => {
  it.each(["openclaw", "node:alpha"])(
    "namespaces colliding profile claims by the invoked node, not wire domain %s",
    async (domain) => {
      const fixture = catalogFixture();
      fixture.list.mockResolvedValue({
        nodes: ["alpha", "beta"].map((nodeId) => ({ nodeId, commands, connected: true })),
      });
      const identity = { ...remoteIdentity, domain, idKind: "profile", id: "same-profile" };
      fixture.invoke.mockImplementation(async ({ command }) => ({
        payloadJSON: JSON.stringify(
          command === commands[0]
            ? {
                sessions: [{ ...nativeSession, createdActor: { type: "human", identity } }],
              }
            : {
                threadId: nativeSession.threadId,
                items: [{ type: "userMessage", text: "Question", sender: { identity } }],
              },
        ),
      }));
      const hosts = await fixture.catalog.list({});
      const pages = await Promise.all(
        hosts.map(({ hostId }) =>
          fixture.catalog.read({ hostId, threadId: nativeSession.threadId }),
        ),
      );
      const expected = [
        { ...identity, domain: "node:alpha" },
        { ...identity, domain: "node:beta" },
      ];
      expect.soft(hosts.map((host) => host.sessions[0]?.createdActor?.identity)).toEqual(expected);
      expect(pages.map((page) => page.items[0]?.sender?.identity)).toEqual(expected);
    },
  );

  it("publishes eligible hosts progressively, preserving failures and deterministic host order", async () => {
    const fixture = catalogFixture();
    const slow = createDeferred<unknown>();
    fixture.list.mockResolvedValue({
      nodes: [
        { nodeId: "slow", displayName: "Zulu", commands, connected: true },
        { nodeId: "partial", displayName: "Partial", commands: [commands[0]!], connected: true },
        { nodeId: "offline", displayName: "Bravo", commands, connected: false },
        { nodeId: "broken", displayName: "Charlie", commands, connected: true },
        { nodeId: "alpha", displayName: "Alpha", commands, connected: true },
      ],
    });
    fixture.invoke.mockImplementation(async ({ nodeId }) => {
      if (nodeId === "slow") {
        return slow.promise;
      }
      if (nodeId === "broken") {
        throw new Error("disconnected");
      }
      return { sessions: [nativeSession] };
    });
    const onHost = vi.fn();
    const pending = fixture.catalog.list({ onHost });
    await vi.waitFor(() => expect(onHost).toHaveBeenCalledTimes(3));
    expect(onHost.mock.calls.map(([host]) => host.hostId)).not.toContain("node:slow");
    slow.resolve({ sessions: [nativeSession] });
    const hosts = await pending;
    expect(hosts.map((host) => host.hostId)).toEqual([
      "node:alpha",
      "node:offline",
      "node:broken",
      "node:slow",
    ]);
    expect(hosts[1]?.error?.code).toBe("NODE_OFFLINE");
    expect(hosts[2]?.error?.code).toBe("NODE_INVOKE_FAILED");
    expect(onHost).toHaveBeenCalledTimes(4);
    expect(fixture.invoke.mock.calls.map(([request]) => request.nodeId).toSorted()).toEqual([
      "alpha",
      "broken",
      "slow",
    ]);
  });

  it("forwards filtered per-host pagination and uses the request-owned node snapshot", async () => {
    const fixture = catalogFixture();
    const cursor = sessionCatalogPaging.encodeCursor(20);
    fixture.invoke.mockResolvedValue({
      sessions: [nativeSession],
      nextCursor: sessionCatalogPaging.encodeCursor(21),
    });
    const listNodes = vi.fn<PluginRuntime["nodes"]["list"]>().mockResolvedValue({
      nodes: [
        { nodeId: "alpha", remoteIp: "127.0.0.2", commands, connected: true },
        { nodeId: "other", commands, connected: true },
      ],
    });
    const hosts = await fixture.catalog.list({
      hostIds: ["node:alpha"],
      search: "shared",
      limitPerHost: 3,
      cursors: { "node:alpha": cursor },
      listNodes,
    });
    expect(hosts).toEqual([
      expect.objectContaining({
        hostId: "node:alpha",
        label: "127.0.0.2",
        sessions: [nativeSession],
        nextCursor: sessionCatalogPaging.encodeCursor(21),
      }),
    ]);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.invoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        nodeId: "alpha",
        command: commands[0],
        params: { searchTerm: "shared", limit: 3, cursor },
      }),
    );
    expect(fixture.catalog.continueSession).toBeUndefined();
    expect(fixture.catalog.archive).toBeUndefined();
    expect(fixture.catalog.openTerminal).toBeUndefined();
  });

  it.each([
    { nodeId: "alpha", commands, connected: false },
    { nodeId: "alpha", commands: [commands[0]!], connected: true },
  ])("denies reads when the paired host is unavailable: %j", async (node) => {
    const fixture = catalogFixture();
    fixture.list.mockResolvedValue({ nodes: [node] });
    await expect(
      fixture.catalog.read({ hostId: "node:alpha", threadId: nativeSession.threadId }),
    ).rejects.toThrow("unavailable");
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "local profile",
      patch: { createdActor: { type: "human", identity: { type: "profile", id: "forged" } } },
    },
    { label: "long label", patch: { createdActor: { type: "human", label: "x".repeat(201) } } },
    { label: "unknown field", patch: { unexpected: true } },
    { label: "local adoption", patch: { sessionKey: "agent:main:local" } },
    { label: "write capability", patch: { canContinue: true } },
  ])("rejects node rows carrying $label", async ({ patch }) => {
    const fixture = catalogFixture();
    fixture.invoke.mockResolvedValue({
      payloadJSON: JSON.stringify({ sessions: [{ ...nativeSession, ...patch }] }),
    });
    const hosts = await fixture.catalog.list({});
    expect(hosts[0]).toMatchObject({ sessions: [], error: { code: "NODE_INVOKE_FAILED" } });
  });

  it.each([
    { sender: { identity: { type: "profile", id: "forged" } } },
    { sender: { identity: remoteIdentity, label: "x".repeat(201) } },
    { unexpected: true },
  ])("rejects transcript payload outside the closed wire identity contract: %j", async (patch) => {
    const fixture = catalogFixture();
    fixture.invoke.mockResolvedValue({
      payloadJSON: JSON.stringify({
        threadId: nativeSession.threadId,
        items: [{ type: "userMessage", text: "Question", ...patch }],
      }),
    });
    await expect(
      fixture.catalog.read({ hostId: "node:alpha", threadId: nativeSession.threadId }),
    ).rejects.toThrow("Invalid OpenClaw transcript");
  });
});
