import { vi } from "vitest";

export const LINE_QUOTA_ACCOUNT = {
  cfg: {
    channels: { line: { accounts: { quota: { channelAccessToken: "quota-test-token" } } } },
  },
  accountId: "quota",
};

export function stubLineApiFetch(...responses: Array<Response | (() => Response)>) {
  const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected LINE request"));
  for (const response of responses) {
    fetchMock.mockImplementationOnce(async () =>
      typeof response === "function" ? response() : response,
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function createPendingLineResponse(value: unknown = {}) {
  const cancel = vi.fn();
  let finish = () => {};
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
          controller.close();
          finish = () => {};
        };
      },
      cancel() {
        cancel();
        finish = () => {};
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
  return { response, cancel, finish: () => finish() };
}
