import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerPrewriteRequestCancellationError,
} from "./client.js";
import { CodexCustomProviderClientBinding } from "./custom-provider-client.js";
import { CODEX_CUSTOM_PROVIDER_API_KEY_ENV } from "./custom-provider.js";
import { CodexAppServerScopedRequestRejectedError } from "./request-errors.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";
import { CodexAppServerStartSelectionChangedError } from "./start-selection-error.js";
import { createClientHarness } from "./test-support.js";

const binding = { provider: "proxy", baseUrl: "https://proxy.example/v1" };
const errors = {
  cancellation: (reason: "aborted" | "timed out", cause?: unknown) => new Error(reason, { cause }),
  rejection: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
};
function fixture() {
  const config = {
    allow_login_shell: false,
    features: { shell_snapshot: false },
    shell_environment_policy: { experimental_use_profile: false, set: { CODEX_API_KEY: "" } },
    model_providers: {
      proxy: {
        base_url: binding.baseUrl,
        env_key: CODEX_CUSTOM_PROVIDER_API_KEY_ENV,
        wire_api: "responses",
      },
    },
  };
  const read = vi.fn(async (method: string) =>
    method === "thread/read"
      ? { thread: { modelProvider: "proxy", cwd: "/workspace" } }
      : { config },
  );
  const send = vi.fn(async () => ({ modelProvider: "proxy" }));
  const cleanupRejectedSession = vi.fn(async () => {});
  const client = new CodexCustomProviderClientBinding(
    binding,
    "/workspace",
    cleanupRejectedSession,
  );
  return { config, read, send, client, cleanupRejectedSession };
}

