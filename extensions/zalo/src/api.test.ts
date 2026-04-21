import { beforeEach, describe, expect, it, vi } from "vitest";

const resolvePinnedHostnameWithPolicyMock = vi.fn();

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: (...args: unknown[]) =>
    resolvePinnedHostnameWithPolicyMock(...args),
}));

import { deleteWebhook, getWebhookInfo, sendChatAction, sendPhoto, type ZaloFetch } from "./api.js";

function createOkFetcher() {
  return vi.fn<ZaloFetch>(async () => new Response(JSON.stringify({ ok: true, result: {} })));
}

async function expectPostJsonRequest(run: (token: string, fetcher: ZaloFetch) => Promise<unknown>) {
  const fetcher = createOkFetcher();
  await run("test-token", fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [, init] = fetcher.mock.calls[0] ?? [];
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ "Content-Type": "application/json" });
}

describe("Zalo API request methods", () => {
  beforeEach(() => {
    resolvePinnedHostnameWithPolicyMock.mockReset();
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    });
  });

  it("uses POST for getWebhookInfo", async () => {
    await expectPostJsonRequest(getWebhookInfo);
  });

  it("keeps POST for deleteWebhook", async () => {
    await expectPostJsonRequest(deleteWebhook);
  });

  it("aborts sendChatAction when the typing timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<ZaloFetch>(
        (_, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );

      const promise = sendChatAction(
        "test-token",
        {
          chat_id: "chat-123",
          action: "typing",
        },
        fetcher,
        25,
      );
      const rejected = expect(promise).rejects.toThrow("aborted");

      await vi.advanceTimersByTimeAsync(25);

      await rejected;
      const [, init] = fetcher.mock.calls[0] ?? [];
      expect(init?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates outbound photo URLs against the SSRF guard before posting", async () => {
    const fetcher = createOkFetcher();

    await sendPhoto(
      "test-token",
      {
        chat_id: "chat-123",
        photo: "https://example.com/image.png",
      },
      fetcher,
    );

    expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("example.com", {
      policy: {},
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("blocks private-network photo URLs before they reach the Zalo API", async () => {
    const fetcher = createOkFetcher();
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      sendPhoto(
        "test-token",
        {
          chat_id: "chat-123",
          photo: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        },
        fetcher,
      ),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-http photo URLs", async () => {
    const fetcher = createOkFetcher();

    await expect(
      sendPhoto(
        "test-token",
        {
          chat_id: "chat-123",
          photo: "file:///etc/passwd",
        },
        fetcher,
      ),
    ).rejects.toThrow("Zalo photo URL must use HTTP or HTTPS");

    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-URL strings", async () => {
    const fetcher = createOkFetcher();

    await expect(
      sendPhoto(
        "test-token",
        {
          chat_id: "chat-123",
          photo: "not a url",
        },
        fetcher,
      ),
    ).rejects.toThrow("Zalo photo URL must be an absolute HTTP or HTTPS URL");

    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
