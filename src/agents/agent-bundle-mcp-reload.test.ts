import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import {
  createMcpProbeFixture,
  probeMcpServer as probe,
} from "./agent-bundle-mcp-probe.test-support.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";

const startAuthorization = vi.hoisted(() => vi.fn(async () => ({ status: "authorized" })));
const readAuthorization = vi.hoisted(() => vi.fn(async () => ({ state: "unauthenticated" })));
vi.mock("./mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatus: readAuthorization,
  startMcpOAuthAuthorization: startAuthorization,
}));

const tempDirs: string[] = [];
const managers: ReturnType<typeof createSessionMcpRuntimeManager>[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
const releaseHeld: Array<() => void> = [];

afterEach(async () => {
  for (const release of releaseHeld.splice(0)) {
    release();
  }
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  cleanupTempDirs(tempDirs);
  startAuthorization.mockClear();
  readAuthorization.mockReset().mockResolvedValue({ state: "unauthenticated" });
});

async function fixture(now?: () => number) {
  const source = await createMcpProbeFixture(tempDirs);
  const manager = createSessionMcpRuntimeManager({ enableIdleSweepTimer: false, now });
  managers.push(manager);
  return { ...source, manager };
}

it("keeps unchanged server transports and catalogs when another server changes", async () => {
  const { manager, config, params } = await fixture();
  const original = await manager.getOrCreate({ ...params, cfg: config() });
  const originalCatalog = await original.getCatalog();
  const first = await probe(original, "healthy");
  const old = await probe(original, "changed");
  const refreshed = await manager.getOrCreate({ ...params, cfg: config("new") });

  expect(await probe(refreshed, "healthy")).toEqual(first);
  expect(await probe(original, "healthy")).toEqual(first);
  expect((await refreshed.getCatalog()).servers.healthy).toBe(originalCatalog.servers.healthy);
  expect(await probe(refreshed, "changed")).toMatchObject({ label: "new" });
  expect((await probe(refreshed, "changed")).pid).not.toBe(old.pid);
  await expect(probe(original, "changed")).rejects.toThrow(/disposed|retir/);
});

it.each(["change", "disable", "remove", "collision"] as const)(
  "revokes only the changed owner immediately on %s publication",
  async (change) => {
    const { manager, config, params } = await fixture();
    const acquisition = await manager.acquire({ ...params, cfg: config() });
    const original = acquisition.runtime;
    const healthy = await probe(original, "healthy");
    await probe(original, "changed");
    const next = config("new");
    if (change === "disable") {
      expectDefined(next.mcp!.servers!.changed, "configured changed server").enabled = false;
    }
    if (change === "remove") {
      delete next.mcp!.servers!.changed;
    }
    if (change === "collision") {
      next.mcp!.servers = {
        CHANGED: expectDefined(config().mcp!.servers!.changed, "collision source server"),
        ...config().mcp!.servers,
      };
    }
    await manager.reloadConfig({ cfg: next, manifestRegistry: params.manifestRegistry });
    await expect(probe(original, "changed")).rejects.toThrow();
    expect(await probe(original, "healthy")).toEqual(healthy);
    const materialized = await materializeBundleMcpToolsForRun(acquisition);
    try {
      expect(materialized.tools.map((tool) => tool.name)).toEqual(["healthy__probe"]);
      expect(materialized.diagnostics).toEqual([
        expect.objectContaining({
          serverName: "changed",
          message: expect.stringMatching(/retired/),
        }),
      ]);
    } finally {
      await materialized.dispose();
    }
    const refreshed = await manager.getOrCreate({ ...params, cfg: next });
    expect(await probe(refreshed, "healthy")).toEqual(healthy);
    const catalog = await refreshed.getCatalog();
    if (change === "disable" || change === "remove") {
      expect(catalog.servers.changed).toBeUndefined();
    } else {
      expect(catalog.servers.changed?.safeServerName).toBe(
        change === "collision" ? "changed-2" : "changed",
      );
    }
  },
);

it("allows an unchanged server call to finish across config publication", async () => {
  const { manager, config, params } = await fixture();
  const original = await manager.getOrCreate({ ...params, cfg: config() });
  const healthy = await probe(original, "healthy");
  const held = path.join(params.workspaceDir, "held-call");
  const result = probe(original, "healthy", { hold: held });
  const observed = result.catch(() => undefined);
  try {
    await expect
      .poll(async () => Boolean(await fs.stat(`${held}.started`).catch(() => undefined)))
      .toBe(true);
    await manager.reloadConfig({ cfg: config("new"), manifestRegistry: params.manifestRegistry });
    const refreshed = await manager.getOrCreate({ ...params, cfg: config("new") });
    await fs.writeFile(held, "release");
    expect(await result).toEqual(healthy);
    expect(await probe(refreshed, "healthy")).toEqual(healthy);
  } finally {
    await fs.writeFile(held, "release");
    await observed;
  }
});

it.each(["creating", "queued"])(
  "fences a %s acquisition against a crossed publication",
  async (phase) => {
    const { config, params } = await fixture();
    const started = createDeferred();
    const released = createDeferred();
    releaseHeld.push(() => released.resolve());
    const manager = createSessionMcpRuntimeManager({
      enableIdleSweepTimer: false,
      async createRuntime(input) {
        started.resolve();
        await released.promise;
        return createSessionMcpRuntime(input);
      },
    });
    managers.push(manager);
    const first = manager.acquire({ ...params, cfg: config() });
    await started.promise;
    const pending = phase === "queued" ? manager.acquire({ ...params, cfg: config() }) : first;
    const next = config();
    delete next.mcp!.servers!.changed;
    await manager.reloadConfig({ cfg: next, manifestRegistry: params.manifestRegistry });
    released.resolve();
    if (phase === "queued") {
      (await first).releaseLease();
    }
    const acquisition = await pending;
    const old = acquisition.runtime;
    await expect(probe(old, "changed")).rejects.toThrow();
    expect(await probe(old, "healthy")).toMatchObject({ label: "healthy" });
    const materialized = await materializeBundleMcpToolsForRun(acquisition);
    try {
      expect(materialized.tools.map((tool) => tool.name)).toEqual(["healthy__probe"]);
    } finally {
      await materialized.dispose();
    }
    const current = await manager.getOrCreate({ ...params, cfg: next });
    expect((await current.getCatalog()).servers.changed).toBeUndefined();
  },
);

async function httpProbe(onDelete?: () => Promise<void>, onList?: () => Promise<void>) {
  let initialized = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method === "DELETE") {
        await onDelete?.();
        res.writeHead(200).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      let result;
      if (message.method === "initialize") {
        res.setHeader("mcp-session-id", String(++initialized));
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "requester-probe", version: "1" },
        };
      } else if (message.method === "tools/list") {
        await onList?.();
        result = { tools: [{ name: "probe", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                pid: Number(req.headers["mcp-session-id"]),
                label: "requester",
              }),
            },
          ],
        };
      }
      if (!result) {
        res.writeHead(202).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP probe did not bind");
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

it.each(["changed", "healthy"])(
  "materializes healthy siblings when %s discovery spans revocation",
  async (heldServer) => {
    const started = createDeferred();
    const released = createDeferred();
    releaseHeld.push(() => released.resolve());
    const url = await httpProbe(undefined, async () => {
      started.resolve();
      await released.promise;
    });
    const { manager, config, params } = await fixture();
    const cfg = config();
    cfg.mcp!.servers![heldServer] = { transport: "streamable-http", url };
    const acquisition = await manager.acquire({ ...params, cfg });
    const pending = materializeBundleMcpToolsForRun(acquisition);
    void pending.catch(() => undefined);
    await started.promise;
    await probe(acquisition.runtime, heldServer === "changed" ? "healthy" : "changed");
    const next = structuredClone(cfg);
    delete next.mcp!.servers!.changed;
    await manager.reloadConfig({ cfg: next, manifestRegistry: params.manifestRegistry });
    released.resolve();
    const materialized = await pending;
    try {
      expect(materialized.tools.map((tool) => tool.name)).toEqual(["healthy__probe"]);
      expect(materialized.diagnostics).toEqual([
        expect.objectContaining({
          serverName: "changed",
          message: expect.stringMatching(/retired/),
        }),
      ]);
    } finally {
      await materialized.dispose();
    }
  },
);

it("refreshes a catalog invalidated while a sibling is still discovering", async () => {
  const started = createDeferred();
  const released = createDeferred();
  releaseHeld.push(() => released.resolve());
  const url = await httpProbe(undefined, async () => {
    started.resolve();
    await released.promise;
  });
  const { manager, config, params } = await fixture();
  const cfg = config();
  delete cfg.mcp!.servers!.changed;
  const first = await manager.getOrCreate({ ...params, cfg });
  await first.getCatalog();
  const second = await manager.getOrCreate({
    ...params,
    sessionId: "discovering-sibling",
    cfg: { mcp: { servers: { sibling: { transport: "streamable-http", url } } } },
  });
  const combined = createCombinedSessionMcpRuntime({ ...params, parts: [first, second] });
  const pending = combined.getCatalog();
  await started.promise;
  await probe(first, "healthy", { changeTools: true });
  await expect.poll(() => first.peekCatalog()).toBeNull();
  released.resolve();
  expect((await pending).tools.map((tool) => tool.toolName)).toEqual(["updated_probe", "probe"]);
  expect(combined.peekCatalog()?.tools.map((tool) => tool.toolName)).toEqual([
    "updated_probe",
    "probe",
  ]);
});

it.each(["remove", "disable", "public origin"])(
  "does not publish revoked sign-in tools when %s crosses sibling discovery",
  async (change) => {
    const started = createDeferred();
    const released = createDeferred();
    releaseHeld.push(() => released.resolve());
    const url = await httpProbe(undefined, async () => {
      started.resolve();
      await released.promise;
    });
    const { manager, config, params } = await fixture();
    const cfg = config();
    cfg.gateway = { publicOrigin: "https://gateway.example.test" };
    cfg.mcp!.servers!.healthy = { transport: "streamable-http", url };
    for (const serverName of ["calendar", "contacts"]) {
      cfg.mcp!.servers![serverName] = {
        transport: "streamable-http",
        url: `https://mcp.example.test/${serverName}`,
        auth: "oauth",
        oauth: { identity: "per-requester" },
      };
    }
    const acquisition = await manager.acquire({ ...params, cfg, requesterSenderId: "alice" });
    const pending = materializeBundleMcpToolsForRun(acquisition);
    await started.promise;
    const next = structuredClone(cfg);
    if (change === "remove") {
      delete next.mcp!.servers!.calendar;
    } else if (change === "disable") {
      next.mcp!.servers!.calendar!.enabled = false;
    } else {
      next.gateway!.publicOrigin = "https://replacement.example.test";
    }
    await manager.reloadConfig({ cfg: next, manifestRegistry: params.manifestRegistry });
    released.resolve();
    const materialized = await pending;
    try {
      expect(materialized.tools.map((tool) => tool.name)).toEqual(
        change === "public origin"
          ? ["changed__probe", "healthy__probe"]
          : ["changed__probe", "contacts__connect", "healthy__probe"],
      );
    } finally {
      await materialized.dispose();
    }
  },
);

it("rotates one requester's changed server while retaining sibling connections and requesters", async () => {
  const resolverRegistry = createMcpProofPluginRegistry();
  await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
    const url = await httpProbe();
    let generation = 0;

    const resolverApi = resolverRegistry.apiFor("test-plugin");
    for (const serverName of ["first", "second"]) {
      resolverApi.registerMcpServerConnectionResolver({
        serverName,
        resolve: async ({ requesterSenderId }) => ({
          url,
          headers: {
            Authorization: `proof-${requesterSenderId}-${serverName === "first" && requesterSenderId === "alice" ? generation : 0}`,
          },
        }),
      });
    }
    let nowMs = 100_000;
    const { manager, params } = await fixture(() => nowMs);
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      mcp: {
        servers: {
          first: { transport: "streamable-http" },
          second: { transport: "streamable-http" },
        },
      },
    };
    const aliceParams = { ...params, cfg, requesterSenderId: "alice" };
    const bobParams = { ...params, cfg, requesterSenderId: "bob" };
    const alice = await manager.getOrCreate(aliceParams);
    const bob = await manager.getOrCreate(bobParams);
    const before = await Promise.all([
      probe(alice, "first"),
      probe(alice, "second"),
      probe(bob, "first"),
      probe(bob, "second"),
    ]);
    generation++;
    nowMs += 300_000;
    const nextAlice = await manager.getOrCreate(aliceParams);
    const nextBob = await manager.getOrCreate(bobParams);
    const after = await Promise.all([
      probe(nextAlice, "first"),
      probe(nextAlice, "second"),
      probe(nextBob, "first"),
      probe(nextBob, "second"),
    ]);
    expect(after[0]).not.toEqual(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
    const oldHandle = await manager.getOrCreateRequesterScoped(aliceParams);
    expect(oldHandle).toBeDefined();
    await manager.reloadConfig({
      cfg,
      manifestRegistry: params.manifestRegistry,
      reloadPlugins: true,
    });
    await expect(probe(nextAlice, "first")).rejects.toThrow();
    const currentHandle = await manager.getOrCreateRequesterScoped(bobParams);
    expect(currentHandle).toBeDefined();
    const currentCatalog = await currentHandle!.runtime.getCatalog();
    manager.rememberAdvertisedScopedCatalog(currentHandle!, currentCatalog);
    manager.rememberAdvertisedScopedCatalog(oldHandle!, {
      ...currentCatalog,
      servers: {
        retired: { serverName: "retired", launchSummary: "retired plugin", toolCount: 0 },
      },
      tools: [],
    });
    expect(manager.getAdvertisedScopedCatalog(params.sessionId)?.servers.retired).toBeUndefined();
    const successor = await manager.getOrCreate(aliceParams);
    expect(await probe(successor, "first")).not.toEqual(after[0]);
  });
});

