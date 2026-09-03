import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { VisitorGrant } from "./src/visitors.js";

const TOKEN = "visitor-test-token-never-echo";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const policiesUrl =
  "https://api.cloudflare.com/client/v4/accounts/test-account/access/apps/test-app/policies";

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function createPolicyFetch() {
  let emails: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    if (!url.href.startsWith(policiesUrl)) {
      throw new Error(`Unexpected test request: ${url}`);
    }
    const policy = {
      id: "visitor-policy",
      name: "Visitors (openclaw-managed)",
      decision: "allow",
      include: emails.map((email) => ({ email: { email } })),
    };
    if (init?.method === "GET") {
      const result = url.search ? (emails.length ? [policy] : []) : policy;
      return Response.json({ success: true, result });
    }
    if (init?.method === "DELETE") {
      emails = [];
    } else {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON policy body");
      }
      const body = JSON.parse(init.body) as {
        include: Array<{ email: { email: string } }>;
      };
      emails = body.include.map((rule) => rule.email.email);
    }
    return Response.json({ success: true, result: {} });
  });
  return { fetcher, emails: () => emails };
}

describe("visitor-access plugin lifecycle", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "visitor-access-test-")));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(START_MS);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    resetPluginStateStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function registerPlugin() {
    const tools = new Map<string, AnyAgentTool>();
    const services: OpenClawPluginService[] = [];
    const on = vi.fn<OpenClawPluginApi["on"]>();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const api = createTestPluginApi({
      id: "visitor-access",
      pluginConfig: { accountId: "test-account", appId: "test-app", apiToken: TOKEN },
      logger,
      on,
      registerService: (service) => services.push(service),
      registerTool: (registration) => {
        const resolved =
          typeof registration === "function"
            ? registration({ sessionKey: "agent:main:maintainer" })
            : registration;
        for (const tool of Array.isArray(resolved) ? resolved : resolved ? [resolved] : []) {
          tools.set(tool.name, tool);
        }
      },
    });
    api.runtime.state = {
      ...api.runtime.state,
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("visitor-access", { ...options, env }),
    };
    plugin.register(api);
    const service = services[0];
    if (!service) {
      throw new Error("Plugin did not register its expiry service");
    }
    const context: OpenClawPluginServiceContext = { config: {}, stateDir, logger };
    cleanups.push(() => service.stop?.(context));
    const store = createPluginStateKeyedStoreForTests<VisitorGrant>("visitor-access", {
      namespace: "visitor-grants",
      maxEntries: 500,
      overflowPolicy: "reject-new",
      env,
    });
    return {
      logger,
      store,
      start: () => service.start(context),
      stop: () => service.stop?.(context),
      gatewayStart: () => {
        const hook = on.mock.calls.find(([name]) => name === "gateway_start")?.[1];
        if (!hook) {
          throw new Error("Plugin did not register its Gateway startup sweep");
        }
        const startHook = hook as (
          event: { port: number },
          context: { port?: number },
        ) => void | Promise<void>;
        return startHook({ port: 18789 }, {});
      },
      execute: (name: string, input: Record<string, unknown> = {}) => {
        const tool = tools.get(name);
        if (!tool) {
          throw new Error(`Plugin did not register ${name}`);
        }
        return tool.execute("visitor-test-call", input);
      },
    };
  }

  it("keeps CLI metadata discovery free of runtime access and background work", () => {
    const api = createTestPluginApi({ registrationMode: "cli-metadata" });
    const runtime = vi.fn(() => {
      throw new Error("Metadata discovery accessed runtime");
    });
    Object.defineProperty(api, "runtime", { get: runtime });
    expect(() => plugin.register(api)).not.toThrow();
    expect(runtime).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("revokes persisted expiries after restart, coalesces startup, and continues hourly", async () => {
    const policy = createPolicyFetch();
    vi.stubGlobal("fetch", policy.fetcher);
    const first = registerPlugin();
    await first.start();
    await expect(
      first.execute("visitor_invite", { email: "expired@example.test", days: 1 }),
    ).resolves.toHaveProperty("details", {});
    await expect(
      first.execute("visitor_invite", { email: "active@example.test", days: 2 }),
    ).resolves.toHaveProperty("details", {});
    await first.stop();
    resetPluginStateStoreForTests();
    vi.setSystemTime(START_MS + DAY_MS + 1);
    policy.fetcher.mockClear();

    const restarted = registerPlugin();
    await Promise.all([restarted.start(), restarted.gatewayStart()]);
    expect(policy.emails()).toEqual(["active@example.test"]);
    expect((await restarted.store.entries()).map((entry) => entry.key)).toEqual([
      "active@example.test",
    ]);
    expect(policy.fetcher.mock.calls.filter(([url]) => requestUrl(url).search !== "")).toHaveLength(
      1,
    );
    expect(restarted.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("expired@example.test"),
    );

    vi.setSystemTime(START_MS + 2 * DAY_MS);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(policy.emails()).toEqual([]);
    expect(await restarted.store.entries()).toEqual([]);
    await restarted.stop();
    const callsAfterStop = policy.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(policy.fetcher).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("stops the scheduler, aborts an in-flight sweep, and rejects retained tools", async () => {
    const entered = createDeferred<AbortSignal>();
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Expiry requests must be cancellable");
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(`aborted ${TOKEN}`)), {
          once: true,
        });
        entered.resolve(signal);
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const registered = registerPlugin();
    const starting = registered.start();
    const signal = await entered.promise;
    await registered.stop();
    await starting;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const callsAfterStop = fetcher.mock.calls.length;
    const result = await registered.execute("visitor_invite", { email: "late@example.test" });
    expect(result).toMatchObject({ details: { error: true } });
    expect(fetcher).toHaveBeenCalledTimes(callsAfterStop);
    expect(await registered.store.entries()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(registered.logger.error).not.toHaveBeenCalled();
  });

  it("returns a redacted tool error while retaining the durable record after an ambiguous write", async () => {
    const policy = createPolicyFetch();
    vi.stubGlobal("fetch", policy.fetcher);
    const registered = registerPlugin();
    await registered.start();
    policy.fetcher.mockImplementationOnce(async () => Response.json({ success: true, result: [] }));
    policy.fetcher.mockImplementationOnce(async () => {
      throw new Error(`Transport failure with Authorization: Bearer ${TOKEN}`);
    });
    const result = await registered.execute("visitor_invite", { email: "pending@example.test" });
    expect(result).toMatchObject({ details: { error: true }, content: [{ type: "text" }] });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(await registered.store.lookup("pending@example.test")).toMatchObject({
      email: "pending@example.test",
      invitedVia: "agent:main:maintainer",
      expiresAt: START_MS + 14 * DAY_MS,
    });
  });

  it("routes discovery tools through the Gateway owner and fences them after replacement", async () => {
    const policy = createPolicyFetch();
    vi.stubGlobal("fetch", policy.fetcher);
    const owner = registerPlugin();
    await owner.start();
    let invite: AnyAgentTool | undefined;
    const discovery = createTestPluginApi({
      registrationMode: "tool-discovery",
      registerTool(registration) {
        const tools = typeof registration === "function" ? registration({}) : registration;
        invite =
          (Array.isArray(tools) ? tools : tools ? [tools] : []).find(
            (tool) => tool.name === "visitor_invite",
          ) ?? invite;
      },
    });
    Object.defineProperty(discovery, "runtime", {
      get() {
        throw new Error("Discovery must use the active Gateway owner");
      },
    });
    plugin.register(discovery);
    if (!invite) {
      throw new Error("Discovery did not register visitor_invite");
    }
    await expect(
      invite.execute("invite", { email: "discovered@example.test" }),
    ).resolves.toHaveProperty("details", {});
    expect(await owner.store.lookup("discovered@example.test")).toBeDefined();
    await owner.stop();
    const replacement = registerPlugin();
    await replacement.start();
    const callsBeforeStaleTool = policy.fetcher.mock.calls.length;
    await expect(invite.execute("stale", { email: "late@example.test" })).resolves.toHaveProperty(
      "details.error",
      true,
    );
    expect(policy.fetcher).toHaveBeenCalledTimes(callsBeforeStaleTool);
    await expect(
      replacement.execute("visitor_invite", { email: "current@example.test" }),
    ).resolves.toHaveProperty("details", {});
  });
});
