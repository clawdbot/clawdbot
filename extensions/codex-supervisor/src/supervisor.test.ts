// Codex Supervisor tests cover supervisor plugin behavior.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { loadCodexSupervisorEndpoints, resolveCodexSupervisorPluginConfig } from "./config.js";
import {
  connectCodexAppServerEndpoint,
  resolveCodexSupervisorStdioSpawnInvocation,
  resolveSafeApprovalResult,
} from "./json-rpc-client.js";
import { CodexSupervisor } from "./supervisor.js";
import type { CodexJsonRpcConnection, CodexSupervisorEndpoint } from "./types.js";

class FakeCodexConnection implements CodexJsonRpcConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCount = 0;

  constructor(
    private thread: Record<string, unknown>,
    private readonly failIncludeTurnsUntilMaterialized = false,
  ) {}

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/loaded/list") {
      return { data: [this.thread.id].filter((id) => typeof id === "string"), nextCursor: null };
    }
    if (method === "thread/list") {
      return { threads: [this.thread] };
    }
    if (method === "thread/read") {
      if (this.failIncludeTurnsUntilMaterialized && params?.includeTurns === true) {
        throw new Error(
          "thread is not materialized yet; includeTurns is unavailable before first user message",
        );
      }
      return { thread: this.thread };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-started", status: "inProgress" } };
    }
    if (method === "turn/steer") {
      return {};
    }
    if (method === "turn/interrupt") {
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  }

  notify(): void {}

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

const endpoint: CodexSupervisorEndpoint = {
  id: "local",
  transport: "stdio-proxy",
};

describe("loadCodexSupervisorEndpoints", () => {
  it("defaults to the local app-server Unix websocket", () => {
    expect(loadCodexSupervisorEndpoints({})).toEqual([
      {
        id: "local",
        label: "local Codex app-server daemon",
        transport: "websocket",
        url: "unix://",
      },
    ]);
  });

  it("parses websocket shorthand endpoints", () => {
    expect(
      loadCodexSupervisorEndpoints({
        OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS: "crab=ws://127.0.0.1:18080,local",
      }),
    ).toEqual([
      {
        id: "crab",
        transport: "websocket",
        url: "ws://127.0.0.1:18080",
      },
      {
        id: "local",
        label: "local Codex app-server daemon",
        transport: "websocket",
        url: "unix://",
      },
    ]);
  });

  it("keeps equals signs inside endpoint URLs", () => {
    expect(
      loadCodexSupervisorEndpoints({
        OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS: "prod=wss://example.invalid/control?token=a=b&next=c",
      }),
    ).toEqual([
      {
        id: "prod",
        transport: "websocket",
        url: "wss://example.invalid/control?token=a=b&next=c",
      },
    ]);
  });

  it("does not derive generated endpoint ids from secret-bearing URLs", () => {
    expect(
      loadCodexSupervisorEndpoints({
        OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS: "wss://user:secret@example.invalid/control?token=a=b",
      }),
    ).toEqual([
      {
        id: "endpoint-1",
        transport: "websocket",
        url: "wss://user:secret@example.invalid/control?token=a=b",
      },
    ]);
    expect(
      loadCodexSupervisorEndpoints({
        OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS: JSON.stringify([
          {
            transport: "websocket",
            url: "wss://example.invalid/control?token=secret",
          },
        ]),
      }),
    ).toEqual([
      {
        id: "endpoint-1",
        transport: "websocket",
        url: "wss://example.invalid/control?token=secret",
      },
    ]);
  });

  it("rejects duplicate normalized endpoint ids", () => {
    expect(() =>
      loadCodexSupervisorEndpoints({
        OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS: "fleet/a=ws://one.invalid,fleet-a=ws://two.invalid",
      }),
    ).toThrow("duplicate Codex supervisor endpoint id: fleet-a");
    expect(() =>
      resolveCodexSupervisorPluginConfig({
        endpoints: [
          { id: "fleet/a", transport: "websocket", url: "ws://one.invalid" },
          { id: "fleet-a", transport: "websocket", url: "ws://two.invalid" },
        ],
      }),
    ).toThrow("duplicate Codex supervisor endpoint id: fleet-a");
  });

  it("prefers plugin-configured endpoints over environment defaults", () => {
    expect(
      resolveCodexSupervisorPluginConfig(
        {
          endpoints: [
            {
              id: "fleet",
              transport: "websocket",
              url: "wss://fleet.example.invalid/codex",
            },
          ],
          allowRawTranscripts: true,
          allowWriteControls: true,
        },
        {
          OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS: "local",
        },
      ),
    ).toEqual({
      endpoints: [
        {
          id: "fleet",
          transport: "websocket",
          url: "wss://fleet.example.invalid/codex",
        },
      ],
      allowRawTranscripts: true,
      allowWriteControls: true,
    });
  });
});