it.each(["removal", "public origin change", "plugin replacement with explicit shadow"])(
  "revokes a retained connect callback on %s",
  async (change) => {
    const { manager, params } = await fixture();
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      gateway: { publicOrigin: "https://gateway.example.test" },
      mcp: {
        servers: {
          calendar: {
            transport: "streamable-http",
            url: "https://mcp.example.test",
            auth: "oauth",
            oauth: { identity: "per-requester" },
            cwd: params.workspaceDir,
          },
        },
      },
    };
    const calendar = expectDefined(cfg.mcp!.servers!.calendar, "calendar server");
    const reloadPlugins = change === "plugin replacement with explicit shadow";
    const manifestRegistry = reloadPlugins
      ? {
          plugins: [
            createPluginManifestRecordFixture({
              id: "reload-probe",
              rootDir: params.workspaceDir,
              mcpServers: { calendar },
            }),
          ],
        }
      : params.manifestRegistry;
    if (reloadPlugins) {
      cfg.plugins = { entries: { "reload-probe": { enabled: true } } };
      cfg.mcp!.servers = {};
    }
    const runtime = await manager.getOrCreate({
      ...params,
      manifestRegistry,
      cfg,
      requesterSenderId: "alice",
    });
    const connect = runtime.requesterConnect?.createExecute("calendar");
    expect(connect).toBeDefined();
    await connect!("before", {});
    expect(startAuthorization).toHaveBeenCalledOnce();
    await manager.reloadConfig({
      cfg:
        change === "removal"
          ? { ...cfg, mcp: { servers: {} } }
          : reloadPlugins
            ? { ...cfg, mcp: { servers: { calendar } } }
            : {
                ...cfg,
                gateway: { publicOrigin: "https://replacement.example.test" },
              },
      manifestRegistry,
      reloadPlugins,
    });
    await expect(connect!("after", {})).rejects.toThrow("disposed");
    expect(startAuthorization).toHaveBeenCalledOnce();
  },
);

