import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetDeclared,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveManagedGitHubProfileDir } from "../../agents/github-tool-identity.js";
import { createTestBoardStore } from "../../boards/board-store.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { toRequestUrl } from "../../test-utils/provider-usage-fetch.js";
import { readGitHubJsonResponse } from "../control-ui-github-api.js";
import { createBoardHarness } from "./board.test-support.js";

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

describe("board authenticated GitHub Actions", () => {
  let state: OpenClawTestState;
  let config: OpenClawConfig;
  let actions: () => Response | Promise<Response>;
  const http = vi.fn<typeof fetch>();
  const account = vi.fn(async () => json({ id: 100, login: "fixture-user", avatar_url: null }));

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
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    const harness =
      options.harness ??
      createBoardHarness(undefined, {}, createTestBoardStore({ stateDir: state.stateDir }), {
        getRuntimeConfig: () => config,
      });
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
    const response = await read();
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]?.message).toContain("not granted");
    expect(http).not.toHaveBeenCalled();
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
    expect((await read({ repository: "owner/repo", ...invalid })).mock.calls[0]?.[0]).toBe(false);
    expect(http).not.toHaveBeenCalled();
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
    await expect(readGitHubJsonResponse(json(raw))).rejects.toThrow("Content too large");
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

  it("rechecks widget authority after credential verification and every cache follower", async () => {
    const first = await reader();
    const follower = await reader({ harness: first.harness, name: "follower" });
    const started = createDeferred();
    const release = createDeferred();
    actions = async () => {
      started.resolve();
      await release.promise;
      return json(result);
    };
    const leaderRead = first.read();
    await started.promise;
    const followerRead = follower.read();
    await vi.waitFor(() => expect(account).toHaveBeenCalledTimes(2));
    await first.invoke("board.update", {
      sessionKey: "agent:main:runs",
      ops: [{ kind: "widget_remove", name: "follower" }],
    });
    release.resolve();
    expect((await leaderRead).mock.calls[0]?.[0]).toBe(true);
    expect((await followerRead).mock.calls[0]?.[0]).toBe(false);
    expect(actionCalls()).toHaveLength(1);
    account.mockImplementationOnce(async () => {
      await first.invoke("board.update", {
        sessionKey: "agent:main:runs",
        ops: [{ kind: "widget_remove", name: "runs" }],
      });
      return json({ id: 100, login: "fixture-user", avatar_url: null });
    });
    expect((await first.read()).mock.calls[0]?.[0]).toBe(false);
    expect(actionCalls()).toHaveLength(1);
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