describe("prepared custom provider request binding", () => {
  it.each(["command/exec", "process/spawn"])(
    "scrubs workload keys from %s request overlays",
    async (method) => {
      const f = fixture();
      expect(f.client.handles(method)).toBe(true);
      await f.client.request({
        errors,
        method,
        options: {},
        read: f.read,
        send: f.send,
        input: {
          command: ["command"],
          env: { CODEX_API_KEY: "synthetic-overlay", KEEP_THIS: "kept" },
        },
      });
      expect(f.send).toHaveBeenCalledWith(
        { command: ["command"], env: { CODEX_API_KEY: "", KEEP_THIS: "kept" } },
        {},
      );
    },
  );
  it("keeps thread overrides from restoring the native workload key or shell snapshots", async () => {
    const f = fixture();
    await f.client.request({
      errors,
      method: "thread/start",
      options: {},
      read: f.read,
      send: f.send,
      input: {
        config: {
          allow_login_shell: true,
          "features.shell_snapshot": true,
          shell_environment_policy: {
            experimental_use_profile: true,
            set: { CODEX_API_KEY: "synthetic-thread-key", KEEP_THIS: "kept" },
          },
        },
      },
    });
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          allow_login_shell: false,
          "features.shell_snapshot": false,
          shell_environment_policy: {
            experimental_use_profile: false,
            set: { CODEX_API_KEY: "", KEEP_THIS: "kept" },
          },
        },
      }),
      {},
    );
  });

  it.each(["thread/start", "thread/resume", "thread/fork"])(
    "binds the final %s request to the verified native provider",
    async (method) => {
      const f = fixture();
      await f.client.request({
        errors,
        method,
        input: { threadId: "thread", model: "model" },
        options: {},
        read: f.read,
        send: f.send,
      });
      expect(f.send).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread", model: "model", modelProvider: "proxy" }),
        {},
      );
      expect(f.read).toHaveBeenCalledWith(
        "config/read",
        { cwd: "/workspace", includeLayers: true },
        {},
      );
    },
  );

  it.each(["turn/start", "thread/compact/start"])(
    "rejects wrong existing thread ownership for %s",
    async (method) => {
      const f = fixture();
      const read = vi.fn(async (readMethod: string) =>
        readMethod === "thread/read"
          ? { thread: { modelProvider: "openai" } }
          : { config: f.config },
      );
      await expect(
        f.client.request({
          errors,
          method,
          input: { threadId: "wrong" },
          options: {},
          read,
          send: f.send,
        }),
      ).rejects.toThrow("different provider");
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it.each(["thread/resume", "thread/fork"])(
    "applies the selected provider to %s of another provider's history",
    async (method) => {
      const f = fixture();
      const read = vi.fn(async (readMethod: string) =>
        readMethod === "thread/read"
          ? { thread: { modelProvider: "openai", cwd: "/workspace" } }
          : { config: f.config },
      );
      await f.client.request({
        errors,
        method,
        input: { threadId: "source-thread" },
        options: {},
        read,
        send: f.send,
      });
      expect(f.send).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "source-thread", modelProvider: "proxy" }),
        {},
      );
    },
  );

  it.each(["selected-session", "different-session", "unloaded", "rejected-resume"] as const)(
    "trusts a resumed provider only for its exact loaded native session: %s",
    async (condition) => {
      const f = fixture();
      const thread = {
        id: "thread",
        sessionId: "selected-session",
        modelProvider: "openai",
        cwd: "/workspace",
        status: { type: "idle" },
      };
      const read = vi.fn(async (method: string) =>
        method === "thread/read" ? { thread } : { config: f.config },
      );
      const send = vi.fn(async () => ({
        modelProvider: "proxy",
        thread: { id: "thread", sessionId: "selected-session" },
      }));
      const request = { errors, input: { threadId: "thread" }, options: {}, read, send };
      await f.client.request({ ...request, method: "thread/resume" });
      if (condition === "different-session") {
        thread.sessionId = "replacement-session";
      } else if (condition === "unloaded") {
        thread.status.type = "notLoaded";
      } else if (condition === "rejected-resume") {
        send.mockResolvedValueOnce({
          modelProvider: "wrong-provider",
          thread: { id: "thread", sessionId: "selected-session" },
        });
        await expect(f.client.request({ ...request, method: "thread/resume" })).rejects.toThrow(
          "different provider",
        );
      }
      send.mockClear();
      const turn = f.client.request({ ...request, method: "turn/start" });
      if (condition === "selected-session") {
        await turn;
        expect(send).toHaveBeenCalledOnce();
      } else {
        await expect(turn).rejects.toThrow("different provider");
        expect(send).not.toHaveBeenCalled();
      }
    },
  );

  it("rechecks config on an existing process before its next turn", async () => {
    const f = fixture();
    const params = {
      errors,
      method: "turn/start",
      input: { threadId: "thread" },
      options: {},
      read: f.read,
      send: f.send,
    };
    await f.client.request(params);
    f.config.model_providers.proxy.base_url = "https://different.example/v1";
    await expect(f.client.request(params)).rejects.toThrow("endpoint does not match");
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each([
    { config: { "model_providers.proxy.env_key": "OTHER_KEY" } },
    { modelProvider: "openai" },
    { approvalsReviewer: "auto_review" },
  ])("rejects a conflicting final request before network writes: %j", async (input) => {
    const f = fixture();
    await expect(
      f.client.request({
        errors,
        method: "thread/start",
        input,
        options: {},
        read: f.read,
        send: f.send,
      }),
    ).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("rechecks caller authority after awaiting effective config", async () => {
    const f = fixture();
    const controller = new AbortController();
    const read = async () => {
      controller.abort();
      return { config: f.config };
    };
    await expect(
      f.client.request({
        errors,
        method: "thread/start",
        input: {},
        options: { signal: controller.signal },
        read,
        send: f.send,
      }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("custom provider client lifecycle", () => {
  const clients: CodexAppServerClient[] = [];
  function customProviderConfig() {
    return {
      allow_login_shell: false,
      features: { shell_snapshot: false },
      shell_environment_policy: { experimental_use_profile: false, set: { CODEX_API_KEY: "" } },
      model_providers: {
        proxy: {
          base_url: "https://proxy.example/v1",
          env_key: CODEX_CUSTOM_PROVIDER_API_KEY_ENV,
        },
      },
    };
  }

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
  });

  it.each([
    "thread/unsubscribe",
    "thread/delete",
    "thread/archive",
    "failed-unsubscribe",
    "thread/closed",
    "thread/deleted",
    "thread/archived",
    "thread/status/changed",
  ])("forgets only the ended provider session after %s", async (event) => {
    const config = customProviderConfig();
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line);
        const thread = {
          id: request.params.threadId,
          sessionId: `session-${request.params.threadId}`,
          modelProvider: "openai",
          status: { type: "idle" },
        };
        const result =
          request.method === "config/read"
            ? { config }
            : request.method === "thread/read"
              ? { thread }
              : request.method === "thread/resume"
                ? { modelProvider: "proxy", thread }
                : {};
        queueMicrotask(() =>
          send({
            id: request.id,
            ...(event === "failed-unsubscribe" && request.method === "thread/unsubscribe"
              ? { error: { code: -32603, message: "cleanup failed" } }
              : { result }),
          }),
        );
      },
    });
    clients.push(harness.client);
    harness.client.bindCustomProvider(binding, "/workspace");
    await harness.client.request("thread/resume", { threadId: "ended" });
    await harness.client.request("thread/resume", { threadId: "retained" });
    if (
      ["thread/unsubscribe", "thread/delete", "thread/archive", "failed-unsubscribe"].includes(
        event,
      )
    ) {
      config.model_providers.proxy.base_url = "https://changed.example/v1";
      const writesBeforeCleanup = harness.writes.length;
      const method = event === "failed-unsubscribe" ? "thread/unsubscribe" : event;
      const cleanup = harness.client.request(method, { threadId: "ended" });
      if (event === "failed-unsubscribe") {
        await expect(cleanup).rejects.toThrow("cleanup failed");
      } else {
        await cleanup;
      }
      expect(
        harness.writes.slice(writesBeforeCleanup).map((line) => JSON.parse(line).method),
      ).toEqual([method]);
      config.model_providers.proxy.base_url = binding.baseUrl;
    } else {
      harness.send({
        method: event,
        params: { threadId: "ended", status: { type: "notLoaded" } },
      });
    }
    await expect(
      harness.client.request("turn/start", { threadId: "ended", input: [] }),
    ).rejects.toThrow("different provider");
    await harness.client.request("turn/start", { threadId: "retained", input: [] });
    const turns = harness.writes
      .map((line) => JSON.parse(line))
      .filter((request) => request.method === "turn/start");
    expect(turns.map((request) => request.params.threadId)).toEqual(["retained"]);
  });

  it.each(["aborted", "timed out"] as const)(
    "marks custom-provider config validation cancellation as prewrite when %s",
    async (reason) => {
      vi.useFakeTimers();
      const harness = createClientHarness();
      clients.push(harness.client);
      harness.client.bindCustomProvider(
        { provider: "proxy", baseUrl: "https://proxy.example/v1" },
        "/workspace",
      );
      const controller = new AbortController();
      const request = harness.client.request(
        "turn/start",
        { threadId: "thread", input: [] },
        {
          signal: controller.signal,
          timeoutMs: 1_000,
        },
      );
      const outcome = request.catch((error: unknown) => error);
      const readThread = JSON.parse(await harness.waitForWrite(0));
      expect(readThread.method).toBe("thread/read");
      harness.send({
        id: readThread.id,
        result: { thread: { modelProvider: "proxy", cwd: "/workspace" } },
      });
      const readConfig = JSON.parse(await harness.waitForWrite(1));
      expect(readConfig.method).toBe("config/read");
      if (reason === "aborted") {
        controller.abort();
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const error = await outcome;
      expect(error).toMatchObject({
        message: `turn/start ${reason}`,
        code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
        reason,
        mayHaveWritten: false,
        cause: { message: `config/read ${reason}`, mayHaveWritten: true },
      });
      expect(isCodexAppServerPrewriteRequestCancellationError(error)).toBe(true);
      expect(isCodexAppServerIndeterminateRequestCancellationError(error)).toBe(false);
      expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual([
        "thread/read",
        "config/read",
      ]);
    },
  );

  it.each(["thread/read", "config/read"])(
    "shares one overload retry budget across %s preflight and the mutation",
    async (overloadedMethod) => {
      vi.useFakeTimers();
      let overloadedReads = 0;
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line);
          const overloaded =
            request.method === overloadedMethod
              ? ++overloadedReads <= 3
              : request.method === "turn/start";
          queueMicrotask(() =>
            send({
              id: request.id,
              ...(overloaded
                ? { error: { code: -32_001, message: "Server overloaded; retry later." } }
                : {
                    result:
                      request.method === "thread/read"
                        ? { thread: { modelProvider: "proxy" } }
                        : { config: customProviderConfig() },
                  }),
            }),
          );
        },
      });
      clients.push(harness.client);
      harness.client.bindCustomProvider(binding, "/workspace");
      const outcome = harness.client
        .request("turn/start", { threadId: "thread", input: [] }, { timeoutMs: 30_000 })
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({ code: -32_001, method: "turn/start" });
      const methods = harness.writes.map((line) => JSON.parse(line).method);
      expect(methods.filter((method) => method === overloadedMethod)).toHaveLength(4);
      expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

  it.each(["thread/read", "config/read"])(
    "stops persistent %s preflight overload after four attempts",
    async (overloadedMethod) => {
      vi.useFakeTimers();
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line);
          queueMicrotask(() =>
            send({
              id: request.id,
              ...(request.method === overloadedMethod
                ? { error: { code: -32_001, message: "Server overloaded; retry later." } }
                : { result: { thread: { modelProvider: "proxy" } } }),
            }),
          );
        },
      });
      clients.push(harness.client);
      harness.client.bindCustomProvider(binding, "/workspace");
      const outcome = harness.client
        .request("turn/start", { threadId: "thread", input: [] }, { timeoutMs: 30_000 })
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({ code: -32_001, method: overloadedMethod });
      const methods = harness.writes.map((line) => JSON.parse(line).method);
      expect(methods.filter((method) => method === overloadedMethod)).toHaveLength(4);
      expect(methods).not.toContain("turn/start");
    },
  );

  it.each(["aborted", "timed out"] as const)(
    "keeps resume prewrite when %s during preflight overload backoff",
    async (reason) => {
      vi.useFakeTimers();
      const harness = createClientHarness();
      clients.push(harness.client);
      harness.client.bindCustomProvider(binding, "/workspace");
      const releaseGuard = vi.fn();
      harness.client.setThreadSessionRequestGuard(async () => releaseGuard);
      const controller = new AbortController();
      const outcome = harness.client
        .request(
          "thread/resume",
          { threadId: "thread" },
          {
            signal: controller.signal,
            timeoutMs: 10,
          },
        )
        .catch((error: unknown) => error);
      const read = JSON.parse(await harness.waitForWrite(0));
      harness.send({
        id: read.id,
        error: { code: -32_001, message: "Server overloaded; retry later." },
      });
      await vi.advanceTimersByTimeAsync(0);
      if (reason === "aborted") {
        controller.abort();
      }
      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({
        message: `thread/resume ${reason}`,
        mayHaveWritten: false,
      });
      expect(harness.writes).toHaveLength(1);
      expect(releaseGuard).toHaveBeenCalledOnce();
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

  it("preserves client-replacement identity after custom-provider validation reads", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    harness.client.bindCustomProvider(
      { provider: "proxy", baseUrl: "https://proxy.example/v1" },
      "/workspace",
    );
    const selectionChanged = new CodexAppServerStartSelectionChangedError();
    let replaced = false;
    const outcome = harness.client
      .request(
        "thread/resume",
        { threadId: "thread" },
        {
          assertCurrent: () => {
            if (replaced) {
              throw selectionChanged;
            }
          },
        },
      )
      .catch((error: unknown) => error);
    const readThread = JSON.parse(await harness.waitForWrite(0));
    replaced = true;
    harness.send({
      id: readThread.id,
      result: {
        thread: { modelProvider: "proxy" },
      },
    });
    expect(await outcome).toBe(selectionChanged);
    expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual(["thread/read"]);
  });

  it("keeps custom-provider cancellation indeterminate after the turn was sent", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    harness.client.bindCustomProvider(
      { provider: "proxy", baseUrl: "https://proxy.example/v1" },
      "/workspace",
    );
    const controller = new AbortController();
    const request = harness.client.request(
      "turn/start",
      { threadId: "thread", input: [] },
      { signal: controller.signal },
    );
    const outcome = request.catch((error: unknown) => error);
    const readThread = JSON.parse(await harness.waitForWrite(0));
    harness.send({ id: readThread.id, result: { thread: { modelProvider: "proxy" } } });
    const readConfig = JSON.parse(await harness.waitForWrite(1));
    harness.send({
      id: readConfig.id,
      result: {
        config: customProviderConfig(),
      },
    });
    const turn = JSON.parse(await harness.waitForWrite(2));
    expect(turn.method).toBe("turn/start");
    controller.abort();
    const error = await outcome;
    expect(error).toMatchObject({ message: "turn/start aborted", mayHaveWritten: true });
    expect(isCodexAppServerIndeterminateRequestCancellationError(error)).toBe(true);
  });

  it("preserves no-write rejection identity for a mismatched custom provider", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    harness.client.bindCustomProvider(
      { provider: "proxy", baseUrl: "https://proxy.example/v1" },
      "/workspace",
    );
    const outcome = harness.client
      .request("thread/resume", { threadId: "thread" })
      .catch((error: unknown) => error);
    const readThread = JSON.parse(await harness.waitForWrite(0));
    harness.send({ id: readThread.id, result: { thread: { modelProvider: "proxy" } } });
    const readConfig = JSON.parse(await harness.waitForWrite(1));
    harness.send({ id: readConfig.id, result: { config: { model_providers: {} } } });
    const error = await outcome;
    expect(error).toBeInstanceOf(CodexAppServerScopedRequestRejectedError);
    expect(error).toMatchObject({ cause: { message: expect.stringContaining("missing") } });
    expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual([
      "thread/read",
      "config/read",
    ]);
  });

  it.each<{
    name: string;
    method?: "thread/start" | "thread/resume" | "thread/fork";
    returnedId?: string;
    provider?: string;
    ephemeral?: boolean;
    cleanup: string[];
    close?: boolean;
    deleteFails?: boolean;
    abortAfterResponse?: boolean;
  }>([
    { name: "persistent start", cleanup: ["thread/delete"] },
    { name: "missing provider", provider: undefined, cleanup: ["thread/delete"] },
    { name: "ephemeral start", ephemeral: true, cleanup: ["thread/unsubscribe"] },
    { name: "fork", method: "thread/fork", cleanup: ["thread/delete"] },
    {
      name: "resume",
      method: "thread/resume",
      returnedId: "source",
      cleanup: ["thread/unsubscribe"],
    },
    {
      name: "resume returns another thread",
      method: "thread/resume",
      returnedId: "other",
      cleanup: [],
      close: true,
    },
    {
      name: "fork returns its source",
      method: "thread/fork",
      returnedId: "source",
      cleanup: [],
      close: true,
    },
    { name: "missing thread identity", returnedId: undefined, cleanup: [], close: true },
    {
      name: "delete fails",
      deleteFails: true,
      cleanup: ["thread/delete", "thread/unsubscribe"],
      close: true,
    },
    { name: "caller aborts after response", abortAfterResponse: true, cleanup: ["thread/delete"] },
  ])("cleans a rejected session: $name", async (overrides) => {
    const scenario = {
      method: "thread/start",
      returnedId: "created",
      provider: "openai",
      ephemeral: false,
      close: false,
      ...overrides,
    };
    const controller = new AbortController();
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line);
        let result: unknown = {};
        if (request.method === "config/read") {
          result = {
            config: customProviderConfig(),
          };
        } else if (request.method === "thread/read") {
          result = { thread: { id: "source", modelProvider: "proxy" } };
        } else if (request.method === scenario.method) {
          result = { thread: { id: scenario.returnedId }, modelProvider: scenario.provider };
        }
        queueMicrotask(() => {
          if (request.method === "thread/delete" && scenario.deleteFails) {
            send({
              id: request.id,
              error: { code: -32600, message: "synthetic delete failure" },
            });
          } else {
            send({ id: request.id, result });
          }
          if (request.method === scenario.method && scenario.abortAfterResponse) {
            controller.abort();
          }
        });
      },
    });
    clients.push(harness.client);
    harness.client.bindCustomProvider(
      { provider: "proxy", baseUrl: "https://proxy.example/v1" },
      "/workspace",
    );
    const error = await harness.client
      .request(
        scenario.method,
        {
          ...(scenario.method === "thread/start" ? {} : { threadId: "source" }),
          ephemeral: scenario.ephemeral,
        },
        { signal: controller.signal },
      )
      .catch((cause: unknown) => cause);
    if (scenario.close) {
      expect(error).toMatchObject({
        name: "CodexAppServerUnsafeSubscriptionError",
        cause: { message: expect.stringContaining("different provider") },
      });
    } else {
      expect(error).toMatchObject({ message: expect.stringContaining("different provider") });
    }
    const requests = harness.writes.map((line) => JSON.parse(line));
    const cleanup = requests.filter((request) =>
      ["thread/delete", "thread/unsubscribe"].includes(request.method),
    );
    expect(cleanup.map((request) => request.method)).toEqual(scenario.cleanup);
    for (const request of cleanup) {
      expect(request.params.threadId).toBe(scenario.returnedId);
    }
    expect(requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(harness.stdinDestroyed).toBe(scenario.close);
  });
});
