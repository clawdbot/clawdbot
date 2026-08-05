// Guards bind-alignment for managed-native connection URLs: only the ambiguous
// "localhost" name bridges IPv4/IPv6; exact cross-family pairs are different
// sockets whose URLs must survive bind-port reassignment untouched.
import { describe, expect, it } from "vitest";
import type { SignalTransportConfig } from "./account-types.js";
import {
  assignSignalManagedNativePort,
  inferLegacyManagedNativePortFromConnectionUrl,
} from "./transport-policy.js";

type SignalManagedNativeTransport = Extract<SignalTransportConfig, { kind: "managed-native" }>;

function managedTransport(url: string, httpHost?: string): SignalManagedNativeTransport {
  return {
    kind: "managed-native",
    url,
    ...(httpHost ? { httpHost } : {}),
    httpPort: 8080,
  };
}

describe("inferLegacyManagedNativePortFromConnectionUrl", () => {
  it("prefers a local connection URL port when httpPort is omitted", () => {
    expect(
      inferLegacyManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://127.0.0.1:8082",
      }),
    ).toBe(8082);
  });

  it("preserves an explicit default port from the raw legacy URL", () => {
    expect(
      inferLegacyManagedNativePortFromConnectionUrl(
        { kind: "managed-native", url: "http://127.0.0.1" },
        "http://127.0.0.1:80",
      ),
    ).toBe(80);
  });

  it("infers an explicit port from a bare legacy host URL", () => {
    expect(
      inferLegacyManagedNativePortFromConnectionUrl(
        { kind: "managed-native", url: "http://127.0.0.1:8082" },
        "127.0.0.1:8082",
      ),
    ).toBe(8082);
  });

  it("keeps the managed default for an unported local URL", () => {
    expect(
      inferLegacyManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://127.0.0.1",
      }),
    ).toBeUndefined();
  });

  it("does not override an explicit managed port", () => {
    expect(
      inferLegacyManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://127.0.0.1:8082",
        httpPort: 9090,
      }),
    ).toBeUndefined();
  });

  it("does not infer from a connection URL on a different bind host", () => {
    expect(
      inferLegacyManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://127.0.0.1:8080",
        httpHost: "127.0.0.2",
      }),
    ).toBeUndefined();
  });

  it("does not infer a daemon bind from a path-prefixed proxy URL", () => {
    expect(
      inferLegacyManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://127.0.0.1:8082/signal",
      }),
    ).toBeUndefined();
  });
});

describe("assignSignalManagedNativePort", () => {
  it("rewrites a localhost connection URL aligned with a loopback bind", () => {
    const next = assignSignalManagedNativePort(
      managedTransport("http://localhost:8080", "127.0.0.1"),
      9090,
    );
    expect(next.url).toBe("http://localhost:9090");
    expect(next.httpPort).toBe(9090);
  });

  it("keeps a cross-family loopback URL untouched on bind-port changes", () => {
    const next = assignSignalManagedNativePort(
      managedTransport("http://[::1]:8080", "127.0.0.1"),
      9090,
    );
    expect(next.url).toBe("http://[::1]:8080");
    expect(next.httpPort).toBe(9090);
  });

  it("keeps an omitted-port canonical connection URL independent", () => {
    const next = assignSignalManagedNativePort(
      { kind: "managed-native", url: "http://127.0.0.1:8082" },
      8080,
    );
    expect(next.url).toBe("http://127.0.0.1:8082");
    expect(next.httpPort).toBe(8080);
  });

  it("rewrites an explicit canonical path endpoint with its daemon bind", () => {
    const next = assignSignalManagedNativePort(
      managedTransport("http://127.0.0.1:8080/signal", "127.0.0.1"),
      9090,
    );
    expect(next.url).toBe("http://127.0.0.1:9090/signal");
    expect(next.httpPort).toBe(9090);
  });

  it("keeps a legacy path-prefixed proxy URL independent", () => {
    const next = assignSignalManagedNativePort(
      { kind: "managed-native", url: "http://127.0.0.1:8080/signal" },
      9090,
      { preservePathUrl: true },
    );
    expect(next.url).toBe("http://127.0.0.1:8080/signal");
    expect(next.httpPort).toBe(9090);
  });
});
