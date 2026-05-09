import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDirectAgentForCdp,
  hasProxyEnv,
  withNoProxyForCdpUrl,
  withNoProxyForLocalhost,
} from "./cdp-proxy-bypass.js";

beforeEach(() => {
  vi.useRealTimers();
});

function createDeferred<T = void>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

async function withIsolatedNoProxyEnv(fn: () => Promise<void>) {
  const origNoProxy = process.env.NO_PROXY;
  const origNoProxyLower = process.env.no_proxy;
  const origHttpProxy = process.env.HTTP_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  process.env.HTTP_PROXY = "http://proxy:8080";

  try {
    await fn();
  } finally {
    if (origHttpProxy !== undefined) {
      process.env.HTTP_PROXY = origHttpProxy;
    } else {
      delete process.env.HTTP_PROXY;
    }
    if (origNoProxy !== undefined) {
      process.env.NO_PROXY = origNoProxy;
    } else {
      delete process.env.NO_PROXY;
    }
    if (origNoProxyLower !== undefined) {
      process.env.no_proxy = origNoProxyLower;
    } else {
      delete process.env.no_proxy;
    }
  }
}

describe("cdp-proxy-bypass", () => {
  describe("getDirectAgentForCdp", () => {
    it("returns http.Agent for http://localhost URLs", () => {
      const agent = getDirectAgentForCdp("http://localhost:9222");
      expect(agent).toBeInstanceOf(http.Agent);
    });

    it("returns http.Agent for http://127.0.0.1 URLs", () => {
      const agent = getDirectAgentForCdp("http://127.0.0.1:9222/json/version");
      expect(agent).toBeInstanceOf(http.Agent);
    });

    it("returns https.Agent for wss://localhost URLs", () => {
      const agent = getDirectAgentForCdp("wss://localhost:9222");
      expect(agent).toBeInstanceOf(https.Agent);
    });

    it("returns https.Agent for https://127.0.0.1 URLs", () => {
      const agent = getDirectAgentForCdp("https://127.0.0.1:9222/json/version");
      expect(agent).toBeInstanceOf(https.Agent);
    });

    it("returns http.Agent for ws://[::1] URLs", () => {
      const agent = getDirectAgentForCdp("ws://[::1]:9222");
      expect(agent).toBeInstanceOf(http.Agent);
    });

    it("returns undefined for non-loopback URLs", () => {
      expect(getDirectAgentForCdp("http://remote-host:9222")).toBeUndefined();
      expect(getDirectAgentForCdp("https://example.com:9222")).toBeUndefined();
    });

    it("returns undefined for invalid URLs", () => {
      expect(getDirectAgentForCdp("not-a-url")).toBeUndefined();
    });
  });

  describe("hasProxyEnv", () => {
    const proxyVars = [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const v of proxyVars) {
        saved[v] = process.env[v];
      }
      for (const v of proxyVars) {
        delete process.env[v];
      }
    });

    afterEach(() => {
      for (const v of proxyVars) {
        if (saved[v] !== undefined) {
          process.env[v] = saved[v];
        } else {
          delete process.env[v];
        }
      }
    });

    it("returns false when no proxy vars set", () => {
      expect(hasProxyEnv()).toBe(false);
    });

    it("returns true when HTTP_PROXY is set", () => {
      process.env.HTTP_PROXY = "http://proxy:8080";
      expect(hasProxyEnv()).toBe(true);
    });

    it("returns true when ALL_PROXY is set", () => {
      process.env.ALL_PROXY = "socks5://proxy:1080";
      expect(hasProxyEnv()).toBe(true);
    });
  });

  describe("withNoProxyForLocalhost", () => {
    const saved: Record<string, string | undefined> = {};
    const vars = ["HTTP_PROXY", "NO_PROXY", "no_proxy"];

    beforeEach(() => {
      for (const v of vars) {
        saved[v] = process.env[v];
      }
    });

    afterEach(() => {
      for (const v of vars) {
        if (saved[v] !== undefined) {
          process.env[v] = saved[v];
        } else {
          delete process.env[v];
        }
      }
    });

    it("sets NO_PROXY when proxy is configured", async () => {
      process.env.HTTP_PROXY = "http://proxy:8080";
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;

      let capturedNoProxy: string | undefined;
      await withNoProxyForLocalhost(async () => {
        capturedNoProxy = process.env.NO_PROXY;
      });

      expect(capturedNoProxy).toContain("localhost");
      expect(capturedNoProxy).toContain("127.0.0.1");
      expect(capturedNoProxy).toContain("[::1]");
      // Restored after
      expect(process.env.NO_PROXY).toBeUndefined();
    });

    it("extends existing NO_PROXY", async () => {
      process.env.HTTP_PROXY = "http://proxy:8080";
      process.env.NO_PROXY = "internal.corp";

      let capturedNoProxy: string | undefined;
      await withNoProxyForLocalhost(async () => {
        capturedNoProxy = process.env.NO_PROXY;
      });

      expect(capturedNoProxy).toContain("internal.corp");
      expect(capturedNoProxy).toContain("localhost");
      // Restored
      expect(process.env.NO_PROXY).toBe("internal.corp");
    });

    it("skips when no proxy env is set", async () => {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.ALL_PROXY;
      delete process.env.NO_PROXY;

      await withNoProxyForLocalhost(async () => {
        expect(process.env.NO_PROXY).toBeUndefined();
      });
    });

    it("restores env even on error", async () => {
      process.env.HTTP_PROXY = "http://proxy:8080";
      delete process.env.NO_PROXY;

      await expect(
        withNoProxyForLocalhost(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(process.env.NO_PROXY).toBeUndefined();
    });
  });
});

