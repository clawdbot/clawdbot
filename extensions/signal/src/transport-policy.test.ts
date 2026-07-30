// Guards bind-alignment for managed-native connection URLs: only the ambiguous
// "localhost" name bridges IPv4/IPv6; exact cross-family pairs are different
// sockets whose URLs must survive bind-port reassignment untouched.
import { describe, expect, it } from "vitest";
import type { SignalTransportConfig } from "./account-types.js";
import {
  assignSignalManagedNativePort,
  deriveSignalManagedNativeBindPort,
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
});

// Regression coverage for #116165: an autoStart daemon with no configured httpPort
// must bind the port a local plain-http connection URL names, or the daemon and the
// client probe silently diverge onto different ports.
describe("deriveSignalManagedNativeBindPort", () => {
  it("derives the port from a local plain-http URL", () => {
    expect(deriveSignalManagedNativeBindPort("http://127.0.0.1:9090")).toBe(9090);
  });

  it("derives the port from a localhost plain-http URL", () => {
    expect(deriveSignalManagedNativeBindPort("http://localhost:9191")).toBe(9191);
  });

  it("does not steer the bind port for an https proxy endpoint", () => {
    // signal-cli binds plain HTTP; an https URL is a proxy in front of it, not the
    // daemon's own socket, so it must not name the daemon's bind port.
    expect(deriveSignalManagedNativeBindPort("https://127.0.0.1:9090")).toBeUndefined();
  });

  it("does not steer the bind port for a remote daemon URL", () => {
    expect(deriveSignalManagedNativeBindPort("http://signal.example.com:9090")).toBeUndefined();
  });

  it("returns undefined for a missing or unparseable baseUrl", () => {
    expect(deriveSignalManagedNativeBindPort(undefined)).toBeUndefined();
    expect(deriveSignalManagedNativeBindPort("not a url")).toBeUndefined();
  });

  it("defaults to port 80 for a local plain-http URL with no explicit port", () => {
    expect(deriveSignalManagedNativeBindPort("http://127.0.0.1")).toBe(80);
  });
});