it("preserves transferred servers across queued replacements", async () => {
  const { manager, config, params } = await fixture();
  const original = await manager.getOrCreate({ ...params, cfg: config() });
  const healthy = await probe(original, "healthy");
  await probe(original, "changed");
  const closing = createDeferred();
  const released = createDeferred();
  releaseHeld.push(() => released.resolve());
  const dispose = original.dispose;
  original.dispose = async () => {
    closing.resolve();
    await released.promise;
    await dispose();
  };
  const first = manager.getOrCreate({ ...params, cfg: config("intermediate") });
  await closing.promise;
  const second = manager.getOrCreate({ ...params, cfg: config("winner") });
  released.resolve();
  await first;
  const winner = await second;
  expect(await probe(winner, "healthy")).toEqual(healthy);
  expect(await probe(winner, "changed")).toMatchObject({ label: "winner" });
});

it("retains plugin retirement across a later config-only publication during creation", async () => {
  const resolverRegistry = createMcpProofPluginRegistry();
  await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
    const url = await httpProbe();
    const { params } = await fixture();
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      mcp: { servers: { scoped: { transport: "streamable-http" } } },
    };
    const resolverApi = resolverRegistry.apiFor("test-plugin");
    resolverApi.registerMcpServerConnectionResolver({
      serverName: "scoped",
      resolve: async () => ({ url }),
    });
    const started = createDeferred();
    const released = createDeferred();
    let retired: SessionMcpRuntime | undefined;
    let firstConnection: Awaited<ReturnType<typeof probe>> | undefined;
    releaseHeld.push(() => released.resolve());
    const manager = createSessionMcpRuntimeManager({
      enableIdleSweepTimer: false,
      async createRuntime(input) {
        const runtime = createSessionMcpRuntime(input);
        if (input.requesterScope && !retired) {
          retired = runtime;
          firstConnection = await probe(runtime, "scoped");
          started.resolve();
          await released.promise;
        }
        return runtime;
      },
    });
    managers.push(manager);
    const pending = manager.getOrCreate({ ...params, cfg, requesterSenderId: "alice" });
    await started.promise;
    resolverApi.registerMcpServerConnectionResolver({
      serverName: "scoped",
      resolve: async () => ({ url, headers: { Authorization: "replacement" } }),
    });
    await manager.reloadConfig({
      cfg,
      manifestRegistry: params.manifestRegistry,
      reloadPlugins: true,
    });
    await manager.reloadConfig({
      cfg: structuredClone(cfg),
      manifestRegistry: params.manifestRegistry,
    });
    released.resolve();
    expect(await probe(await pending, "scoped")).not.toEqual(firstConnection);
    await expect(probe(expectDefined(retired, "retired plugin owner"), "scoped")).rejects.toThrow();
  });
});

