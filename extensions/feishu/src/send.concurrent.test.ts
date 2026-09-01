import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const {
  mockClientCreate,
  mockCreateFeishuClient,
  mockResolveFeishuAccount,
  mockConvertMarkdownTables,
  mockResolveMarkdownTableMode,
} = vi.hoisted(() => ({
  mockClientCreate: vi.fn<
    (params: { data: { receive_id: string } }) => Promise<{
      code: number;
      data: { message_id: string };
    }>
  >(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuAccount: vi.fn(),
  mockConvertMarkdownTables: vi.fn((text: string) => text),
  mockResolveMarkdownTableMode: vi.fn(() => "preserve"),
}));

vi.mock("./client.js", () => ({ createFeishuClient: mockCreateFeishuClient }));
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
  resolveFeishuRuntimeAccount: mockResolveFeishuAccount,
}));
vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: mockResolveMarkdownTableMode,
}));
vi.mock("openclaw/plugin-sdk/text-chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-chunking")>();
  return { ...actual, convertMarkdownTables: mockConvertMarkdownTables };
});
vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: vi.fn(() => "preserve"),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
    },
  }),
}));

let sendMessageFeishu: typeof import("./send.js").sendMessageFeishu;

const cfg = {} as ClawdbotConfig;

function okResponse(messageId: string) {
  return { code: 0, data: { message_id: messageId } };
}

function expectedSendResult(messageId: string, chatId: string) {
  return expect.objectContaining({
    messageId,
    chatId,
    receipt: expect.objectContaining({
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
    }),
  });
}

function rateLimitError() {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { code: 230020, msg: "This operation triggers the frequency limit" },
    },
  });
}

beforeAll(async () => {
  ({ sendMessageFeishu } = await import("./send.js"));
});

afterAll(() => {
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockClientCreate.mockReset();
  mockResolveFeishuAccount.mockReturnValue({ accountId: "default", configured: true });
  mockResolveMarkdownTableMode.mockReturnValue("preserve");
  mockConvertMarkdownTables.mockImplementation((text: string) => text);
  mockCreateFeishuClient.mockReturnValue({
    im: { message: { create: mockClientCreate } },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("concurrent Feishu sends", () => {
  it.each([
    { scope: "one target", targets: ["oc_shared", "oc_shared", "oc_shared"] },
    { scope: "distinct targets", targets: ["oc_alpha", "oc_beta", "oc_gamma"] },
  ])(
    "keeps sends to $scope independent when responses arrive out of order",
    async ({ targets }) => {
      const requests = targets.map((to, index) => ({
        to,
        messageId: `om_concurrent_${index}`,
        response: createDeferred<ReturnType<typeof okResponse>>(),
        started: createDeferred<void>(),
      }));
      for (const request of requests) {
        mockClientCreate.mockImplementationOnce(() => {
          request.started.resolve();
          return request.response.promise;
        });
      }
      const completionOrder: string[] = [];
      const sends = requests.map((request, index) => ({
        ...request,
        sending: sendMessageFeishu({ cfg, to: request.to, text: `message ${index}` }).then(
          (result) => {
            completionOrder.push(result.messageId);
            return result;
          },
        ),
      }));
      const settled = Promise.allSettled(sends.map((send) => send.sending));

      try {
        await Promise.all(requests.map((request) => request.started.promise));
        expect(mockClientCreate.mock.calls.map(([params]) => params.data.receive_id)).toEqual(
          targets,
        );
        expect(completionOrder).toEqual([]);

        const expectedOrder: string[] = [];
        for (const send of sends.toReversed()) {
          send.response.resolve(okResponse(send.messageId));
          await expect(send.sending).resolves.toEqual(expectedSendResult(send.messageId, send.to));
          expectedOrder.push(send.messageId);
          expect(completionOrder).toEqual(expectedOrder);
        }
        expect(mockClientCreate).toHaveBeenCalledTimes(targets.length);
      } finally {
        for (const send of sends) {
          send.response.resolve(okResponse(send.messageId));
        }
        await settled;
      }
    },
  );

  it("keeps successful, recovering, and exhausted sends independent", async () => {
    vi.useFakeTimers();
    const attempts = new Map<string, number>();
    const started = createDeferred<void>();
    mockClientCreate.mockImplementation(async ({ data: { receive_id: to } }) => {
      const attempt = (attempts.get(to) ?? 0) + 1;
      attempts.set(to, attempt);
      if (attempts.size === 3) {
        started.resolve();
      }
      if (to === "oc_exhausted" || (to === "oc_recovering" && attempt === 1)) {
        throw rateLimitError();
      }
      return okResponse(`om_${to}`);
    });

    const exhausted = sendMessageFeishu({ cfg, to: "oc_exhausted", text: "exhausted" });
    const recovering = sendMessageFeishu({ cfg, to: "oc_recovering", text: "recovering" });
    const successful = sendMessageFeishu({ cfg, to: "oc_successful", text: "successful" });
    // Attach rejection handlers before advancing the retry clock.
    const settled = Promise.allSettled([exhausted, recovering, successful]);

    try {
      await started.promise;
      expect(attempts).toEqual(
        new Map([
          ["oc_exhausted", 1],
          ["oc_recovering", 1],
          ["oc_successful", 1],
        ]),
      );
      await expect(successful).resolves.toEqual(
        expectedSendResult("om_oc_successful", "oc_successful"),
      );

      await vi.runAllTimersAsync();
      await expect(exhausted).rejects.toThrow(/^Feishu send failed:.*"feishu_code":230020/u);
      expect(attempts).toEqual(
        new Map([
          ["oc_exhausted", 3],
          ["oc_recovering", 2],
          ["oc_successful", 1],
        ]),
      );
      expect(await settled).toEqual([
        { status: "rejected", reason: expect.any(Error) },
        { status: "fulfilled", value: expectedSendResult("om_oc_recovering", "oc_recovering") },
        { status: "fulfilled", value: expectedSendResult("om_oc_successful", "oc_successful") },
      ]);
    } finally {
      await vi.runAllTimersAsync();
      await settled;
    }
  });
});
