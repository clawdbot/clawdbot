import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
} from "./active-proxy-state.js";
import {
  addActiveManagedProxyTlsOptions,
  resolveActiveManagedProxyTlsOptions,
  resolveManagedEnvHttpProxyAgentOptions,
} from "./managed-proxy-undici.js";

describe("managed proxy undici TLS options", () => {
  const envKeys = [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ] as const;
  const tempDirs: string[] = [];

  beforeEach(() => {
    _resetActiveManagedProxyStateForTests();
    for (const key of envKeys) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    _resetActiveManagedProxyStateForTests();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  function writeTempCa(contents: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-proxy-ca-"));
    tempDirs.push(dir);
    const caFile = path.join(dir, "proxy-ca.pem");
    writeFileSync(caFile, contents, "utf8");
    return caFile;
  }

  it("adds active proxy CA trust only to matching explicit proxy URLs", () => {
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    registerActiveManagedProxyUrl(new URL("https://managed.example:8443"), {
      loopbackMode: "gateway-only",
      proxyTls: { ca: "active-managed-ca" },
    });

    expect(
      addActiveManagedProxyTlsOptions({
        uri: "https://managed.example:8443",
        allowH2: false,
      }),
    ).toStrictEqual({
      uri: "https://managed.example:8443",
      allowH2: false,
      proxyTls: { ca: "active-managed-ca" },
    });
    expect(
      addActiveManagedProxyTlsOptions({
        uri: "https://account-proxy.example:8443",
        allowH2: false,
      }),
    ).toStrictEqual({
      uri: "https://account-proxy.example:8443",
      allowH2: false,
    });
  });

  it("loads inherited proxy CA trust only for the inherited proxy URL", () => {
    const caFile = writeTempCa("inherited-managed-ca");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("https_proxy", "https://managed.example:8443");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);

    expect(resolveActiveManagedProxyTlsOptions()).toStrictEqual({
      ca: "inherited-managed-ca",
    });
    expect(
      resolveActiveManagedProxyTlsOptions({
        proxyUrl: "https://managed.example:8443",
      }),
    ).toStrictEqual({ ca: "inherited-managed-ca" });
    expect(
      resolveActiveManagedProxyTlsOptions({
        proxyUrl: "https://account-proxy.example:8443",
      }),
    ).toBeUndefined();
  });

  it("loads inherited proxy CA trust from supplied env", () => {
    const caFile = writeTempCa("supplied-env-managed-ca");

    expect(
      resolveManagedEnvHttpProxyAgentOptions({
        OPENCLAW_PROXY_ACTIVE: "1",
        HTTPS_PROXY: "https://managed.example:8443",
        OPENCLAW_PROXY_CA_FILE: caFile,
      }),
    ).toStrictEqual({
      httpsProxy: "https://managed.example:8443",
      proxyTls: { ca: "supplied-env-managed-ca" },
    });
  });
});
