// Google Meet tests cover chrome plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import { launchChromeMeet, recoverCurrentMeetTab } from "./chrome.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

type TestGatewayRequest = (
  method: string,
  params: Record<string, unknown>,
  options?: unknown,
) => Promise<unknown>;

function browserRuntime(request: TestGatewayRequest): PluginRuntime {
  const gateway: PluginRuntime["gateway"] = {
    isAvailable: async () => true,
    request: async <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: unknown,
    ) => (await request(method, params ?? {}, options)) as T,
  };
  return { gateway } as PluginRuntime;
}

describe("google meet chrome transport", () => {
  it("prefers a meeting tab over a login fallback during untargeted recovery", async () => {
    const statusScripts: string[] = [];
    const gatewayRequest = vi.fn(async (_method, params) => {
      if (params.path === "/tabs") {
        return {
          tabs: [
            {
              targetId: "google-login-tab",
              title: "Sign in - Google Accounts",
              url: "https://accounts.google.com/signin",
            },
            {
              targetId: "meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?hl=en",
            },
          ],
        };
      }
      if (params.path === "/tabs/focus") {
        return { ok: true };
      }
      if (params.path === "/act") {
        const fn = (params.body as { fn?: unknown } | undefined)?.fn;
        if (typeof fn === "string") {
          statusScripts.push(fn);
        }
        return {
          result: JSON.stringify({
            inCall: true,
            micMuted: true,
            url: "https://meet.google.com/abc-defg-hij?hl=en",
          }),
        };
      }
      throw new Error(`unexpected browser request path ${String(params.path)}`);
    });

    const recovered = await recoverCurrentMeetTab({
      runtime: browserRuntime(gatewayRequest),
      config: resolveGoogleMeetConfig({}),
      fullConfig: { transcripts: { enabled: false } },
      mode: "agent",
      readOnly: true,
    });

    expect(recovered).toMatchObject({ found: true, targetId: "meet-tab" });
    expect(statusScripts).toHaveLength(1);
    expect(statusScripts[0]).toContain("const captureCaptions = false");
  });

  it("prefers the tracked target for an unchanged Google Meet URL", async () => {
    const gatewayRequest = vi.fn(async (_method, params) => {
      if (params.path === "/tabs") {
        return {
          tabs: [
            {
              targetId: "other-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?hl=en",
            },
            {
              targetId: "tracked-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?hl=en",
            },
          ],
        };
      }
      if (params.path === "/tabs/focus") {
        return { ok: true };
      }
      if (params.path === "/act") {
        return {
          result: JSON.stringify({
            inCall: true,
            micMuted: true,
            url: "https://meet.google.com/abc-defg-hij?hl=en",
          }),
        };
      }
      throw new Error(`unexpected browser request path ${String(params.path)}`);
    });

    const recovered = await recoverCurrentMeetTab({
      runtime: browserRuntime(gatewayRequest),
      config: resolveGoogleMeetConfig({}),
      mode: "transcribe",
      readOnly: true,
      trackedMeetingUrl: "https://meet.google.com/abc-defg-hij?authuser=0",
      trackedTargetId: "tracked-meet-tab",
      url: "https://meet.google.com/abc-defg-hij?hl=en",
    });

    expect(recovered).toMatchObject({ found: true, targetId: "tracked-meet-tab" });
    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: "tracked-meet-tab" }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("falls back from a tracked target that identifies another meeting", async () => {
    const gatewayRequest = vi.fn(async (_method, params) => {
      if (params.path === "/tabs") {
        return {
          tabs: [
            {
              targetId: "matching-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?hl=en",
            },
            {
              targetId: "tracked-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/xyz-abcd-efg?hl=en",
            },
          ],
        };
      }
      if (params.path === "/tabs/focus") {
        return { ok: true };
      }
      if (params.path === "/act") {
        return {
          result: JSON.stringify({
            inCall: true,
            micMuted: true,
            url: "https://meet.google.com/abc-defg-hij?hl=en",
          }),
        };
      }
      throw new Error(`unexpected browser request path ${String(params.path)}`);
    });

    const recovered = await recoverCurrentMeetTab({
      runtime: browserRuntime(gatewayRequest),
      config: resolveGoogleMeetConfig({}),
      mode: "transcribe",
      readOnly: true,
      trackedMeetingUrl: "https://meet.google.com/abc-defg-hij?authuser=0",
      trackedTargetId: "tracked-meet-tab",
      url: "https://meet.google.com/abc-defg-hij?hl=en",
    });

    expect(recovered).toMatchObject({ found: true, targetId: "matching-meet-tab" });
  });

  it("wraps malformed browser status JSON through tab recovery", async () => {
    const runtime = browserRuntime(
      vi.fn(async (_method, params) => {
        if (params.path === "/tabs") {
          return {
            tabs: [
              {
                targetId: "meet-tab",
                title: "Meet",
                url: "https://meet.google.com/abc-defg-hij?hl=en",
              },
            ],
          };
        }
        if (params.path === "/tabs/focus") {
          return { ok: true };
        }
        if (params.path === "/act") {
          return { result: "{not json" };
        }
        throw new Error(`unexpected browser request path ${String(params.path)}`);
      }),
    );

    await expect(
      recoverCurrentMeetTab({
        runtime,
        config: resolveGoogleMeetConfig({}),
        mode: "transcribe",
        readOnly: true,
      }),
    ).rejects.toThrow("Google Meet browser status JSON is malformed.");
  });

  it.each([
    [10_000, 15_000],
    [Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
  ])("caps browser gateway timeout padding for %s ms", async (joinTimeoutMs, expectedTimeoutMs) => {
    const gatewayRequest = vi.fn(async (_method, params) => {
      if (params.path === "/tabs/open") {
        return {
          targetId: "meet-tab",
          title: "Meet",
          url: "https://meet.google.com/abc-defg-hij?hl=en",
        };
      }
      if (params.path === "/act") {
        return {
          result: JSON.stringify({
            manualActionRequired: true,
            manualActionReason: "meet-admission-required",
          }),
        };
      }
      throw new Error(`unexpected browser request path ${String(params.path)}`);
    });
    const baseConfig = resolveGoogleMeetConfig({});

    await launchChromeMeet({
      runtime: browserRuntime(gatewayRequest),
      config: {
        ...baseConfig,
        chrome: {
          ...baseConfig.chrome,
          joinTimeoutMs,
          reuseExistingTab: false,
        },
      },
      fullConfig: {},
      meetingSessionId: "session-1",
      mode: "transcribe",
      url: "https://meet.google.com/abc-defg-hij",
      logger,
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open", timeoutMs: joinTimeoutMs }),
      { timeoutMs: expectedTimeoutMs, scopes: ["operator.admin"] },
    );
  });

  it("keeps Gateway-hosted local browser calls inside the trusted runtime", async () => {
    const gatewayRequest = vi.fn(async () => ({ tabs: [] }));
    const runtime = browserRuntime(gatewayRequest);

    await recoverCurrentMeetTab({
      runtime,
      config: resolveGoogleMeetConfig({}),
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      {
        method: "GET",
        path: "/tabs",
        body: undefined,
        timeoutMs: 5_000,
      },
      { timeoutMs: 10_000, scopes: ["operator.admin"] },
    );
  });
});
