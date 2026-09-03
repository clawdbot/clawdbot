import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetDeclared,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { resolveManagedGitHubProfileDir } from "../../agents/github-tool-identity.js";
import { createTestBoardStore } from "../../boards/board-store.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginBoardWidgetContentKindRegistrar } from "../../plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import * as processExec from "../../process/exec.js";
import * as lazyPromise from "../../shared/lazy-promise.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { toRequestUrl } from "../../test-utils/provider-usage-fetch.js";
import { readGitHubJsonResponse } from "../control-ui-github-api.js";
import { createBoardHarness } from "./board.test-support.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const profileId = "ghp_11111111111111111111111111111111";
const overrideId = "ghp_22222222222222222222222222222222";
const token = "synthetic-board-token";
const run = {
  id: 1,
  name: "CI",
  display_title: "Fix",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/owner/repo/actions/runs/1",
  run_started_at: "2026-09-01T00:00:00Z",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  event: "push",
  workflow_id: 2,
  run_attempt: 1,
};
const result = { total_count: 1, workflow_runs: [run] };
const json = (value: unknown) => new Response(JSON.stringify(value));
const commandResult = (value = "", code = 0) => ({
  stdout: Buffer.from(value),
  stderr: Buffer.alloc(0),
  code,
  signal: null,
  killed: false,
  termination: "exit" as const,
});

function observeSharedReadAdmission() {
  const joined = createDeferred();
  const getOrCreatePromise = lazyPromise.getOrCreatePromise;
  vi.spyOn(lazyPromise, "getOrCreatePromise").mockImplementation((cache, key, create, options) => {
    const pending = cache.get(key);
    const shared = getOrCreatePromise(cache, key, create, options);
    // Credential verification precedes filesystem awaits; wait for actual singleflight admission.
    if (pending === shared) {
      joined.resolve();
    }
    return shared;
  });
  return joined.promise;
}