it.each(["no shadow", "shadow at publication", "shadow before transfer"])(
  "retires a transferred plugin with %s before the next queued acquisition",
  async (shadow) => {
    const { manager, config, params } = await fixture();
    const bundledServer = {
      command: process.execPath,
      args: [path.join(params.workspaceDir, "server.mjs"), "plugin"],
      cwd: params.workspaceDir,
    };
    const manifestRegistry = {
      plugins: [
        createPluginManifestRecordFixture({
          id: "reload-probe",
          rootDir: params.workspaceDir,
          mcpServers: {
            bundled: bundledServer,
          },
        }),
      ],
    };
    const cfg = (label: string): OpenClawConfig => {
      const next = {
        ...config(label),
        plugins: { entries: { "reload-probe": { enabled: true } } },
      };
      if (
        (label === "winner" && shadow !== "no shadow") ||
        (label === "intermediate" && shadow === "shadow before transfer")
      ) {
        next.mcp!.servers!.bundled = bundledServer;
      }
      return next;
    };
    const acquire = (label: string) =>
      manager.getOrCreate({ ...params, manifestRegistry, cfg: cfg(label) });
    const original = await acquire("old");
    const healthy = await probe(original, "healthy");
    const bundled = await probe(original, "bundled");
    const closing = createDeferred();
    const released = createDeferred();
    releaseHeld.push(() => released.resolve());
    const dispose = original.dispose;
    original.dispose = async () => {
      closing.resolve();
      await released.promise;
      await dispose();
    };
    const first = acquire("intermediate");
    await closing.promise;
    await manager.reloadConfig({ cfg: cfg("winner"), manifestRegistry, reloadPlugins: true });
    const second = acquire("winner");
    released.resolve();
    await first;
    const winner = await second;
    expect(await probe(winner, "healthy")).toEqual(healthy);
    expect((await probe(winner, "bundled")).pid).not.toBe(bundled.pid);
  },
);

