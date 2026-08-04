import type { WebClient } from "@slack/web-api";
import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./blocks.test-helpers.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";

// --- Module mocks (must precede dynamic import) ---
const loadOutboundMediaFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_mediaUrl: string, _options?: unknown) => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    kind: "image",
    fileName: "screenshot.png",
  })),
);
const cleanupUploadTimeout = vi.hoisted(() => vi.fn());
const uploadTimeoutControllers = vi.hoisted(() => [] as AbortController[]);
const buildTimeoutAbortSignal = vi.hoisted(() =>
  vi.fn((params: { timeoutMs?: number }) => {
    if (!Number.isFinite(params.timeoutMs) || (params.timeoutMs ?? 0) <= 0) {
      throw new Error("Slack upload timeout requires a finite budget");
    }
    const controller = new AbortController();
    uploadTimeoutControllers.push(controller);
    return {
      signal: controller.signal,
      cleanup: () => {
        const index = uploadTimeoutControllers.indexOf(controller);
        if (index >= 0) {
          uploadTimeoutControllers.splice(index, 1);
        }
        cleanupUploadTimeout();
      },
      refresh: () => {},
    };
  }),
);
const fetchWithSsrFGuard = vi.fn(
  async (
    params: Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0],
  ) => {
    const signal = params.signal;
    if (!signal) {
      throw new Error("guarded Slack upload fetch requires a finite timeout signal");
    }
    return {
      response: await fetch(params.url, {
        ...params.init,
        signal,
      }),
      finalUrl: params.url,
      release: async () => {},
    } as const;
  },
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) =>
      fetchWithSsrFGuard(...(args as [params: Parameters<typeof actual.fetchWithSsrFGuard>[0]])),
  };
});

vi.mock("openclaw/plugin-sdk/extension-shared", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/extension-shared")>(
    "openclaw/plugin-sdk/extension-shared",
  );
  return {
    ...actual,
    buildTimeoutAbortSignal: (...args: unknown[]) =>
      buildTimeoutAbortSignal(...(args as [params: { timeoutMs?: number }])),
  };
});

vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  return {
    ...actual,
    withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: "trusted_env_proxy",
    }),
  };
});

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  const mockedLoadOutboundMediaFromUrl =
    loadOutboundMediaFromUrlMock as unknown as typeof actual.loadOutboundMediaFromUrl;
  return {
    ...actual,
    loadOutboundMediaFromUrl: (...args: Parameters<typeof actual.loadOutboundMediaFromUrl>) =>
      mockedLoadOutboundMediaFromUrl(...args),
  };
});

const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

type UploadTestClient = WebClient & {
  conversations: { open: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>> };
  chat: { postMessage: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
    completeUploadExternal: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  };
};

