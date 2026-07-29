// Azure Speech voice list default timeout unit tests.
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

import { listAzureSpeechVoices } from "./tts.js";

type GuardRequest = {
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
  policy?: unknown;
  auditContext?: string;
};

function queueGuardedResponse(response: Response): { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return { release };
}

function lastGuardRequest(): GuardRequest {
  const calls = fetchWithSsrFGuardMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("fetchWithSsrFGuard was not called");
  }
  return call[0] as GuardRequest;
}

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("listAzureSpeechVoices default timeout", () => {
  it("defaults to a bounded timeout for voice list requests", async () => {
    queueGuardedResponse(new Response(JSON.stringify([]), { status: 200 }));

    await listAzureSpeechVoices({ apiKey: "not-a-real", region: "eastus" });

    expect(lastGuardRequest().timeoutMs).toBe(30_000);
  });

  it("preserves an explicit timeout for voice list requests", async () => {
    queueGuardedResponse(new Response(JSON.stringify([]), { status: 200 }));

    await listAzureSpeechVoices({
      apiKey: "not-a-real",
      region: "eastus",
      timeoutMs: 5_000,
    });

    expect(lastGuardRequest().timeoutMs).toBe(5_000);
  });
});