describe("withNoProxyForLocalhost concurrency", () => {
  it("does not leak NO_PROXY when called concurrently", async () => {
    await withIsolatedNoProxyEnv(async () => {
      const { withNoProxyForLocalhost } = await import("./cdp-proxy-bypass.js");

      const releaseA = createDeferred();
      const enteredA = createDeferred();

      const callA = withNoProxyForLocalhost(async () => {
        expect(process.env.NO_PROXY).toContain("localhost");
        expect(process.env.NO_PROXY).toContain("[::1]");
        enteredA.resolve();
        await releaseA.promise;
        return "a";
      });

      await enteredA.promise;

      const callB = withNoProxyForLocalhost(async () => {
        return "b";
      });

      expect(await callB).toBe("b");
      releaseA.resolve();
      expect(await callA).toBe("a");

      expect(process.env.NO_PROXY).toBeUndefined();
      expect(process.env.no_proxy).toBeUndefined();
    });
  });
});

describe("withNoProxyForLocalhost reverse exit order", () => {
  it("restores NO_PROXY when first caller exits before second", async () => {
    await withIsolatedNoProxyEnv(async () => {
      const { withNoProxyForLocalhost } = await import("./cdp-proxy-bypass.js");

      const enteredA = createDeferred();
      const enteredB = createDeferred();
      const releaseA = createDeferred();
      const releaseB = createDeferred();

      const callA = withNoProxyForLocalhost(async () => {
        enteredA.resolve();
        await releaseA.promise;
        return "a";
      });
      await enteredA.promise;

      const callB = withNoProxyForLocalhost(async () => {
        enteredB.resolve();
        await releaseB.promise;
        return "b";
      });
      await enteredB.promise;

      releaseA.resolve();
      expect(await callA).toBe("a");
      expect(process.env.NO_PROXY).toContain("localhost");

      releaseB.resolve();
      expect(await callB).toBe("b");

      expect(process.env.NO_PROXY).toBeUndefined();
      expect(process.env.no_proxy).toBeUndefined();
    });
  });
});

describe("withNoProxyForLocalhost preserves user-configured NO_PROXY", () => {
  it("does not delete NO_PROXY when loopback entries already present", async () => {
    const userNoProxy = "localhost,127.0.0.1,[::1],myhost.internal";
    process.env.NO_PROXY = userNoProxy;
    process.env.no_proxy = userNoProxy;
    process.env.HTTP_PROXY = "http://proxy:8080";

    try {
      const { withNoProxyForLocalhost } = await import("./cdp-proxy-bypass.js");

      await withNoProxyForLocalhost(async () => {
        // Should not modify since loopback is already covered
        expect(process.env.NO_PROXY).toBe(userNoProxy);
        return "ok";
      });

      // After call completes, user's NO_PROXY must still be intact
      expect(process.env.NO_PROXY).toBe(userNoProxy);
      expect(process.env.no_proxy).toBe(userNoProxy);
    } finally {
      delete process.env.HTTP_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
    }
  });
});

describe("withNoProxyForCdpUrl", () => {
  it("does not mutate NO_PROXY for non-loopback CDP URLs", async () => {
    process.env.HTTP_PROXY = "http://proxy:8080";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      await withNoProxyForCdpUrl("https://browserless.example/chrome?token=abc", async () => {
        expect(process.env.NO_PROXY).toBeUndefined();
        expect(process.env.no_proxy).toBeUndefined();
      });
    } finally {
      delete process.env.HTTP_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
    }
  });

  it("does not overwrite external NO_PROXY changes made during execution", async () => {
    process.env.HTTP_PROXY = "http://proxy:8080";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      await withNoProxyForCdpUrl("http://127.0.0.1:9222", async () => {
        process.env.NO_PROXY = "externally-set";
        process.env.no_proxy = "externally-set";
      });
      expect(process.env.NO_PROXY).toBe("externally-set");
      expect(process.env.no_proxy).toBe("externally-set");
    } finally {
      delete process.env.HTTP_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
    }
  });
});
