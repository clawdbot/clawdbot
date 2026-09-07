// Prove fetchChatCerts cancels an unread non-OK Response body before throwing.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  verifySignedJwtWithCertsAsync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("./google-auth.runtime.js", () => ({
  loadGoogleAuthRuntime: vi.fn().mockResolvedValue({
    OAuth2Client: class {
      verifySignedJwtWithCertsAsync = mocks.verifySignedJwtWithCertsAsync;
    },
  }),
  getGoogleAuthTransport: vi.fn().mockResolvedValue({}),
  resolveValidatedGoogleChatCredentials: vi.fn().mockResolvedValue(null),
}));

const { verifyGoogleChatRequest } = await import("./auth.js");

let googleChatCertFetchNowMs = Date.now();

function expireGoogleChatCertCache(): void {
  googleChatCertFetchNowMs += 11 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(googleChatCertFetchNowMs);
}

function createNonOkCertResponse(status: number) {
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Keep the body unread until cancel; enqueue once so the stream is live.
        controller.enqueue(new TextEncoder().encode("unavailable"));
      },
      cancel() {
        canceled = true;
      },
    }),
    {
      status,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
    },
  );
  return {
    response,
    get canceled() {
      return canceled;
    },
  };
}

afterEach(() => {
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.verifySignedJwtWithCertsAsync.mockReset();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("./google-auth.runtime.js");
  vi.resetModules();
});

describe("Google Chat cert fetch non-OK body cancel", () => {
  it("cancels the unread cert Response body when status is non-OK", async () => {
    expireGoogleChatCertCache();
    const streamed = createNonOkCertResponse(503);
    const release = vi.fn(async () => {});
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: streamed.response,
      release,
    });

    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "project-number",
      audience: "123456789",
    });

    // Allow fire-and-forget cancel() to settle on the real ReadableStream.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(result).toEqual({
      ok: false,
      reason: "Failed to fetch Chat certs (503)",
    });
    expect(streamed.canceled).toBe(true);
    expect(mocks.verifySignedJwtWithCertsAsync).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com",
        auditContext: "googlechat.auth.certs",
      }),
    );
    console.log(
      `[googlechat certs non-ok cancel proof] canceled=${streamed.canceled} status=503 reason=${result.reason}`,
    );
  });
});
