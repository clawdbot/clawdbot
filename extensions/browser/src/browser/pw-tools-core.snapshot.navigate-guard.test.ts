import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import "../../test-support/browser-security-runtime.mock.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.snapshot.js");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

describe("pw-tools-core.snapshot navigate guard", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks unsupported non-network URLs before page lookup", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "about:blank"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("navigates valid network URLs with clamped timeout", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
      timeoutMs: 10,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(goto).toHaveBeenCalledWith("https://example.com", { timeout: 1000 });
    expect(getPwToolsCoreSessionMocks().gotoPageWithNavigationGuard).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: expect.anything(),
      ssrfPolicy: { allowPrivateNetwork: true },
      targetId: undefined,
      timeoutMs: 1000,
      url: "https://example.com",
    });
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: expect.anything(),
      response: null,
      ssrfPolicy: { allowPrivateNetwork: true },
      targetId: undefined,
    });
    expect(result.url).toBe("https://example.com");
  });

  it("reconnects and retries once when navigation detaches frame", async () => {
    const goto = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("page.goto: Frame has been detached"))
      .mockResolvedValueOnce(undefined);
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/recovered"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      url: "https://example.com/recovered",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).toHaveBeenCalledTimes(2);
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledTimes(
      1,
    );
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      reason: "retry navigate after detached frame",
    });
    expect(getPwToolsCoreSessionMocks().gotoPageWithNavigationGuard).toHaveBeenCalledTimes(2);
    expect(result.url).toBe("https://example.com/recovered");
  });

  it("blocks private intermediate redirect hops during navigation", async () => {
    const goto = vi.fn(async () => ({
      request: () => ({
        url: () => "https://93.184.216.34/final",
        redirectedFrom: () => ({
          url: () => "http://127.0.0.1:18080/internal-hop",
          redirectedFrom: () => ({
            url: () => "https://93.184.216.34/start",
            redirectedFrom: () => null,
          }),
        }),
      }),
    }));
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://93.184.216.34/final"),
    });
    getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(getPwToolsCoreSessionMocks().gotoPageWithNavigationGuard).toHaveBeenCalledTimes(1);
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledTimes(
      1,
    );
  });
});