describe("board authenticated GitHub Actions", () => {
  let state: OpenClawTestState;
  let config: OpenClawConfig;
  let actions: () => Response | Promise<Response>;
  const http = vi.fn<typeof fetch>();
  const account = vi.fn(async () => json({ id: 100, login: "fixture-user", avatar_url: null }));
  const native = vi.fn<typeof processExec.runCommandBuffered>();

  async function writeCredential(
    scope: "system" | "agent",
    id: string,
    credential: string,
    agentId = "main",
  ) {
    const profile = resolveManagedGitHubProfileDir({ agentId, scope, profileId: id });
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(profile, "hosts.yml"),
      `github.com:\n  oauth_token: ${credential}\n`,
      { mode: 0o600 },
    );
  }

  beforeEach(async () => {
    resetPluginRuntimeStateForTest();
    clearGitHubCredentialVerificationCache();
    state = await createOpenClawTestState({
      prefix: "board-github-",
      env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
    });
    config = {
      agents: { entries: { main: { default: true } } },
      tools: { exec: { mode: "full" }, github: { profileId } },
      gateway: { controlUi: { github: { token: "synthetic-preview-only" } } },
    };
    await writeCredential("system", profileId, token);
    native.mockReset().mockRejectedValue(new Error("Unexpected native credential subprocess"));
    vi.spyOn(processExec, "runCommandBuffered").mockImplementation(native);
    actions = () => json(result);
    account
      .mockReset()
      .mockImplementation(async () => json({ id: 100, login: "fixture-user", avatar_url: null }));
    http
      .mockReset()
      .mockImplementation(async (url) =>
        toRequestUrl(url).endsWith("/user") ? account() : actions(),
      );
    vi.stubGlobal("fetch", http);
  });

  function createGitHubBoardHarness(
    readCanvas?: Parameters<typeof createBoardHarness>[0],
    dependencies: Parameters<typeof createBoardHarness>[1] = {},
  ) {
    return createBoardHarness(
      readCanvas,
      dependencies,
      createTestBoardStore({ stateDir: state.stateDir }),
      {
        getRuntimeConfig: () => config,
      },
    );
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetPluginRuntimeStateForTest();
    await state?.cleanup();
  });

  async function reader(
    options: {
      declared?: BoardWidgetDeclared;
      harness?: ReturnType<typeof createBoardHarness>;
      name?: string;
      agentId?: string;
    } = {},
  ) {
    const harness = options.harness ?? createGitHubBoardHarness();
    const name = options.name ?? "runs";
    const sessionKey = `agent:${options.agentId ?? "main"}:runs`;
    await harness.invoke("board.widget.put", {
      sessionKey,
      name,
      content: { kind: "html", html: "runs" },
      declared: options.declared ?? { tools: ["github.actions.runs:Owner/Repo"] },
    });
    const board = await harness.invoke("board.get", { sessionKey });
    const snapshot = board.mock.calls[0]![1] as BoardSnapshot;
    const widget = snapshot.widgets.find((candidate) => candidate.name === name)!;
    return {
      ...harness,
      harness,
      widget,
      read: (params: Record<string, unknown> = { repository: "owner/repo" }) =>
        harness.invoke("board.data.read", {
          ticket: widget.viewTicket,
          bindingId: "github.actions.runs",
          params,
        }),
    };
  }
  const actionCalls = () => http.mock.calls.filter(([url]) => !toRequestUrl(url).endsWith("/user"));

  it.each(["missing managed", "invalid managed", "missing native", "native failure"] as const)(
    "rejects pinning with %s identity before changing an existing widget",
    async (unavailable) => {
      const { invoke, store, broadcast } = createGitHubBoardHarness();
      const target = { sessionKey: "agent:main:runs", agentId: "main" };
      await invoke("board.widget.put", {
        ...target,
        name: "runs",
        content: { kind: "html", html: "original" },
      });
      const before = store.getSnapshot(target);
      broadcast.mockClear();
      if (unavailable === "missing native" || unavailable === "native failure") {
        delete config.tools!.github;
        if (unavailable === "native failure") {
          native.mockRejectedValue(new Error(token));
        } else {
          native.mockImplementation(async () => commandResult("", 1));
        }
      } else if (unavailable === "missing managed") {
        await fs.rm(
          resolveManagedGitHubProfileDir({ agentId: "main", scope: "system", profileId }),
          { recursive: true },
        );
      } else {
        await writeCredential("system", profileId, "invalid token");
      }
      const response = await invoke("board.widget.put", {
        ...target,
        name: "runs",
        content: { kind: "html", html: "replacement" },
        declared: { tools: ["github.actions.runs:Owner/Repo"] },
      });
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[2]?.message).toMatch(/reconnect|retry/);
      expect(JSON.stringify(response.mock.calls)).not.toContain(token);
      expect(store.getSnapshot(target)).toEqual(before);
      expect(store.readWidgetHtml(target, "runs")?.html).toContain("original");
      expect(broadcast).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      if (unavailable === "missing managed" || unavailable === "invalid managed") {
        expect(native).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["html", "canvas-doc", "registered"] as const)(
    "verifies identity before saving %s host capabilities and preserves it on failed update",
    async (kind) => {
      if (kind === "registered") {
        const registry = createEmptyPluginRegistry();
        createPluginBoardWidgetContentKindRegistrar(registry)(
          createPluginRecord({
            id: "fixture",
            source: "fixture",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          {
            kind: "fixture",
            label: "Fixture",
            resources: { surface: "fixture", paths: ["/widget.js"] },
            validateSource: () => {},
            composeDocument: ({ source }) => source,
          },
        );
        setActivePluginRegistry(registry);
      }
      const { invoke, store, broadcast } = createGitHubBoardHarness(async () => ({
        html: "canvas",
        cspSandbox: "scripts",
      }));
      const target = { sessionKey: "agent:main:runs", agentId: "main" };
      const input = {
        ...target,
        name: "runs",
        content:
          kind === "registered"
            ? { kind, contentKind: "fixture", source: "runs" }
            : kind === "canvas-doc"
              ? { kind, docId: "fixture" }
              : { kind, html: "runs" },
        declared: { tools: ["github.actions.runs:Owner/Repo"] },
      };
      expect((await invoke("board.widget.put", input)).mock.calls[0]?.[0]).toBe(true);
      expect(account).toHaveBeenCalledOnce();
      expect(native).not.toHaveBeenCalled();
      expect(actionCalls()).toHaveLength(0);
      expect(store.getSnapshot(target).widgets[0]?.declared?.tools).toEqual([
        "github.actions.runs:owner/repo",
      ]);
      const before = store.getSnapshot(target);
      broadcast.mockClear();
      // Verified credentials are reused within their TTL; expire the entry so the
      // next pin must prove the credential again.
      clearGitHubCredentialVerificationCache();
      account.mockImplementationOnce(async () => new Response(token, { status: 401 }));
      const denied = await invoke("board.widget.put", input);
      expect(denied.mock.calls[0]?.[0]).toBe(false);
      expect(denied.mock.calls[0]?.[2]?.message).toMatch(/reconnect|retry/);
      expect(JSON.stringify(denied.mock.calls)).not.toContain(token);
      expect(store.getSnapshot(target)).toEqual(before);
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("pins with native authentication without a worktree and scrubs preview credentials", async () => {
    delete config.tools!.github;
    config.gateway!.controlUi!.github!.token = {
      source: "env",
      provider: "default",
      id: "GH_TOKEN",
    };
    state.envVars.GH_TOKEN = "synthetic-preview-only";
    state.envVars.GITHUB_TOKEN = "synthetic-native-token";
    state.applyEnv();
    native.mockImplementation(async (argv, options) => {
      expect(argv).toEqual(["gh", "auth", "token", "--hostname", "github.com"]);
      expect(options?.env?.GH_TOKEN).toBeUndefined();
      return commandResult(options?.env?.GITHUB_TOKEN);
    });
    const { invoke } = createGitHubBoardHarness();
    const response = await invoke("board.widget.put", {
      sessionKey: "agent:main:runs",
      name: "native",
      content: { kind: "html", html: "runs" },
      declared: { tools: ["github.actions.runs:owner/repo"] },
    });
    expect(response.mock.calls[0]?.[0]).toBe(true);
    expect(http.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer synthetic-native-token" },
    });
    expect(actionCalls()).toHaveLength(0);
    expect(JSON.stringify(response.mock.calls)).not.toContain("synthetic-native-token");
  });

  it.each(["ordinary", "mcp-app"] as const)(
    "does not probe GitHub for an %s widget",
    async (kind) => {
      delete config.tools!.github;
      const { invoke, store, mcpApp } = createGitHubBoardHarness();
      vi.mocked(mcpApp.resolveAllowedToolNames).mockResolvedValue([
        "github.actions.runs:owner/repo",
      ]);
      const response = await invoke("board.widget.put", {
        sessionKey: "agent:main:runs",
        name: "other",
        content: kind === "mcp-app" ? { kind, viewId: "fixture" } : { kind: "html", html: "plain" },
      });
      expect(response.mock.calls[0]?.[0]).toBe(true);
      if (kind === "mcp-app") {
        expect(
          store.readWidgetMcpApp({ sessionKey: "agent:main:runs", agentId: "main" }, "other")
            ?.declaredTools,
        ).toEqual(["github.actions.runs:owner/repo"]);
      }
      expect(native).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
    },
  );

  it.each([
    "gateway",
    "signal",
    "commit guard",
    "session authorization",
    "profile",
    "credential",
    "agent",
    "routing",
  ] as const)(
    "rejects pinning when %s authority changes during verification without persistence",
    async (changed) => {
      const { handlers, context, store, broadcast } = createGitHubBoardHarness();
      const target = { sessionKey: "agent:main:runs", agentId: "main" };
      const before = store.getSnapshot(target);
      const controller = new AbortController();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Caller authority retired");
        }
      };
      const respond = vi.fn<RespondFn>();
      const input = {
        ...target,
        name: "runs",
        content: { kind: "html", html: "runs" },
        declared: { tools: ["github.actions.runs:owner/repo"] },
      };
      const invocation: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "pin", method: "board.widget.put", params: input },
        params: input,
        client: null,
        isWebchatConnect: () => false,
        respond,
        context,
        signal: controller.signal,
        ...(changed === "commit guard" ? { sessionMutationCommitGuard: assertCurrent } : {}),
        ...(changed === "session authorization"
          ? { sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: assertCurrent } }
          : {}),
      };
      account.mockImplementationOnce(async () => {
        current = false;
        if (changed === "gateway") {
          context.resolveGatewayContext = () => undefined;
        }
        if (changed === "signal") {
          controller.abort();
        }
        if (changed === "profile") {
          config.tools!.github = { profileId: overrideId };
        }
        if (changed === "credential") {
          await writeCredential("system", profileId, "synthetic-rotated-token");
        }
        if (changed === "agent") {
          config.agents = { entries: { other: { default: true } } };
        }
        if (changed === "routing") {
          config.session = { scope: "global", mainKey: "runs" };
        }
        return json({ id: 100, login: "fixture-user", avatar_url: null });
      });
      await handlers["board.widget.put"]!(invocation);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(store.getSnapshot(target)).toEqual(before);
      expect(broadcast).not.toHaveBeenCalled();
      expect(actionCalls()).toHaveLength(0);
    },
  );

  it("reads authenticated Actions at the real board boundary with a canonical repository grant", async () => {
    const { read, widget } = await reader();
    const response = await read({ repository: "OWNER/REPO" });
    expect(response.mock.calls[0]).toEqual([true, result]);
    expect(widget.declared?.tools).toEqual(["github.actions.runs:owner/repo"]);
    expect(widget.declaredSummary?.join(" ")).toContain("private repository data");
    const [url, init] = actionCalls()[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/actions/runs?per_page=20&exclude_pull_requests=true",
    );
    expect(init?.method ?? "GET").toBe("GET");
    expect(init).toMatchObject({
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(response.mock.calls)).not.toContain(token);
    expect(JSON.stringify(http.mock.calls)).not.toContain("synthetic-preview-only");
  });

  it.each([
    { netOrigins: ["https://api.github.com"] },
    { tools: ["github.actions.runs"] },
    { tools: ["github.actions.runs:owner/other"] },
  ])("rejects an insufficient repository grant before credentials: %j", async (declared) => {
    const { read } = await reader({ declared });
    const callsBeforeRead = http.mock.calls.length;
    const response = await read();
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]?.message).toContain("not granted");
    expect(http).toHaveBeenCalledTimes(callsBeforeRead);
  });

  it.each([
    { repository: "../repo" },
    { repository: "owner/repo/extra" },
    { repository: "owner/.." },
    { perPage: 0 },
    { perPage: 31 },
    { perPage: 1.5 },
    { workflow: "../ci.yml" },
    { branch: "main\n" },
    { branch: `bad${String.fromCharCode(0)}branch` },
    { branch: `bad${String.fromCharCode(0x7f)}branch` },
    { created: "2026-02-30" },
    { status: "unknown" },
    { excludePullRequests: "true" },
    ...["agentId", "profile", "token", "headers", "url", "method", "maxBytes"].map((field) => ({
      [field]: "forbidden",
    })),
  ])("rejects malformed or authority-overriding params before credentials: %j", async (invalid) => {
    const { read } = await reader();
    const callsBeforeRead = http.mock.calls.length;
    expect((await read({ repository: "owner/repo", ...invalid })).mock.calls[0]?.[0]).toBe(false);
    expect(http).toHaveBeenCalledTimes(callsBeforeRead);
  });

  it.each([23, "ci.yml"])(
    "encodes the documented workflow/filter request for %s",
    async (workflow) => {
      const { read } = await reader();
      expect(
        (
          await read({
            repository: "owner/repo",
            workflow,
            branch: "fix/a&b",
            status: "failure",
            created: ">=2026-09-01",
            excludePullRequests: false,
          })
        ).mock.calls[0]?.[0],
      ).toBe(true);
      const url = new URL(toRequestUrl(actionCalls()[0]![0]));
      expect(url.origin).toBe("https://api.github.com");
      expect(url.pathname).toBe(`/repos/owner/repo/actions/workflows/${workflow}/runs`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        per_page: "20",
        exclude_pull_requests: "false",
        branch: "fix/a&b",
        status: "failure",
        created: ">=2026-09-01",
      });
    },
  );

  it.each([
    "https://example.test/steal",
    "https://api.github.com/repos/owner/other/actions/runs",
    "https://api.github.com/repos/owner/repo/issues",
  ])("does not follow redirect %s", async (location) => {
    actions = () => new Response(null, { status: 302, headers: { location } });
    const { read } = await reader();
    const response = await read();
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(actionCalls()).toHaveLength(1);
    expect(JSON.stringify(response.mock.calls)).not.toContain(token);
  });

  it("accepts thirty large raw runs under 1MiB, projects them, and retains the shared 256KiB default", async () => {
    const runs = Array.from({ length: 30 }, () => ({
      ...run,
      repository: { description: "x".repeat(12_000) },
    }));
    const raw = { total_count: 30, workflow_runs: runs };
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(256 * 1024);
    await expect(readGitHubJsonResponse(json(raw))).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("size limit"),
    });
    actions = () => json(raw);
    const { read } = await reader();
    expect((await read({ repository: "owner/repo", perPage: 30 })).mock.calls[0]).toEqual([
      true,
      { total_count: 30, workflow_runs: Array.from({ length: 30 }, () => run) },
    ]);
    actions = () => json({ ...raw, extra: "x".repeat(1024 * 1024) });
    expect(
      (await read({ repository: "owner/repo", perPage: 30, branch: "large" })).mock.calls[0]?.[0],
    ).toBe(false);
  });

  it.each([
    { total_count: -1, workflow_runs: [] },
    { total_count: 1, workflow_runs: [{ ...run, id: "1" }] },
    { total_count: 1, workflow_runs: [{ ...run, display_title: "x".repeat(1025) }] },
    { total_count: 1, workflow_runs: [{ ...run, html_url: "https://example.test/" }] },
    { total_count: 1, workflow_runs: [{ ...run, display_title: token }] },
    { total_count: 31, workflow_runs: Array.from({ length: 31 }, () => run) },
  ])("rejects an unsafe upstream projection", async (raw) => {
    actions = () => json(raw);
    const response = await (await reader()).read();
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(response.mock.calls)).not.toContain(token);
  });

  it.each([
    { status: 403, headers: undefined, message: "access denied" },
    { status: 403, headers: { "x-ratelimit-remaining": "0" }, message: "rate limited" },
    { status: 429, headers: undefined, message: "rate limited" },
    { status: 401, headers: undefined, message: "reconnect" },
    { status: 500, headers: undefined, message: "request failed" },
  ])(
    "sanitizes HTTP $status without anonymous retry ($message)",
    async ({ status, headers, message }) => {
      actions = () => new Response(token, { status, headers });
      const { read } = await reader();
      const response = await read();
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[2]?.message).toContain(message);
      expect(JSON.stringify(response.mock.calls)).not.toContain(token);
      expect(actionCalls()).toHaveLength(1);
      actions = () => json(result);
      expect((await read()).mock.calls[0]).toEqual([true, result]);
      expect(actionCalls()).toHaveLength(2);
    },
  );

  it("uses the board agent's override and fails closed when that configured profile disappears", async () => {
    await writeCredential("agent", overrideId, "synthetic-agent-token", "builder");
    config.agents = {
      entries: {
        main: { default: true },
        builder: { tools: { github: { profileId: overrideId } } },
      },
    };
    const { read } = await reader({ agentId: "builder" });
    expect((await read()).mock.calls[0]?.[0]).toBe(true);
    expect(actionCalls()[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer synthetic-agent-token" },
    });
    await fs.rm(
      resolveManagedGitHubProfileDir({ agentId: "builder", scope: "agent", profileId: overrideId }),
      { recursive: true },
    );
    const unavailable = await read();
    expect(unavailable.mock.calls[0]?.[2]?.message).toContain("reconnect");
    expect(actionCalls()).toHaveLength(1);
  });

  it("coalesces successful reads and scopes cache entries to filters and current credentials", async () => {
    const started = createDeferred();
    const release = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const { read } = await reader();
    const first = read();
    const second = read();
    await started.promise;
    release.resolve();
    expect((await first).mock.calls[0]).toEqual([true, result]);
    expect((await second).mock.calls[0]).toEqual([true, result]);
    expect((await read()).mock.calls[0]).toEqual([true, result]);
    expect(actionCalls()).toHaveLength(1);
    await read({ repository: "owner/repo", branch: "other" });
    expect(actionCalls()).toHaveLength(2);
    await writeCredential("system", profileId, "synthetic-rotated-token");
    await read();
    expect(actionCalls()).toHaveLength(3);
    expect(actionCalls()[2]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer synthetic-rotated-token" },
    });
    const freshGateway = await reader();
    await freshGateway.read();
    expect(actionCalls()).toHaveLength(4);
  });

  it.each(["widget", "grant", "gateway", "identity", "token", "agent"] as const)(
    "rejects stale %s authority across an awaited fetch",
    async (changed) => {
      const started = createDeferred();
      const release = createDeferred();
      actions = async () => {
        started.resolve();
        await release.promise;
        return json(result);
      };
      const { read, invoke, context } = await reader();
      const pending = read();
      await started.promise;
      if (changed === "widget") {
        await invoke("board.widget.put", {
          sessionKey: "agent:main:runs",
          name: "runs",
          content: { kind: "html", html: "replacement" },
          declared: { tools: ["github.actions.runs:owner/repo"] },
        });
      }
      if (changed === "grant") {
        await invoke("board.widget.put", {
          sessionKey: "agent:main:runs",
          name: "runs",
          content: { kind: "html", html: "runs" },
        });
      }
      if (changed === "gateway") {
        context.resolveGatewayContext = () => undefined;
      }
      if (changed === "identity") {
        config.tools!.github = { profileId: overrideId };
      }
      if (changed === "token") {
        await writeCredential("system", profileId, "synthetic-rotated-token");
      }
      if (changed === "agent") {
        config.agents = { entries: { other: { default: true } } };
      }
      release.resolve();
      expect((await pending).mock.calls[0]?.[0]).toBe(false);
    },
  );

  it.each(["leader", "follower"] as const)(
    "isolates a removed %s from the surviving shared read and rechecks cached authority",
    async (removed) => {
      const leader = await reader({ name: "leader" });
      const follower = await reader({ harness: leader.harness, name: "follower" });
      const started = createDeferred();
      const release = createDeferred();
      actions = async () => {
        started.resolve();
        await release.promise;
        return json(result);
      };
      const leaderRead = leader.read();
      await started.promise;
      const joined = observeSharedReadAdmission();
      const followerRead = follower.read();
      await joined;
      await leader.invoke("board.update", {
        sessionKey: "agent:main:runs",
        ops: [{ kind: "widget_remove", name: removed }],
      });
      release.resolve();
      const responses = { leader: await leaderRead, follower: await followerRead };
      const surviving = removed === "leader" ? "follower" : "leader";
      expect(responses[removed].mock.calls[0]).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "board widget view ticket is stale",
        }),
      ]);
      expect(responses[surviving].mock.calls[0]).toEqual([true, result]);
      expect(actionCalls()).toHaveLength(1);
      const survivor = surviving === "leader" ? leader : follower;
      expect((await survivor.read()).mock.calls[0]).toEqual([true, result]);
      expect(actionCalls()).toHaveLength(1);
      clearGitHubCredentialVerificationCache();
      account.mockImplementationOnce(async () => {
        await survivor.invoke("board.update", {
          sessionKey: "agent:main:runs",
          ops: [{ kind: "widget_remove", name: surviving }],
        });
        return json({ id: 100, login: "fixture-user", avatar_url: null });
      });
      expect((await survivor.read()).mock.calls[0]?.[0]).toBe(false);
      expect(actionCalls()).toHaveLength(1);
    },
  );

  it("keeps shared transport available after a removed leader exits while a follower revalidates", async () => {
    delete config.tools!.github;
    native.mockImplementation(async () => commandResult(token));
    const leader = await reader({ name: "leader" });
    const follower = await reader({ harness: leader.harness, name: "follower" });
    const third = await reader({ harness: leader.harness, name: "third" });
    const started = createDeferred();
    const release = createDeferred();
    const rereading = createDeferred();
    const resume = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const leaderRead = leader.read();
    await started.promise;
    const joined = observeSharedReadAdmission();
    const followerRead = follower.read();
    await joined;
    await leader.invoke("board.update", {
      sessionKey: "agent:main:runs",
      ops: [{ kind: "widget_remove", name: "leader" }],
    });
    native.mockImplementationOnce(async () => {
      rereading.resolve();
      await resume.promise;
      return commandResult(token);
    });
    release.resolve();
    try {
      await rereading.promise;
      expect((await leaderRead).mock.calls[0]?.[0]).toBe(false);
      expect((await third.read()).mock.calls[0]).toEqual([true, result]);
      expect(actionCalls()).toHaveLength(1);
    } finally {
      resume.resolve();
      await followerRead;
    }
    expect((await followerRead).mock.calls[0]).toEqual([true, result]);
  });

  it("bounds concurrent callers without retaining failed work", async () => {
    const started = createDeferred();
    const release = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const { read } = await reader();
    const pending = Array.from({ length: 32 }, () => read());
    await started.promise;
    expect((await read()).mock.calls[0]?.[2]?.message).toContain("busy");
    release.resolve();
    expect(
      (await Promise.all(pending)).every((response) => response.mock.calls[0]?.[0] === true),
    ).toBe(true);
    expect((await read()).mock.calls[0]?.[0]).toBe(true);
  });
});