it("reconciles a second publication arriving while a pending owner is retiring a server", async () => {
  const closing = createDeferred();
  const releaseClose = createDeferred();
  releaseHeld.push(() => releaseClose.resolve());
  let held = false;
  const url = await httpProbe(async () => {
    if (!held) {
      held = true;
      closing.resolve();
      await releaseClose.promise;
    }
  });
  const { params } = await fixture();
  const server = { transport: "streamable-http" as const, url };
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    mcp: { servers: { first: server, second: server } },
  };
  const created = createDeferred();
  const releaseCreate = createDeferred();
  releaseHeld.push(() => releaseCreate.resolve());
  const manager = createSessionMcpRuntimeManager({
    enableIdleSweepTimer: false,
    async createRuntime(input) {
      const runtime = createSessionMcpRuntime(input);
      await runtime.getCatalog();
      created.resolve();
      await releaseCreate.promise;
      return runtime;
    },
  });
  managers.push(manager);
  const pending = manager.getOrCreate({ ...params, cfg });
  await created.promise;
  await manager.reloadConfig({
    cfg: { ...cfg, mcp: { servers: { second: server } } },
    manifestRegistry: params.manifestRegistry,
  });
  releaseCreate.resolve();
  await closing.promise;
  const latestPublication = manager.reloadConfig({
    cfg: { ...cfg, mcp: { servers: {} } },
    manifestRegistry: params.manifestRegistry,
  });
  releaseClose.resolve();
  await latestPublication;
  await expect(probe(await pending, "second")).rejects.toThrow();
});

