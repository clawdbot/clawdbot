// Browser tests cover pw tools core.snapshot.navigate guard plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import "../test-support/browser-security.mock.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreDownloadCapture,
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
    const page = {
      goto,
      url: vi.fn(() => "https://example.com"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
      timeoutMs: 10,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(goto).toHaveBeenCalledWith("https://example.com", { timeout: 1000 });
    expect(getPwToolsCoreSessionMocks().gotoPageWithNavigationGuard).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      ssrfPolicy: { allowPrivateNetwork: true },
      targetId: undefined,
      timeoutMs: 1000,
      url: "https://example.com",
    });
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: true },
      targetId: undefined,
    });
    expect(result.url).toBe("https://example.com");
  });

  it("returns managed download metadata when navigation starts an attachment download", async () => {
    const download = {
      url: "https://example.com/export.csv",
      suggestedFilename: "export.csv",
      path: "/tmp/openclaw/downloads/export.csv",
    };
    const downloadCapture = {
      armed: true,
      promise: Promise.resolve(download),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    const page = {
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      url: "https://example.com/export.csv",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: download.url, download });
    expect(downloadCapture.cancel).not.toHaveBeenCalled();
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
    expect(
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
    ).toHaveBeenCalledWith({
      url: download.url,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("returns managed download metadata for matching ERR_ABORTED attachment navigations", async () => {
    const download = {
      url: "http://127.0.0.1:3333/download",
      suggestedFilename: "proof.txt",
      path: "/tmp/openclaw/downloads/proof.txt",
    };
    const downloadCapture = {
      armed: true,
      promise: Promise.resolve(download),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        throw new Error("page.goto: net::ERR_ABORTED at http://127.0.0.1:3333/download");
      }),
      url: vi.fn(() => "about:blank"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "http://127.0.0.1:3333/download",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: download.url, download });
  });

  it("handles capture timeouts that win before ordinary navigation settles", async () => {
    let rejectCapture!: (err: Error) => void;
    const downloadCapture = {
      armed: true,
      promise: new Promise<never>((_, reject) => {
        rejectCapture = reject;
      }),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        rejectCapture(new Error("Timeout waiting for navigation download"));
        await Promise.resolve();
      }),
      url: vi.fn(() => "https://example.com/final"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com/final",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: "https://example.com/final" });
    expect(downloadCapture.cancel).toHaveBeenCalledTimes(1);
  });

  it("closes the tab when captured navigation download resolves to a blocked URL", async () => {
    const download = {
      url: "http://127.0.0.1:18080/export.csv",
      suggestedFilename: "export.csv",
      path: "/tmp/openclaw/downloads/export.csv",
    };
    const downloadCapture = {
      armed: true,
      promise: Promise.resolve(download),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    const page = {
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://93.184.216.34/start"),
    };
    setPwToolsCoreCurrentPage(page);
    getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        url: "https://93.184.216.34/export.csv",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(getPwToolsCoreSessionMocks().closeBlockedNavigationTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      targetId: "tab-1",
    });
  });

  it("surfaces managed download save failures", async () => {
    const downloadCapture = {
      armed: true,
      promise: Promise.reject(new Error("download save failed")),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        url: "https://example.com/export.csv",
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toThrow("download save failed");
  });

  it("rethrows download-starting navigation errors when no download is captured", async () => {
    const downloadCapture = {
      armed: false,
      promise: new Promise<never>(() => {}),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        throw new Error("page.goto: Download is starting");
      }),
      url: vi.fn(() => "https://example.com/start"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        url: "https://example.com/export.csv",
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toThrow("Download is starting");

    expect(downloadCapture.cancel).toHaveBeenCalledTimes(1);
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
      ssrfPolicy: { allowPrivateNetwork: true },
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
    const page = {
      goto,
      url: vi.fn(() => "https://93.184.216.34/final"),
    };
    setPwToolsCoreCurrentPage(page);
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
    // Navigate-style entry points OWN the navigation lifecycle, so when the
    // post-navigation safety check rejects with an SSRF policy error the
    // caller is responsible for closing the tab it just navigated. This is
    // the counterpart to the read-only paths (snapshot/screenshot/
    // interactions), which must NOT close the tab on the same error.
    expect(getPwToolsCoreSessionMocks().closeBlockedNavigationTarget).toHaveBeenCalledTimes(1);
    expect(getPwToolsCoreSessionMocks().closeBlockedNavigationTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      targetId: undefined,
    });
  });

  it("does not close the tab when post-navigation rejection is not a policy deny", async () => {
    // Non-policy errors (e.g. transient playwright failures) must not be
    // treated as "we navigated to a blocked URL" — the tab stays open.
    const goto = vi.fn(async () => ({ request: () => undefined }));
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/final"),
    });
    getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new Error("transient playwright error"),
    );

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://example.com/final",
      }),
    ).rejects.toThrow("transient playwright error");

    expect(getPwToolsCoreSessionMocks().closeBlockedNavigationTarget).not.toHaveBeenCalled();
  });
});
