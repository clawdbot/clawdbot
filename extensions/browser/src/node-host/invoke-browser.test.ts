// Browser tests cover invoke browser plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const controlServiceMocks = vi.hoisted(() => ({
  createBrowserControlContext: vi.fn(() => ({ control: true })),
  startBrowserControlServiceFromConfig: vi.fn(async () => true),
}));

const dispatcherMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: dispatcherMocks.dispatch,
  })),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    browser: {},
    nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
  })),
  sourceConfig: null as Record<string, unknown> | null,
}));

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn((browser?: { defaultProfile?: string }) => ({
    enabled: true,
    defaultProfile: browser?.defaultProfile ?? "openclaw",
  })),
}));

vi.mock("../sdk-config.js", () => ({
  getRuntimeConfig: configMocks.loadConfig,
  getRuntimeConfigSourceSnapshot: () => configMocks.sourceConfig,
  loadConfig: configMocks.loadConfig,
}));

vi.mock("../sdk-node-runtime.js", () => ({
  withTimeout: vi.fn(
    async (
      run: (signal: AbortSignal | undefined) => Promise<unknown>,
      timeoutMs?: number,
      label?: string,
    ) => {
      const resolved =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
          ? Math.max(1, Math.floor(timeoutMs))
          : undefined;
      if (!resolved) {
        return await run(undefined);
      }
      const abortCtrl = new AbortController();
      const timeoutError = new Error(`${label ?? "request"} timed out`);
      const timer = setTimeout(() => abortCtrl.abort(timeoutError), resolved);
      try {
        return await Promise.race([
          run(abortCtrl.signal),
          new Promise<never>((_, reject) => {
            abortCtrl.signal.addEventListener(
              "abort",
              () =>
                reject(
                  toLintErrorObject(abortCtrl.signal.reason ?? timeoutError, "Non-Error rejection"),
                ),
              { once: true },
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  ),
}));

vi.mock("../sdk-setup-tools.js", () => ({
  detectMime: vi.fn(async () => "image/png"),
}));

vi.mock("../browser/cdp.helpers.js", () => ({
  redactCdpUrl: vi.fn((url: string) => {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      const normalized = parsed.toString().replace(/\/$/, "");
      const token = parsed.searchParams.get("token");
      if (!token || token.length <= 8) {
        return normalized;
      }
      return normalized.replace(token, `${token.slice(0, 6)}…${token.slice(-4)}`);
    } catch {
      return url;
    }
  }),
}));

vi.mock("../browser/config.js", () => ({
  resolveBrowserConfig: browserConfigMocks.resolveBrowserConfig,
}));

vi.mock("../browser/request-policy.js", () => ({
  isPersistentBrowserProfileMutation: vi.fn((method: string, path: string) => {
    if (method === "POST" && (path === "/profiles/create" || path === "/reset-profile")) {
      return true;
    }
    return method === "DELETE" && /^\/profiles\/[^/]+$/.test(path);
  }),
  normalizeBrowserRequestPath: vi.fn((path: string) => path),
  resolveRequestedBrowserProfile: vi.fn(
    ({
      query,
      body,
      profile,
    }: {
      query?: Record<string, unknown>;
      body?: unknown;
      profile?: string;
    }) => {
      if (query && typeof query.profile === "string" && query.profile.trim()) {
        return query.profile.trim();
      }
      const bodyProfile =
        body && typeof body === "object" ? (body as { profile?: unknown }).profile : undefined;
      if (typeof bodyProfile === "string" && bodyProfile.trim()) {
        return bodyProfile.trim();
      }
      return typeof profile === "string" && profile.trim() ? profile.trim() : undefined;
    },
  ),
}));

vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: dispatcherMocks.createBrowserRouteDispatcher,
}));

vi.mock("../control-service.js", () => ({
  createBrowserControlContext: controlServiceMocks.createBrowserControlContext,
  startBrowserControlServiceFromConfig: controlServiceMocks.startBrowserControlServiceFromConfig,
}));

let resetBrowserProxyCommandStateForTests: typeof import("./invoke-browser.js").resetBrowserProxyCommandStateForTests;
let runBrowserProxyCommand: typeof import("./invoke-browser.js").runBrowserProxyCommand;

beforeAll(async () => {
  ({ resetBrowserProxyCommandStateForTests, runBrowserProxyCommand } =
    await import("./invoke-browser.js"));
});

type BrowserDispatchRequest = {
  path?: string;
  query?: unknown;
};

function firstBrowserDispatchRequest(): BrowserDispatchRequest {
  const [call] = dispatcherMocks.dispatch.mock.calls;
  if (!call) {
    throw new Error("expected browser dispatch call");
  }
  const [request] = call as [BrowserDispatchRequest, ...unknown[]];
  return request;
}

describe("runBrowserProxyCommand", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetBrowserProxyCommandStateForTests();
    dispatcherMocks.dispatch.mockReset();
    dispatcherMocks.createBrowserRouteDispatcher.mockReset().mockImplementation(() => ({
      dispatch: dispatcherMocks.dispatch,
    }));
    controlServiceMocks.createBrowserControlContext.mockReset().mockReturnValue({ control: true });
    controlServiceMocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue(true);
    configMocks.sourceConfig = null;
    configMocks.loadConfig.mockReset().mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
    });
    browserConfigMocks.resolveBrowserConfig.mockReset().mockReturnValue({
      enabled: true,
      defaultProfile: "openclaw",
    });
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
    });
    browserConfigMocks.resolveBrowserConfig.mockReturnValue({
      enabled: true,
      defaultProfile: "openclaw",
    });
    controlServiceMocks.startBrowserControlServiceFromConfig.mockResolvedValue(true);
  });

  it("adds profile and browser status details on ws-backed timeouts", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: "http://127.0.0.1:18792",
        },
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "openclaw",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=openclaw; status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=http:\/\/127\.0\.0\.1:18792\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("includes chrome-mcp transport in timeout diagnostics when no CDP URL exists", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          transport: "chrome-mcp",
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: null,
        },
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "user",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=user; status\(running=true, cdpHttp=true, cdpReady=false, transport=chrome-mcp\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("redacts sensitive cdpUrl details in timeout diagnostics", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          cdpHttp: true,
          cdpReady: false,
          cdpUrl:
            "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
        },
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "remote",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=https:\/\/example\.com\/chrome\?token=supers…7890\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it.each([
    { status: 500, body: { error: "tab not found" }, expected: "500: tab not found" },
    {
      status: 404,
      body: { error: 'tab not found: browser tab "abc"' },
      expected: "404: tab not found",
    },
    { status: 503, body: { error: "" }, expected: "HTTP 503" },
  ])("preserves legacy node errors without envelope opt-in: $expected", async (response) => {
    dispatcherMocks.dispatch.mockResolvedValue(response);

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/act",
          profile: "openclaw",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow(response.expected);
  });

  it("preserves only validated browser error metadata in the proxy envelope", async () => {
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 409,
      body: {
        error: "headed mode needs a display",
        reason: "no_display_for_headed_profile",
        details: {
          profile: "openclaw",
          requestedHeadless: false,
          headlessSource: "config",
          displayPresent: false,
          remediation: "untrusted",
        },
        untrusted: "drop me",
      },
    });

    const result = JSON.parse(
      await runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/start",
          profile: "openclaw",
          errorEnvelope: "browser-v1",
        }),
      ),
    );

    expect(result).toEqual({
      error: {
        status: 409,
        body: {
          error: "headed mode needs a display",
          reason: "no_display_for_headed_profile",
          details: {
            profile: "openclaw",
            requestedHeadless: false,
            headlessSource: "config",
            displayPresent: false,
          },
        },
      },
    });
  });

  it("rejects unauthorized query.profile when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          query: { profile: "user" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("uses the browser source snapshot for proxy default-profile decisions", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: { defaultProfile: "openclaw" },
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["work"] } },
    });
    configMocks.sourceConfig = {
      browser: { defaultProfile: "work" },
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["work"] } },
    };
    browserConfigMocks.resolveBrowserConfig.mockImplementation(
      (browser?: { defaultProfile?: string }) => ({
        enabled: true,
        defaultProfile: browser?.defaultProfile ?? "openclaw",
      }),
    );
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });

    await runBrowserProxyCommand(
      JSON.stringify({
        method: "GET",
        path: "/snapshot",
        timeoutMs: 50,
      }),
    );

    const request = firstBrowserDispatchRequest();
    expect(request.path).toBe("/snapshot");
  });

  it("rejects unauthorized body.profile when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/stop",
          body: { profile: "user" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile creation when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/profiles/create",
          body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile deletion when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "DELETE",
          path: "/profiles/poc",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile reset when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/reset-profile",
          body: { profile: "openclaw", name: "openclaw" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("canonicalizes an allowlisted body profile into the dispatched query", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true, allowProfiles: ["openclaw"] } },
    });
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });

    await runBrowserProxyCommand(
      JSON.stringify({
        method: "POST",
        path: "/stop",
        body: { profile: "openclaw" },
        timeoutMs: 50,
      }),
    );

    const request = firstBrowserDispatchRequest();
    expect(request.path).toBe("/stop");
    expect(request.query).toEqual({ profile: "openclaw" });
  });

  it("caps browser proxy command timeout before dispatch", async () => {
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);

    try {
      await runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          timeoutMs: Number.MAX_SAFE_INTEGER,
        }),
      );
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects persistent profile creation when allowProfiles is empty", async () => {
    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/profiles/create",
          body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