type MockCalls = { mock: { calls: unknown[][] } };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const isObjectRecord = typeof value === "object" && value !== null && !Array.isArray(value);
  expect(isObjectRecord, `${label} should be an object`).toBe(true);
  if (!isObjectRecord) {
    throw new Error(`${label} should be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  const values = Array.isArray(value) ? value : null;
  expect(values, `${label} should be an array`).not.toBeNull();
  if (!values) {
    throw new Error(`${label} should be an array`);
  }
  return values;
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  expect(record).toMatchObject(expected);
}

function expectCallFirstArg(
  mock: MockCalls,
  callNumber: number,
  expected: Record<string, unknown>,
  label = "mock first argument",
): Record<string, unknown> {
  expect(mock.mock.calls.length).toBeGreaterThanOrEqual(callNumber);
  const [firstArg] = mock.mock.calls[callNumber - 1] ?? [];
  const record = requireRecord(firstArg, label);
  expectFields(record, expected);
  return record;
}

function expectOnlyCallFirstArg(
  mock: MockCalls,
  expected: Record<string, unknown>,
  label?: string,
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  return expectCallFirstArg(mock, 1, expected, label);
}

function expectCompletedUpload(params: {
  client: UploadTestClient;
  expected: Record<string, unknown>;
  file?: Record<string, unknown>;
}) {
  const payload = expectOnlyCallFirstArg(
    params.client.files.completeUploadExternal,
    params.expected,
    "complete upload payload",
  );
  if (params.file) {
    const [file] = requireArray(payload.files, "complete upload files");
    expectFields(requireRecord(file, "complete upload file"), params.file);
  }
  return payload;
}

function createUploadTestClient(slackApiUrl = "https://slack.com/api/"): UploadTestClient {
  return {
    slackApiUrl,
    conversations: {
      open: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
        channel: { id: "D99RESOLVED" },
      })),
    },
    chat: {
      postMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
        ts: "171234.567",
      })),
    },
    files: {
      getUploadURLExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
        ok: true,
        upload_url: "https://files.slack.com/upload",
        file_id: "F001",
      })),
      completeUploadExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
        ok: true,
      })),
    },
  } as unknown as UploadTestClient;
}

type UploadOverrides = Omit<Partial<Parameters<typeof sendMessageSlack>[2]>, "cfg" | "client">;
type UploadParams = UploadOverrides & { mediaUrl: string; target?: string; message?: string };

function sendUpload(client: UploadTestClient, params: UploadParams) {
  const { target = "channel:C123CHAN", message = "caption", ...options } = params;
  return sendMessageSlack(target, message, {
    token: "xoxb-test",
    cfg: SLACK_TEST_CFG,
    client,
    ...options,
  });
}

function sendText(client: UploadTestClient, target: string, message: string) {
  return sendMessageSlack(target, message, { token: "xoxb-test", cfg: SLACK_TEST_CFG, client });
}

function mockUploadDestination(client: UploadTestClient, uploadUrl: string) {
  client.files.getUploadURLExternal.mockResolvedValueOnce({
    ok: true,
    upload_url: uploadUrl,
    file_id: "F001",
  });
}

async function useRealUploadGuard(networkFetch: typeof fetch, lookupAddress?: string) {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  const lookupFn = lookupAddress
    ? ((async () => [{ address: lookupAddress, family: 4 }]) as unknown as LookupFn)
    : undefined;
  fetchWithSsrFGuard.mockImplementationOnce(async (params) =>
    actual.fetchWithSsrFGuard({
      ...params,
      fetchImpl: networkFetch,
      ...(lookupFn ? { lookupFn } : {}),
    }),
  );
}

describe("sendMessageSlack file upload with user IDs", () => {
  const originalFetch = globalThis.fetch;
  let client: UploadTestClient;

  beforeEach(() => {
    client = createUploadTestClient();
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    fetchWithSsrFGuard.mockClear();
    buildTimeoutAbortSignal.mockClear();
    cleanupUploadTimeout.mockClear();
    uploadTimeoutControllers.length = 0;
    loadOutboundMediaFromUrlMock.mockClear();
    clearSlackThreadParticipationCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "resolves bare user ID to DM channel before completing upload",
      target: "U2ZH3MFSR",
      message: "screenshot",
      mediaUrl: "/tmp/screenshot.png",
      userId: "U2ZH3MFSR",
      file: { id: "F001", title: "screenshot.png" },
    },
    {
      name: "resolves prefixed user ID to DM channel before completing upload",
      target: "user:UABC123",
      message: "image",
      mediaUrl: "/tmp/photo.png",
      userId: "UABC123",
    },
    {
      name: "resolves mention-style user ID before file upload",
      target: "<@U777TEST>",
      message: "report",
      mediaUrl: "/tmp/report.png",
      userId: "U777TEST",
    },
  ])("$name", async ({ target, message, mediaUrl, userId, file }) => {
    await sendUpload(client, { target, message, mediaUrl });

    expect(client.conversations.open).toHaveBeenCalledWith({ users: userId });
    expectCompletedUpload({ client, expected: { channel_id: "D99RESOLVED" }, file });
  });

  it("posts text-only user-target DMs directly without conversations.open", async () => {
    client.conversations.open.mockRejectedValueOnce(new Error("missing_scope"));

    await sendText(client, "user:UABC123", "first");
    await sendText(client, "user:UABC123", "second");

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expectCallFirstArg(client.chat.postMessage, 2, {
      channel: "UABC123",
      text: "second",
    });
  });

  it("serializes concurrent sends to the same Slack target", async () => {
    let resolveFirst: (() => void) | undefined;
    client.chat.postMessage.mockImplementation(async (payload: unknown) => {
      const text =
        typeof payload === "object" && payload !== null && "text" in payload
          ? payload.text
          : undefined;
      if (text === "first") {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return { ts: "1.000" };
      }
      return { ts: "2.000" };
    });

    const first = sendText(client, "channel:C123CHAN", "first");
    await vi.waitFor(() => expect(client.chat.postMessage).toHaveBeenCalledTimes(1));

    const second = sendText(client, "channel:C123CHAN", "second");
    await Promise.resolve();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    if (!resolveFirst) {
      throw new Error("Expected first Slack send release callback to be initialized");
    }
    resolveFirst();

    const firstResult = await first;
    expectFields(requireRecord(firstResult, "first send result"), {
      channelId: "C123CHAN",
      messageId: "1.000",
    });
    expectFields(requireRecord(firstResult.receipt, "first receipt"), {
      primaryPlatformMessageId: "1.000",
      platformMessageIds: ["1.000"],
    });
    const secondResult = await second;
    expectFields(requireRecord(secondResult, "second send result"), {
      channelId: "C123CHAN",
      messageId: "2.000",
    });
    expectFields(requireRecord(secondResult.receipt, "second receipt"), {
      primaryPlatformMessageId: "2.000",
      platformMessageIds: ["2.000"],
    });
    expectCallFirstArg(client.chat.postMessage, 2, { text: "second" });
  });

  it("scopes DM channel resolution cache by token identity", async () => {
    await sendUpload(client, {
      target: "user:UABC123",
      message: "first",
      token: "xoxb-test-a",
      mediaUrl: "/tmp/first.png",
    });
    await sendUpload(client, {
      target: "user:UABC123",
      message: "second",
      token: "xoxb-test-b",
      mediaUrl: "/tmp/second.png",
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(2);
  });

  it("sends file directly to channel without conversations.open", async () => {
    const result = await sendUpload(client, { message: "chart", mediaUrl: "/tmp/chart.png" });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expectCompletedUpload({ client, expected: { channel_id: "C123CHAN" } });
    expectFields(requireRecord(result.receipt, "receipt"), {
      primaryPlatformMessageId: "F001",
      platformMessageIds: ["F001"],
    });
    const [part] = requireArray(result.receipt.parts, "receipt parts");
    const partRecord = requireRecord(part, "receipt part");
    expectFields(partRecord, {
      platformMessageId: "F001",
      kind: "media",
    });
    expectFields(requireRecord(partRecord.raw, "receipt raw"), {
      channel: "slack",
      channelId: "C123CHAN",
    });
  });

  it("uploads bytes to the presigned URL and completes with thread+caption", async () => {
    const events: string[] = [];
    globalThis.fetch = vi.fn(async () => {
      events.push("byte-upload");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    client.files.completeUploadExternal.mockImplementationOnce(async () => {
      events.push("completion");
      return { ok: true };
    });
    let finishDispatch: () => void = () => {};
    const dispatchFinished = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch-start");
      await dispatchFinished;
      events.push("dispatch-end");
    });

    const sendPromise = sendUpload(client, {
      mediaUrl: "/tmp/threaded.png",
      threadTs: "171.222",
      onPlatformSendDispatch,
    });
    await vi.waitFor(() => expect(onPlatformSendDispatch).toHaveBeenCalledOnce());
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
    finishDispatch();
    const result = await sendPromise;

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "screenshot.png",
      length: Buffer.from("fake-image").length,
    });
    const fetchCalls = (globalThis.fetch as unknown as MockCalls).mock.calls;
    expect(fetchCalls).toHaveLength(1);
    const [fetchUrl, fetchInit] = fetchCalls[0] ?? [];
    expect(fetchUrl).toBe("https://files.slack.com/upload");
    expectFields(requireRecord(fetchInit, "fetch init"), { method: "POST" });
    expectOnlyCallFirstArg(buildTimeoutAbortSignal, {
      timeoutMs: 120_000,
      operation: "slack-upload-file",
      url: "https://files.slack.com",
    });
    expectOnlyCallFirstArg(fetchWithSsrFGuard, {
      url: "https://files.slack.com/upload",
      mode: "trusted_env_proxy",
      timeoutMs: 120_000,
      signal: expect.any(AbortSignal),
      requireHttps: true,
      policy: {
        hostnameAllowlist: ["files.slack.com"],
        allowRfc2544BenchmarkRange: true,
      },
      capture: false,
      auditContext: "slack-upload-file",
    });
    expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
    expect(uploadTimeoutControllers).toHaveLength(0);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(events).toEqual(["byte-upload", "dispatch-start", "dispatch-end", "completion"]);
    expectCompletedUpload({
      client,
      expected: {
        channel_id: "C123CHAN",
        initial_comment: "caption",
        thread_ts: "171.222",
      },
    });
    expect(hasSlackThreadParticipation("default", "C123CHAN", "171.222")).toBe(true);
    expect(result.receipt.threadId).toBe("171.222");
  });

  it("keeps the presigned upload capability out of timeout logging", async () => {
    mockUploadDestination(client, "https://files.slack.com/upload/v1/secret-capability");

    await sendUpload(client, { mediaUrl: "/tmp/secret.png" });

    expectOnlyCallFirstArg(buildTimeoutAbortSignal, {
      timeoutMs: 120_000,
      operation: "slack-upload-file",
      url: "https://files.slack.com",
    });
    expectOnlyCallFirstArg(fetchWithSsrFGuard, {
      url: "https://files.slack.com/upload/v1/secret-capability",
    });
  });

  it("preserves HTTP upload URLs on an alternate Slack API origin", async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
      "openclaw/plugin-sdk/ssrf-runtime",
    );
    await withServer(
      (req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/upload/v1/capability");
        req.resume();
        res.end("ok");
      },
      async (baseUrl) => {
        vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
        vi.stubEnv("no_proxy", "127.0.0.1,localhost");
        const alternateClient = createUploadTestClient(`${baseUrl}/api/`);
        mockUploadDestination(alternateClient, `${baseUrl}/upload/v1/capability`);
        fetchWithSsrFGuard.mockImplementationOnce(async (params) => {
          const mockedFetch = globalThis.fetch;
          globalThis.fetch = originalFetch;
          try {
            return await actual.fetchWithSsrFGuard(params);
          } finally {
            globalThis.fetch = mockedFetch;
          }
        });

        await sendUpload(alternateClient, { mediaUrl: "/tmp/alternate-root.png" });

        expectCompletedUpload({ client: alternateClient, expected: { channel_id: "C123CHAN" } });
        expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
        expect(uploadTimeoutControllers).toHaveLength(0);
      },
    );
  });

  it.each([
    {
      name: "allows an exact Slack upload host returned by a custom API root",
      apiUrl: "https://slack-relay.example/api/",
      uploadUrl: "https://files.slack.com/upload/v1/relayed-capability",
      lookupAddress: "93.184.216.34",
      mediaUrl: "/tmp/relayed-upload.png",
    },
    {
      name: "allows GovSlack upload destinations through the real hostname guard",
      apiUrl: "https://slack-gov.com/api/",
      uploadUrl: "https://files.slack-gov.com/upload/v1/gov-capability",
      lookupAddress: undefined,
      mediaUrl: "/tmp/gov-slack.png",
    },
    {
      name: "retains the shipped RFC2544 fake-IP path for an exact Slack upload host",
      apiUrl: undefined,
      uploadUrl: undefined,
      lookupAddress: "198.18.0.10",
      mediaUrl: "/tmp/fake-ip.png",
    },
  ])("$name", async ({ apiUrl, uploadUrl, lookupAddress, mediaUrl }) => {
    const caseClient = createUploadTestClient(apiUrl);
    if (uploadUrl) {
      mockUploadDestination(caseClient, uploadUrl);
    }
    const networkFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    await useRealUploadGuard(networkFetch, lookupAddress);

    await sendUpload(caseClient, { mediaUrl });

    expect(networkFetch).toHaveBeenCalledOnce();
    expectCompletedUpload({ client: caseClient, expected: { channel_id: "C123CHAN" } });
  });

  it.each(["10.0.0.1", "169.254.1.1"])(
    "rejects exact Slack upload hosts resolving to blocked address %s",
    async (address) => {
      const networkFetch = vi.fn(async () => new Response("unexpected"));
      await useRealUploadGuard(networkFetch, address);

      await expect(sendUpload(client, { mediaUrl: "/tmp/private-address.png" })).rejects.toThrow();

      expect(networkFetch).not.toHaveBeenCalled();
      expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["public non-Slack", "https://slack.com/api/", "https://example.com/upload/v1/not-slack"],
    ["plaintext Slack", "https://slack.com/api/", "http://files.slack.com/upload/v1/plaintext"],
    [
      "commercial Slack to GovSlack",
      "https://slack.com/api/",
      "https://files.slack-gov.com/upload/v1/cross-plane",
    ],
    [
      "GovSlack to commercial Slack",
      "https://slack-gov.com/api/",
      "https://files.slack.com/upload/v1/cross-plane",
    ],
    [
      "trailing-dot commercial Slack to GovSlack",
      "https://slack.com./api/",
      "https://files.slack-gov.com/upload/v1/cross-plane",
    ],
    [
      "trailing-dot GovSlack to commercial Slack",
      "https://slack-gov.com./api/",
      "https://files.slack.com/upload/v1/cross-plane",
    ],
    [
      "undocumented commercial subdomain",
      "https://slack.com/api/",
      "https://future-upload.slack.com/upload/v1/capability",
    ],
    [
      "undocumented GovSlack subdomain",
      "https://slack-gov.com/api/",
      "https://future-upload.slack-gov.com/upload/v1/capability",
    ],
  ])("rejects %s upload destinations before network access", async (label, apiUrl, uploadUrl) => {
    const rejectedClient = createUploadTestClient(apiUrl);
    mockUploadDestination(rejectedClient, uploadUrl);
    const networkFetch = vi.fn(async () => new Response("unexpected"));
    const errorName = uploadUrl.startsWith("http:") ? "Error" : "SsrFBlockedError";
    await useRealUploadGuard(networkFetch);

    const rejection = await sendUpload(rejectedClient, {
      mediaUrl: "/tmp/rejected-upload.png",
    }).catch((cause: unknown) => cause);

    expect(rejection).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(rejection).toMatchObject({ cause: expect.objectContaining({ name: errorName }) });

    expect(networkFetch).not.toHaveBeenCalled();
    expect(rejectedClient.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("rejects upload destinations outside an explicitly configured API origin", async () => {
    const originClient = createUploadTestClient("http://slack-compatible.example/api/");
    mockUploadDestination(originClient, "http://other-compatible.example/upload/v1/capability");

    await expect(sendUpload(originClient, { mediaUrl: "/tmp/wrong-origin.png" })).rejects.toThrow(
      "must match the configured Slack API origin",
    );

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(originClient.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("times out a hanging presigned URL upload", async () => {
    const closedResponses = vi.fn();

    await withServer(
      (req, res) => {
        req.resume();
        const route = `${req.method ?? "GET"} ${req.url ?? "/"}`;
        res.on("close", () => closedResponses(route));
        if (route === "POST /upload") {
          // Fire the mocked deadline only after the request reaches the server,
          // keeping the cancellation regression deterministic under CI load.
          const controller = uploadTimeoutControllers.at(-1);
          if (!controller) {
            throw new Error("missing Slack upload timeout controller");
          }
          const error = new Error("request timed out");
          error.name = "TimeoutError";
          controller.abort(error);
          return;
        }
        res.statusCode = 500;
        res.end(`unexpected ${route}`);
      },
      async (baseUrl) => {
        globalThis.fetch = originalFetch;
        mockUploadDestination(client, `${baseUrl}/upload`);

        const onPlatformSendDispatch = vi.fn();
        const error = await sendUpload(client, {
          mediaUrl: "/tmp/hanging.png",
          onPlatformSendDispatch,
        }).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
        expect(error).toMatchObject({
          name: "PlatformMessageNotDispatchedError",
          code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
          cause: expect.objectContaining({ name: "TimeoutError" }),
        });

        await vi.waitFor(() => expect(closedResponses).toHaveBeenCalledWith("POST /upload"));
        expectOnlyCallFirstArg(buildTimeoutAbortSignal, {
          timeoutMs: 120_000,
          operation: "slack-upload-file",
          url: baseUrl,
        });
        expectOnlyCallFirstArg(fetchWithSsrFGuard, {
          timeoutMs: 120_000,
          signal: expect.any(AbortSignal),
        });
        expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
        expect(uploadTimeoutControllers).toHaveLength(0);
        expect(onPlatformSendDispatch).not.toHaveBeenCalled();
        expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
      },
    );
  });

  it.each([201, 204, 500])("rejects a non-200 byte-upload response (%s)", async (status) => {
    const onPlatformSendDispatch = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

    const error = await sendUpload(client, {
      mediaUrl: "/tmp/non-200.png",
      onPlatformSendDispatch,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      message: "Slack external upload failed before completion dispatch",
      cause: expect.objectContaining({
        code: `HTTP_${status}`,
        message: `Slack external upload returned HTTP ${status}`,
      }),
    });
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("marks a non-timeout byte-upload transport failure as not dispatched", async () => {
    const onPlatformSendDispatch = vi.fn();
    const transportError = Object.assign(
      new Error(
        "socket closed at https://files.slack.com/upload/v1/CAPABILITY_SENTINEL?token=QUERY_SENTINEL",
      ),
      { code: "ECONNRESET" },
    );
    globalThis.fetch = vi.fn(async () => {
      throw transportError;
    }) as unknown as typeof fetch;

    const error = await sendUpload(client, {
      mediaUrl: "/tmp/transport-failure.png",
      onPlatformSendDispatch,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      message: "Slack external upload failed before completion dispatch",
      cause: expect.objectContaining({
        code: "ECONNRESET",
        message: "Slack external upload transfer failed",
      }),
    });
    expect(formatErrorMessage(error)).not.toContain("CAPABILITY_SENTINEL");
    expect(formatErrorMessage(error)).not.toContain("QUERY_SENTINEL");
    expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).not.toHaveBeenCalled();
  });

  it("disposes the byte-upload response and timeout before waiting for completion", async () => {
    const uploadResponse = new Response("ok", { status: 200 });
    const cancelUploadBody = vi.spyOn(uploadResponse.body!, "cancel");
    cancelUploadBody.mockRejectedValueOnce(new Error("response body cleanup failed"));
    globalThis.fetch = vi.fn(async () => uploadResponse) as unknown as typeof fetch;
    let markCompletionStarted: () => void = () => {};
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    let finishCompletion: (value: { ok: true }) => void = () => {};
    const completionResult = new Promise<{ ok: true }>((resolve) => {
      finishCompletion = resolve;
    });
    client.files.completeUploadExternal.mockImplementationOnce(() => {
      markCompletionStarted();
      return completionResult;
    });

    const sendPromise = sendUpload(client, { mediaUrl: "/tmp/completion-pending.png" });

    await completionStarted;
    expect(cancelUploadBody).toHaveBeenCalledOnce();
    expect(cleanupUploadTimeout).toHaveBeenCalledOnce();
    expect(uploadTimeoutControllers).toHaveLength(0);
    await expect(
      Promise.race([
        sendPromise.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");

    finishCompletion({ ok: true });
    await expect(sendPromise).resolves.toMatchObject({ messageId: "F001" });
  });

  it.each([
    {
      name: "keeps completion failures unmarked because Slack may have finalized the upload",
      completion: new Error("completion unavailable"),
      mediaUrl: "/tmp/completion-failure.png",
      message: "completion unavailable",
    },
    {
      name: "keeps completion error responses unmarked because Slack may have finalized the upload",
      completion: { ok: false, error: "completion_failed" },
      mediaUrl: "/tmp/completion-error-response.png",
      message: "Failed to complete upload: completion_failed",
    },
  ])("$name", async ({ completion, mediaUrl, message }) => {
    const onPlatformSendDispatch = vi.fn();
    if (completion instanceof Error) {
      client.files.completeUploadExternal.mockRejectedValueOnce(completion);
    } else {
      client.files.completeUploadExternal.mockResolvedValueOnce(completion);
    }

    const error = await sendUpload(client, { mediaUrl, onPlatformSendDispatch }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({ message });
    expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it.each([
    ["uses explicit upload filename and title overrides when provided", "Custom Title"],
    ["uses uploadFileName as the title fallback when uploadTitle is omitted", undefined],
  ] as const)("%s", async (_name, uploadTitle) => {
    const uploadFileName = "custom-name.bin";

    await sendUpload(client, {
      mediaUrl: "/tmp/threaded.png",
      uploadFileName,
      ...(uploadTitle ? { uploadTitle } : {}),
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: uploadFileName,
      length: Buffer.from("fake-image").length,
    });
    expectCompletedUpload({
      client,
      expected: {},
      file: { id: "F001", title: uploadTitle ?? uploadFileName },
    });
  });
});