it("preserves an explicit config snapshot acquired after an unrelated global publication", async () => {
  const { manager, config, params } = await fixture();
  await manager.reloadConfig({
    cfg: { mcp: { servers: {} } },
    manifestRegistry: params.manifestRegistry,
  });
  const explicit = await manager.getOrCreate({ ...params, cfg: config() });
  expect(await probe(explicit, "healthy")).toMatchObject({ label: "healthy" });
});

it.each([false, true])(
  "accounts for config cleanup with concurrent replacement %s",
  async (replace) => {
    const closing = createDeferred();
    const releaseClose = createDeferred();
    releaseHeld.push(() => releaseClose.resolve());
    const url = await httpProbe(async () => {
      closing.resolve();
      await releaseClose.promise;
    });
    const { manager, params } = await fixture();
    const server = { transport: "streamable-http" as const, url };
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      mcp: { servers: { first: server, second: server } },
    };
    const original = await manager.getOrCreate({
      ...params,
      cfg: { ...cfg, mcp: { servers: { first: server } } },
    });
    await probe(original, "first");
    const acquire = (sessionId: string) =>
      manager.getOrCreate({
        ...params,
        sessionId,
        cfg: { ...cfg, mcp: { servers: { second: server } } },
      });
    for (let index = 0; index < 255; index += 1) {
      await acquire(`other-${index}`);
    }
    const reload = manager.reloadConfig({
      cfg: { ...cfg, mcp: { servers: { second: server } } },
      manifestRegistry: params.manifestRegistry,
    });
    await closing.promise;
    const replacement = replace ? acquire(params.sessionId) : undefined;
    await expect(acquire("overflow")).rejects.toThrow("live runtime limit (256)");
    releaseClose.resolve();
    await reload;
    await replacement;
    if (replace) {
      await expect(acquire("overflow")).rejects.toThrow("live runtime limit (256)");
      await manager.disposeSession(params.sessionId);
    }
    await acquire("overflow");
    // The cached empty facade must reserve capacity again before gaining a server.
    await expect(acquire(params.sessionId)).rejects.toThrow("live runtime limit (256)");
  },
);

it("joins config retirement cleanup before installing a replacement transport", async () => {
  const closing = createDeferred();
  const releaseClose = createDeferred();
  releaseHeld.push(() => releaseClose.resolve());
  const url = await httpProbe(async () => {
    closing.resolve();
    await releaseClose.promise;
  });
  const { manager, params } = await fixture();
  const server = { transport: "streamable-http" as const, url };
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    mcp: { servers: { first: server, second: server } },
  };
  const original = await manager.getOrCreate({ ...params, cfg });
  await probe(original, "first");
  const healthy = await probe(original, "second");
  const next = {
    ...cfg,
    mcp: { servers: { first: { ...server, headers: { "X-Generation": "new" } }, second: server } },
  };
  const reload = manager.reloadConfig({ cfg: next, manifestRegistry: params.manifestRegistry });
  await closing.promise;
  let installed = false;
  const replacement = manager.getOrCreate({ ...params, cfg: next }).then((runtime) => {
    installed = true;
    return runtime;
  });
  // Let ready producers drain while the server deliberately holds DELETE open.
  await setImmediate();
  expect(installed).toBe(false);
  releaseClose.resolve();
  await reload;
  expect(await probe(await replacement, "second")).toEqual(healthy);
  expect(await probe(await replacement, "first")).not.toEqual(healthy);
});

