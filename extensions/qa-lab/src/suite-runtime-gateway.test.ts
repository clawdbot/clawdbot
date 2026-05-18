import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGatewayRetryAfterMs,
  isConfigApplyNoopForSnapshot,
  isConfigHashConflict,
  isConfigPatchNoopForSnapshot,
  waitForConfigRestartSettle,
} from "./suite-runtime-gateway.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
});

function createRestartSettleEnv(waitReady: (params: unknown) => Promise<void>) {
  return {
    gateway: { baseUrl: "http://127.0.0.1:43123" },
    transport: { waitReady },
  } as unknown as Pick<QaSuiteRuntimeEnv, "gateway" | "transport">;
}

describe("qa suite gateway helpers", () => {
  it("reads retry-after from the primary gateway error before appended logs", () => {
    const error = new Error(
      "rate limit exceeded for config.patch; retry after 38s\nGateway logs:\nprevious config changed since last load",
    );

    expect(getGatewayRetryAfterMs(error)).toBe(38_000);
    expect(isConfigHashConflict(error)).toBe(false);
  });

  it("ignores stale retry-after text that only appears in appended gateway logs", () => {
    const error = new Error(
      "config changed since last load; re-run config.get and retry\nGateway logs:\nold rate limit exceeded for config.patch; retry after 38s",
    );

    expect(getGatewayRetryAfterMs(error)).toBe(null);
    expect(isConfigHashConflict(error)).toBe(true);
  });

  it("detects cleanup config patches that would not change the snapshot", () => {
    const config = {
      tools: {
        profile: "coding",
      },
      agents: {
        list: [{ id: "qa", model: { primary: "openai/gpt-5.5" } }],
      },
    };

    expect(
      isConfigPatchNoopForSnapshot(
        config,
        JSON.stringify({
          tools: {
            deny: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps changed merge patches eligible for the gateway", () => {
    expect(
      isConfigPatchNoopForSnapshot(
        {
          tools: {
            deny: ["image_generate"],
          },
        },
        JSON.stringify({
          tools: {
            deny: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("detects full config applies that only differ by gateway-written metadata", () => {
    const config = {
      gateway: {
        controlUi: {
          allowedOrigins: ["http://127.0.0.1:5173"],
        },
      },
      meta: {
        updatedAt: "2026-04-25T10:00:00.000Z",
      },
    };

    expect(
      isConfigApplyNoopForSnapshot(
        config,
        JSON.stringify({
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5173"],
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps changed full config applies eligible for the gateway", () => {
    expect(
      isConfigApplyNoopForSnapshot(
        {
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5173"],
            },
          },
          meta: {
            updatedAt: "2026-04-25T10:00:00.000Z",
          },
        },
        JSON.stringify({
          gateway: {
            controlUi: {
              allowedOrigins: ["http://127.0.0.1:5174"],
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("waits for transport readiness after gateway restart health", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });
    const waitReady = vi.fn(async () => {});

    await waitForConfigRestartSettle(createRestartSettleEnv(waitReady), 0, 1_000);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:43123/readyz",
        auditContext: "qa-lab-suite-wait-for-gateway-healthy",
      }),
    );
    expect(waitReady).toHaveBeenCalledWith({
      gateway: { baseUrl: "http://127.0.0.1:43123" },
      timeoutMs: expect.any(Number),
    });
    expect(release).toHaveBeenCalled();
  });

  it("keeps polling gateway health instead of sleeping blindly through restart settle", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("restart boundary")).mockResolvedValue({
      response: { ok: true },
      release,
    });
    const waitReady = vi.fn(async () => {});

    const settling = waitForConfigRestartSettle(createRestartSettleEnv(waitReady), 500, 5_000);

    await vi.advanceTimersByTimeAsync(1_250);
    await settling;

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(waitReady).toHaveBeenCalledTimes(1);
  });
});