describe("CodexSupervisor", () => {
  it("lists a metadata-only App Server catalog page across all providers", async () => {
    const fake = new FakeCodexConnection({ id: "unused" });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method !== "thread/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        data: [
          {
            id: "thread-1",
            sessionId: "session-1",
            name: "Catalog work",
            preview: "private first user message",
            cwd: "/workspace",
            status: { type: "active", activeFlags: ["waitingOnUserInput"] },
            createdAt: 10,
            updatedAt: 20,
            recencyAt: 21,
            source: { custom: "codexDesktop" },
            modelProvider: "openai",
            cliVersion: "0.143.0",
            gitInfo: {
              branch: "main",
              sha: "secret-sha",
              originUrl: "https://example.invalid/private.git",
            },
            path: "/workspace/.codex/private-rollout.jsonl",
            turns: [{ id: "private-turn" }],
          },
          {
            id: "preview-only",
            name: "Other work",
            preview: "Catalog appears only in private transcript-derived preview text",
            status: { type: "idle" },
          },
        ],
        nextCursor: "next-page",
        backwardsCursor: "previous-page",
      };
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.listSessionCatalogPage("local", {
        cursor: "cursor-1",
        limit: 25,
        archived: true,
        searchTerm: "Catalog",
        cwd: "/workspace",
      }),
    ).resolves.toEqual({
      sessions: [
        {
          threadId: "thread-1",
          sessionId: "session-1",
          name: "Catalog work",
          cwd: "/workspace",
          status: "active",
          activeFlags: ["waitingOnUserInput"],
          createdAt: 10,
          updatedAt: 20,
          recencyAt: 21,
          source: "custom:codexDesktop",
          modelProvider: "openai",
          cliVersion: "0.143.0",
          gitBranch: "main",
          archived: true,
        },
      ],
      nextCursor: "next-page",
      backwardsCursor: "previous-page",
    });
    expect(fake.calls).toEqual([
      {
        method: "thread/list",
        params: {
          limit: 25,
          sortKey: "recency_at",
          sortDirection: "desc",
          modelProviders: [],
          archived: true,
          useStateDbOnly: false,
          cursor: "cursor-1",
          cwd: "/workspace",
        },
      },
    ]);
  });

  it("preserves App Server notLoaded status for stored catalog sessions", async () => {
    const fake = new FakeCodexConnection({ id: "unused" });
    fake.request = async () => ({
      data: [{ id: "thread-stored", status: { type: "notLoaded" } }],
      nextCursor: null,
      backwardsCursor: null,
    });
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(supervisor.listSessionCatalogPage("local")).resolves.toEqual({
      sessions: [{ threadId: "thread-stored", status: "notLoaded", archived: false }],
    });
  });

  it("normalizes and bounds App Server metadata without poisoning the catalog page", async () => {
    const longName = "😀".repeat(251);
    const longMetadata = "m".repeat(501);
    const longId = "i".repeat(257);
    const fake = new FakeCodexConnection({ id: "unused" });
    fake.request = async () => ({
      data: [
        { id: longId, name: "dropped" },
        {
          id: "  thread-1  ",
          sessionId: longId,
          name: longName,
          cwd: "c".repeat(4097),
          status: {
            type: "s".repeat(65),
            activeFlags: ["f".repeat(129), ...Array.from({ length: 17 }, (_, i) => `flag-${i}`)],
          },
          createdAt: Number.POSITIVE_INFINITY,
          updatedAt: 20,
          source: { custom: longMetadata },
          modelProvider: longMetadata,
          cliVersion: longMetadata,
          gitInfo: { branch: longMetadata },
        },
      ],
      nextCursor: "n".repeat(4097),
      backwardsCursor: "opaque-backwards",
    });
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    const page = await supervisor.listSessionCatalogPage("local");

    expect(page).toEqual({
      sessions: [
        {
          threadId: "thread-1",
          name: "😀".repeat(250),
          status: "notLoaded",
          activeFlags: Array.from({ length: 16 }, (_, i) => `flag-${i}`),
          updatedAt: 20,
          source: `custom:${"m".repeat(493)}`,
          modelProvider: "m".repeat(500),
          cliVersion: "m".repeat(500),
          gitBranch: "m".repeat(500),
          archived: false,
        },
      ],
      backwardsCursor: "opaque-backwards",
    });
    expect(page.sessions[0]?.name).toHaveLength(500);
  });

  it("does not permanently cache failed endpoint connections", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    let attempts = 0;
    const supervisor = new CodexSupervisor([endpoint], async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("daemon unavailable");
      }
      return fake;
    });

    await expect(supervisor.probeEndpoints()).resolves.toEqual([
      { endpointId: "local", ok: false, detail: "daemon unavailable" },
    ]);
    await expect(supervisor.probeEndpoints()).resolves.toEqual([{ endpointId: "local", ok: true }]);
    expect(attempts).toBe(2);
  });

  it("lists loaded sessions", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      cwd: "/workspace",
      preview: "work",
      sessionId: "session-1",
      source: "vscode",
      status: { type: "idle" },
      updatedAt: 10,
      turns: [],
    });
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(supervisor.listSessions()).resolves.toEqual([
      {
        endpointId: "local",
        threadId: "thread-1",
        cwd: "/workspace",
        preview: "work",
        sessionId: "session-1",
        source: "vscode",
        status: "idle",
        updatedAt: 10,
        humanAttached: true,
      },
    ]);
  });

  it("lists loaded sessions from real app-server data responses", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      cwd: "/workspace",
      status: { type: "idle" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: ["thread-1"], nextCursor: null };
      }
      if (method === "thread/read") {
        return {
          thread: { id: "thread-1", cwd: "/workspace", status: { type: "idle" }, turns: [] },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(supervisor.listSessions()).resolves.toEqual([
      {
        endpointId: "local",
        threadId: "thread-1",
        cwd: "/workspace",
        status: "idle",
        humanAttached: true,
      },
    ]);
  });

  it("hydrates loaded-only sessions without stored history", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-live",
      cwd: "/workspace",
      status: { type: "active", activeFlags: [] },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: ["thread-live"], nextCursor: null };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-live",
            cwd: "/workspace",
            status: { type: "active", activeFlags: [] },
            turns: [],
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(supervisor.listSessions()).resolves.toEqual([
      {
        endpointId: "local",
        threadId: "thread-live",
        cwd: "/workspace",
        status: "active",
        humanAttached: true,
      },
    ]);
    expect(fake.calls.map((call) => call.method)).toEqual(["thread/loaded/list", "thread/read"]);
  });

  it("does not enumerate stored sessions unless requested", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "notLoaded" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(supervisor.listSessions()).resolves.toEqual([]);
    expect(fake.calls.map((call) => call.method)).toEqual(["thread/loaded/list"]);
  });

  it("reads stored sessions from real app-server data responses", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/list") {
        return {
          data: [{ id: "thread-1", status: { type: "notLoaded" }, turns: [] }],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(supervisor.listSessions({ includeStored: true })).resolves.toEqual([
      {
        endpointId: "local",
        threadId: "thread-1",
        status: "notLoaded",
      },
    ]);
    expect(fake.calls.find((call) => call.method === "thread/list")?.params).toMatchObject({
      sourceKinds: [
        "cli",
        "vscode",
        "exec",
        "appServer",
        "subAgent",
        "subAgentReview",
        "subAgentCompact",
        "subAgentThreadSpawn",
        "subAgentOther",
        "unknown",
      ],
      modelProviders: [],
      sortKey: "recency_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    });
  });

  it("reads every stored session page", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/list") {
        if (params?.cursor === "page-2") {
          return {
            data: [{ id: "thread-2", status: { type: "notLoaded" }, turns: [] }],
            nextCursor: null,
          };
        }
        return {
          data: [{ id: "thread-1", status: { type: "notLoaded" }, turns: [] }],
          nextCursor: "page-2",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(supervisor.listSessions({ includeStored: true })).resolves.toEqual([
      {
        endpointId: "local",
        threadId: "thread-1",
        status: "notLoaded",
      },
      {
        endpointId: "local",
        threadId: "thread-2",
        status: "notLoaded",
      },
    ]);
  });

  it("bounds stored session pagination for large real Codex homes", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/list") {
        return {
          data: [
            { id: "thread-1", status: { type: "notLoaded" }, turns: [] },
            { id: "thread-2", status: { type: "notLoaded" }, turns: [] },
          ],
          nextCursor: "page-2",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.listSessions({ includeStored: true, maxStoredSessions: 1 }),
    ).resolves.toEqual([
      {
        endpointId: "local",
        threadId: "thread-1",
        status: "notLoaded",
      },
    ]);
    expect(fake.calls.filter((call) => call.method === "thread/list")).toEqual([
      {
        method: "thread/list",
        params: {
          limit: 1,
          sourceKinds: [
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown",
          ],
          modelProviders: [],
          sortKey: "recency_at",
          sortDirection: "desc",
          useStateDbOnly: true,
        },
      },
    ]);
  });

  it("closes settled connections when evicting them", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/read") {
        throw new Error("transport closed");
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.readSession({ endpointId: "local", threadId: "thread-1" }),
    ).rejects.toThrow("transport closed");
    await Promise.resolve();
    expect(fake.closeCount).toBe(1);
  });

  it("keeps listing healthy endpoints when one endpoint is down", async () => {
    const downEndpoint: CodexSupervisorEndpoint = {
      id: "down",
      transport: "stdio-proxy",
    };
    const upEndpoint: CodexSupervisorEndpoint = {
      id: "up",
      transport: "stdio-proxy",
    };
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    const supervisor = new CodexSupervisor([downEndpoint, upEndpoint], async (target) => {
      if (target.id === "down") {
        throw new Error("host offline");
      }
      return fake;
    });

    await expect(supervisor.listSessionSnapshot()).resolves.toEqual({
      sessions: [
        {
          endpointId: "up",
          threadId: "thread-1",
          status: "idle",
          humanAttached: true,
        },
      ],
      errors: [{ endpointId: "down", ok: false, detail: "host offline" }],
    });
  });

  it("starts a new turn for idle sessions", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.sendToSession({ endpointId: "local", threadId: "thread-1", text: "continue" }),
    ).resolves.toMatchObject({
      endpointId: "local",
      threadId: "thread-1",
      mode: "start",
      turnId: "turn-started",
    });
    expect(fake.calls.at(-1)).toEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "continue", text_elements: [] }],
      },
    });
  });

  it("resolves omitted endpoint ids from loaded-only sessions", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: ["thread-1"], nextCursor: null };
      }
      if (method === "thread/read") {
        return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } };
      }
      if (method === "thread/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-started", status: "inProgress" } };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.sendToSession({ threadId: "thread-1", text: "continue" }),
    ).resolves.toMatchObject({
      endpointId: "local",
      threadId: "thread-1",
      mode: "start",
    });
  });

  it("uses a unique loaded endpoint match even when another endpoint is down", async () => {
    const upEndpoint: CodexSupervisorEndpoint = { id: "up", transport: "stdio-proxy" };
    const downEndpoint: CodexSupervisorEndpoint = { id: "down", transport: "stdio-proxy" };
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    const supervisor = new CodexSupervisor([upEndpoint, downEndpoint], async (target) => {
      if (target.id === "down") {
        throw new Error("host offline");
      }
      return fake;
    });

    await expect(
      supervisor.sendToSession({ threadId: "thread-1", text: "continue" }),
    ).resolves.toMatchObject({
      endpointId: "up",
      threadId: "thread-1",
      mode: "start",
    });
  });

  it("resolves omitted endpoint ids by exact thread read without scanning stored pages", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-old",
      status: { type: "notLoaded" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/read" && params?.threadId === "thread-old") {
        return { thread: { id: "thread-old", status: { type: "notLoaded" }, turns: [] } };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(supervisor.readSession({ threadId: "thread-old" })).resolves.toEqual({
      thread: { id: "thread-old", status: { type: "notLoaded" }, turns: [] },
    });
    expect(fake.calls.map((call) => call.method)).toEqual([
      "thread/loaded/list",
      "thread/read",
      "thread/read",
    ]);
  });

  it("resolves stored threads on healthy endpoints when another endpoint is down", async () => {
    const downEndpoint: CodexSupervisorEndpoint = { id: "down", transport: "stdio-proxy" };
    const upEndpoint: CodexSupervisorEndpoint = { id: "up", transport: "stdio-proxy" };
    const fake = new FakeCodexConnection({
      id: "thread-old",
      status: { type: "notLoaded" },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/read" && params?.threadId === "thread-old") {
        return { thread: { id: "thread-old", status: { type: "notLoaded" }, turns: [] } };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([downEndpoint, upEndpoint], async (target) => {
      if (target.id === "down") {
        throw new Error("host offline");
      }
      return fake;
    });

    await expect(supervisor.readSession({ threadId: "thread-old" })).resolves.toEqual({
      thread: { id: "thread-old", status: { type: "notLoaded" }, turns: [] },
    });
  });

  it("steers active sessions when the in-progress turn is readable", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [
        { id: "turn-old", status: "completed", items: [] },
        { id: "turn-active", status: "inProgress", items: [] },
      ],
    });
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.sendToSession({ endpointId: "local", threadId: "thread-1", text: "heads up" }),
    ).resolves.toEqual({
      endpointId: "local",
      threadId: "thread-1",
      mode: "steer",
      turnId: "turn-active",
      status: "active",
    });
    expect(fake.calls.at(-1)).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-active",
        input: [{ type: "text", text: "heads up", text_elements: [] }],
      },
    });
  });

  it("steers active sessions through the live turns list fallback", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [],
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === "thread/list") {
        return {
          data: [{ id: "thread-1", status: { type: "active", activeFlags: [] }, turns: [] }],
          nextCursor: null,
        };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-1",
            status: { type: "active", activeFlags: [] },
            turns: [],
          },
        };
      }
      if (method === "thread/turns/list") {
        return {
          data: [{ id: "turn-active", status: "inProgress", items: [] }],
          nextCursor: null,
        };
      }
      if (method === "turn/steer") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.sendToSession({ endpointId: "local", threadId: "thread-1", text: "heads up" }),
    ).resolves.toEqual({
      endpointId: "local",
      threadId: "thread-1",
      mode: "steer",
      turnId: "turn-active",
      status: "active",
    });
  });

  it("fails closed when active turn id is not readable", async () => {
    const fake = new FakeCodexConnection({
      id: "thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [],
    });
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.sendToSession({ endpointId: "local", threadId: "thread-1", text: "heads up" }),
    ).rejects.toThrow("active but no in-progress turn is readable");
  });

  it("falls back to reading empty unmaterialized threads without turns", async () => {
    const fake = new FakeCodexConnection(
      {
        id: "thread-1",
        status: { type: "idle" },
        turns: [],
      },
      true,
    );
    const supervisor = new CodexSupervisor([endpoint], async () => fake);

    await expect(
      supervisor.readSession({ endpointId: "local", threadId: "thread-1", includeTurns: true }),
    ).resolves.toEqual({
      thread: {
        id: "thread-1",
        status: { type: "idle" },
        turns: [],
      },
    });
    expect(
      fake.calls.filter((call) => call.method === "thread/read").map((call) => call.params),
    ).toEqual([
      { threadId: "thread-1", includeTurns: true },
      { threadId: "thread-1", includeTurns: false },
    ]);
  });
});