it("revokes transferred active work while unrelated transport cleanup is pending", async () => {
  const closing = createDeferred();
  const releaseClose = createDeferred();
  releaseHeld.push(() => releaseClose.resolve());
  const url = await httpProbe(async () => {
    closing.resolve();
    await releaseClose.promise;
  });
  const { manager, config, params } = await fixture();
  const cfg = config();
  cfg.mcp!.servers!.changed = { transport: "streamable-http", url };
  const original = await manager.getOrCreate({ ...params, cfg });
  await probe(original, "changed");
  const marker = path.join(params.workspaceDir, "revoked-call");
  let revoked = false;
  const held = probe(original, "healthy", { hold: marker }).catch(() => {
    revoked = true;
  });
  await expect
    .poll(async () => Boolean(await fs.stat(`${marker}.started`).catch(() => undefined)))
    .toBe(true);
  const next = structuredClone(cfg);
  next.mcp!.servers!.changed = { transport: "streamable-http", url, headers: { generation: "2" } };
  const pending = manager.getOrCreate({ ...params, cfg: next });
  void pending.catch(() => undefined);
  await closing.promise;
  const removed = structuredClone(next);
  delete removed.mcp!.servers!.healthy;
  await manager.reloadConfig({ cfg: removed, manifestRegistry: params.manifestRegistry });
  await setImmediate();
  expect(revoked).toBe(true);
  releaseClose.resolve();
  await pending;
  await held;
});

it("completes required retirement when the old run releases the final transferred lease", async () => {
  const { manager, config, params } = await fixture();
  const original = await manager.getOrCreate({ ...params, cfg: config() });
  const releaseOriginal = expectDefined(original.acquireLease, "original run lease")();
  const healthy = await probe(original, "healthy");
  manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
  const replacement = await manager.getOrCreate({ ...params, cfg: config("new") });
  const releaseReplacement = expectDefined(replacement.acquireLease, "replacement run lease")();
  releaseReplacement();
  await expect(manager.completeDeferredRetirement(params.sessionId, replacement)).resolves.toBe(
    false,
  );
  releaseOriginal();
  await expect(manager.completeDeferredRetirement(params.sessionId, original)).resolves.toBe(true);
  expect(manager.listRuntimeKeys()).toEqual([]);
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});

it.each([false, true])(
  "defers retirement behind acquisition (required: %s)",
  async (retainAcrossReuse) => {
    const { manager, config, params } = await fixture();
    const original = await manager.getOrCreate({ ...params, cfg: config() });
    const releaseOriginal = expectDefined(original.acquireLease, "original run lease")();
    const healthy = await probe(original, "healthy");
    const closing = createDeferred();
    const releaseClose = createDeferred();
    releaseHeld.push(() => releaseClose.resolve());
    const dispose = original.dispose;
    original.dispose = async () => {
      closing.resolve();
      await releaseClose.promise;
      await dispose();
    };
    const pending = manager.acquire({ ...params, cfg: config("new") }).then((lease) => ({
      runtime: lease.runtime,
      release: lease.releaseLease,
    }));
    await closing.promise;
    manager.deferRetirement(params.sessionId, { retainAcrossReuse });
    releaseOriginal();
    const retiring = manager.completeDeferredRetirement(params.sessionId, original);
    releaseClose.resolve();
    const next = await pending;
    await expect(retiring).resolves.toBe(false);
    expect(await probe(next.runtime, "healthy")).toEqual(healthy);
    next.release();
    await expect(manager.completeDeferredRetirement(params.sessionId, next.runtime)).resolves.toBe(
      retainAcrossReuse,
    );
  },
);

it("completes required retirement after pending requester acquisition fails without a lease", async () => {
  const { manager, config, params } = await fixture();
  const cfg = config();
  cfg.mcp!.servers!.calendar = {
    transport: "streamable-http",
    url: "https://mcp.example.test",
    auth: "oauth",
    oauth: { identity: "per-requester" },
  };
  const input = { ...params, cfg, requesterSenderId: "alice" };
  const original = await manager.getOrCreate(input);
  const releaseOriginal = expectDefined(original.acquireLease, "original run lease")();
  const healthy = await probe(original, "healthy");
  const started = createDeferred();
  const released = createDeferred();
  releaseHeld.push(() => released.resolve());
  readAuthorization.mockImplementationOnce(async () => {
    started.resolve();
    await released.promise;
    throw new Error("requester authorization unavailable");
  });
  const pending = manager.getOrCreateRequesterScoped(input).catch((error: unknown) => error);
  await started.promise;
  manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
  releaseOriginal();
  const retiring = manager.completeDeferredRetirement(params.sessionId, original);
  released.resolve();
  expect(await pending).toMatchObject({ message: "requester authorization unavailable" });
  await expect(retiring).resolves.toBe(true);
  expect(manager.listRuntimeKeys()).toEqual([]);
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});
