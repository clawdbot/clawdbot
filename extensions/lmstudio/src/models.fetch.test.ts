import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fetchLmstudioModels } from "./models.fetch.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

describe("LM Studio model response release", () => {
  const cancelTrackedResponse = (
    text: string,
    init: ResponseInit,
  ): {
    response: Response;
    wasCanceled: () => boolean;
  } => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
      },
      cancel() {
        canceled = true;
      },
    });
    return {
      response: new Response(stream, init),
      wasCanceled: () => canceled,
    };
  };

  it.each([false, true])(
    "releases guarded non-ok discovery without waiting for capture (retained clone: %s)",
    async (retainCaptureClone) => {
      const tracked = cancelTrackedResponse("unavailable", { status: 503 });
      const captureClone = retainCaptureClone ? tracked.response.clone() : undefined;
      const release = vi.fn(async () => undefined);
      fetchWithSsrFGuardMock.mockResolvedValue({ response: tracked.response, release });
      const request = fetchLmstudioModels({
        baseUrl: "http://localhost:1234/v1",
        ssrfPolicy: {},
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          request,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("LM Studio cleanup waited for the capture clone")),
              500,
            );
          }),
        ]);
        expect(result).toMatchObject({ reachable: true, status: 503, models: [] });
        expect(tracked.response.bodyUsed).toBe(true);
        expect(release).toHaveBeenCalledOnce();
      } finally {
        clearTimeout(timeout);
        await captureClone?.body?.cancel().catch(() => undefined);
        await request;
      }
      expect(tracked.wasCanceled()).toBe(true);
    },
  );
});