describe("resolveSafeApprovalResult", () => {
  it("returns a valid fail-closed permissions response", () => {
    expect(resolveSafeApprovalResult("item/permissions/requestApproval")).toEqual({
      permissions: {},
      scope: "turn",
    });
  });

  it("returns valid fail-closed responses for non-approval server requests", () => {
    expect(resolveSafeApprovalResult("item/tool/call")).toEqual({
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw Codex supervisor did not register a handler for this app-server tool call.",
        },
      ],
      success: false,
    });
    expect(resolveSafeApprovalResult("item/tool/requestUserInput")).toEqual({ answers: {} });
    expect(resolveSafeApprovalResult("mcpServer/elicitation/request")).toEqual({
      action: "decline",
    });
    expect(resolveSafeApprovalResult("unknown/request")).toBeUndefined();
  });
});

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

describe("resolveCodexSupervisorStdioSpawnInvocation", () => {
  it("uses the installed macOS Codex app for the default catalog endpoint", () => {
    expect(
      resolveCodexSupervisorStdioSpawnInvocation(
        { id: "local", transport: "stdio-proxy" },
        {
          platform: "darwin",
          env: {},
          execPath: "/usr/bin/node",
          isExecutable: (filePath) =>
            filePath === "/Applications/Codex.app/Contents/Resources/codex",
        },
      ),
    ).toEqual({
      command: "/Applications/Codex.app/Contents/Resources/codex",
      args: ["app-server", "--listen", "stdio://"],
      shell: undefined,
      windowsHide: undefined,
    });
  });

  it("resolves an installed Windows Codex npm shim without a shell", async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-win-bin-"));
    const entrypoint = path.join(binDir, "codex.js");
    const shim = path.join(binDir, "codex.cmd");
    await fs.writeFile(entrypoint, "", "utf8");
    await fs.writeFile(shim, '@ECHO off\r\n"%~dp0\\codex.js" %*\r\n', "utf8");

    expect(
      resolveCodexSupervisorStdioSpawnInvocation(
        { id: "local", transport: "stdio-proxy" },
        {
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".CMD;.EXE;.BAT" },
          execPath: "C:\\node\\node.exe",
          isExecutable: () => false,
        },
      ),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: [entrypoint, "app-server", "--listen", "stdio://"],
      shell: undefined,
      windowsHide: true,
    });
  });

  it("preserves an explicit stdio command instead of selecting the macOS app", () => {
    expect(
      resolveCodexSupervisorStdioSpawnInvocation(
        {
          id: "custom",
          transport: "stdio-proxy",
          command: "/opt/codex-custom",
          args: ["serve"],
        },
        {
          platform: "darwin",
          env: {},
          execPath: "/usr/bin/node",
          isExecutable: () => true,
        },
      ),
    ).toMatchObject({ command: "/opt/codex-custom", args: ["serve"] });
  });
});

