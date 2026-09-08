// Guards bind-alignment for managed-native connection URLs: only the ambiguous
// "localhost" name bridges IPv4/IPv6; exact cross-family pairs are different
// sockets whose URLs must survive bind-port reassignment untouched.
import { describe, expect, it } from "vitest";
import type { SignalTransportConfig } from "./account-types.js";
import {
  assignSignalManagedNativePort,
  preferredManagedNativePortFromConnectionUrl,
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

describe("preferredManagedNativePortFromConnectionUrl", () => {
  it("prefers the local connection URL port when httpPort is omitted", () => {
    expect(
      preferredManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://127.0.0.1:8082",
      }),
    ).toBe(8082);
  });

  it("does not prefer a port when httpPort is already set", () => {
    expect(
      preferredManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://127.0.0.1:8082",
        httpPort: 9090,
      }),
    ).toBeUndefined();
  });

  it("does not prefer a port when the URL is a different bind host", () => {
    expect(
      preferredManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://127.0.0.1:8080",
        httpHost: "127.0.0.2",
      }),
    ).toBeUndefined();
  });

  it("does not prefer remote, https, or cross-family endpoints", () => {
    expect(
      preferredManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://signal.example.com:8082",
      }),
    ).toBeUndefined();
    expect(
      preferredManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "https://127.0.0.1:8082",
      }),
    ).toBeUndefined();
    expect(
      preferredManagedNativePortFromConnectionUrl({
        kind: "managed-native",
        url: "http://[::1]:8082",
        httpHost: "127.0.0.1",
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

  it("rewrites a URL-only bind-aligned endpoint when fallback allocates a different port", () => {
    // Preferred URL port 8082 is already reserved; allocate 8080 instead.
    // Probe URL must follow the daemon bind.
    const next = assignSignalManagedNativePort(
      {
        kind: "managed-native",
        url: "http://127.0.0.1:8082",
      },
      8080,
    );
    expect(next.httpPort).toBe(8080);
    expect(next.url).toBe("http://127.0.0.1:8080");
  });

  it("keeps remote connection URLs independent when only the bind port is assigned", () => {
    const next = assignSignalManagedNativePort(
      {
        kind: "managed-native",
        url: "http://signal.example.com:8082",
      },
      8080,
    );
    expect(next.httpPort).toBe(8080);
    expect(next.url).toBe("http://signal.example.com:8082");
  });
});