describe("connectCodexAppServerEndpoint", () => {
  it("rejects pending websocket requests when the supervisor closes intentionally", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const port = await new Promise<number>((resolve) => {
      server.once("listening", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    const sawProbeRequest = new Promise<void>((resolve) => {
      server.once("connection", (socket) => {
        socket.on("message", (data) => {
          const messageText =
            typeof data === "string"
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data).toString("utf8")
                : data instanceof ArrayBuffer
                  ? Buffer.from(new Uint8Array(data)).toString("utf8")
                  : Buffer.from(data).toString("utf8");
          const request = JSON.parse(messageText) as Record<string, unknown>;
          if (request.method === "initialize") {
            socket.send(JSON.stringify({ id: request.id, result: {} }));
          }
          if (request.method === "thread/loaded/list") {
            resolve();
          }
        });
      });
    });
    const supervisor = new CodexSupervisor(
      [{ id: "ws", transport: "websocket", url: `ws://127.0.0.1:${port}` }],
      connectCodexAppServerEndpoint,
    );

    const probe = supervisor.probeEndpoints();
    await sawProbeRequest;
    await supervisor.close();

    await expect(
      Promise.race([
        probe,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("probe timed out")), 500);
        }),
      ]),
    ).resolves.toMatchObject([{ endpointId: "ws", ok: false }]);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("rejects malformed stdio frames instead of throwing out of band", async () => {
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-malformed-"));
    const marker = path.join(markerDir, "closed");
    const script = `
      const fs = require("node:fs");
      const readline = require("node:readline");
      process.on("SIGTERM", () => {
        fs.writeFileSync(${JSON.stringify(marker)}, "closed");
        process.exit(0);
      });
      readline.createInterface({ input: process.stdin }).on("line", () => {
        process.stdout.write("not-json\\n");
      });
      setTimeout(() => {}, 10_000);
    `;

    await expect(
      connectCodexAppServerEndpoint({
        id: "bad",
        transport: "stdio-proxy",
        command: process.execPath,
        args: ["-e", script],
      }),
    ).rejects.toThrow("Malformed Codex app-server message");
    await expect(waitForFile(marker)).resolves.toBe("closed");
  });

  it("closes stdio connections when initialization fails", async () => {
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-init-"));
    const marker = path.join(markerDir, "closed");
    const script = `
      const fs = require("node:fs");
      const readline = require("node:readline");
      process.on("SIGTERM", () => {
        fs.writeFileSync(${JSON.stringify(marker)}, "closed");
        process.exit(0);
      });
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          id: request.id,
          error: { code: -32000, message: "init failed" }
        }) + "\\n");
      });
      setTimeout(() => {}, 10_000);
    `;

    await expect(
      connectCodexAppServerEndpoint({
        id: "bad",
        transport: "stdio-proxy",
        command: process.execPath,
        args: ["-e", script],
      }),
    ).rejects.toThrow("init failed");
    await expect(waitForFile(marker)).resolves.toBe("closed");
  });

  it("keeps stdio close errors UTF-16 safe at the stderr tail boundary", async () => {
    const prefix = "x".repeat(1_199);
    const script = `
      process.stderr.write(${JSON.stringify(`${prefix}😀`)});
      process.exit(0);
    `;
    let closeError: unknown;

    try {
      await connectCodexAppServerEndpoint({
        id: "exits",
        transport: "stdio-proxy",
        command: process.execPath,
        args: ["-e", script],
      });
    } catch (error) {
      closeError = error;
    }

    expect(closeError).toBeInstanceOf(Error);
    expect((closeError as Error).message).toBe(
      `Codex app-server stdio transport closed. stderr_tail=${prefix}`,
    );
  });

  it("fails a cached stdio connection cleanly after the child exits", async () => {
    const script = `
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
          return;
        }
        if (request.method === "thread/loaded/list") {
          process.stdout.write(JSON.stringify({ id: request.id, result: { threads: [] } }) + "\\n");
          setTimeout(() => process.exit(0), 0);
        }
      });
    `;
    const supervisor = new CodexSupervisor(
      [
        {
          id: "exits",
          transport: "stdio-proxy",
          command: process.execPath,
          args: ["-e", script],
        },
      ],
      connectCodexAppServerEndpoint,
    );

    await expect(supervisor.probeEndpoints()).resolves.toEqual([{ endpointId: "exits", ok: true }]);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await expect(supervisor.probeEndpoints()).resolves.toMatchObject([
      {
        endpointId: "exits",
        ok: false,
      },
    ]);
    await supervisor.close();
  });
});
