// Gateway bind URL tests cover host and port normalization for gateway listeners.
import { describe, expect, it, vi } from "vitest";
import { resolveGatewayBindUrl } from "./gateway-bind-url.js";

describe("shared/gateway-bind-url", () => {
  it("returns null for loopback/default binds", () => {
    const pickTailnetHost = vi.fn(() => "100.64.0.1");
    const pickLanHost = vi.fn(() => "192.168.1.2");

    expect(
      resolveGatewayBindUrl({
        scheme: "ws",
        port: 18789,
        pickTailnetHost,
        pickLanHost,
      }),
    ).toBeNull();
    expect(pickTailnetHost).not.toHaveBeenCalled();
    expect(pickLanHost).not.toHaveBeenCalled();
  });

  it("resolves custom binds only when custom host is present after trimming", () => {
    const pickTailnetHost = vi.fn();
    const pickLanHost = vi.fn();

    expect(
      resolveGatewayBindUrl({
        bind: "custom",
        customBindHost: " gateway.local ",
        scheme: "wss",
        port: 443,
        pickTailnetHost,
        pickLanHost,
      }),
    ).toEqual({
      url: "wss://gateway.local:443",
      source: "gateway.bind=custom",
    });

    expect(
      resolveGatewayBindUrl({
        bind: "custom",
        customBindHost: "   ",
        scheme: "ws",
        port: 18789,
        pickTailnetHost,
        pickLanHost,
      }),
    ).toEqual({
      error: "gateway.bind=custom requires gateway.customBindHost.",
    });
    expect(pickTailnetHost).not.toHaveBeenCalled();
    expect(pickLanHost).not.toHaveBeenCalled();
  });

  it("resolves tailnet and lan binds or returns clear errors", () => {
    expect(
      resolveGatewayBindUrl({
        bind: "tailnet",
        scheme: "ws",
        port: 18789,
        pickTailnetHost: () => "100.64.0.1",
        pickLanHost: vi.fn(),
      }),
    ).toEqual({
      url: "ws://100.64.0.1:18789",
      source: "gateway.bind=tailnet",
    });
    expect(
      resolveGatewayBindUrl({
        bind: "tailnet",
        scheme: "ws",
        port: 18789,
        pickTailnetHost: () => null,
        pickLanHost: vi.fn(),
      }),
    ).toEqual({
      error: "gateway.bind=tailnet set, but no tailnet IP was found.",
    });

    expect(
      resolveGatewayBindUrl({
        bind: "lan",
        scheme: "wss",
        port: 8443,
        pickTailnetHost: vi.fn(),
        pickLanHost: () => "192.168.1.2",
      }),
    ).toEqual({
      url: "wss://192.168.1.2:8443",
      source: "gateway.bind=lan",
    });
    expect(
      resolveGatewayBindUrl({
        bind: "lan",
        scheme: "ws",
        port: 18789,
        pickTailnetHost: vi.fn(),
        pickLanHost: () => null,
      }),
    ).toEqual({
      error: "gateway.bind=lan set, but no private LAN IP was found.",
    });
  });

  it("returns null for unrecognized bind values without probing pickers", () => {
    const pickTailnetHost = vi.fn(() => "100.64.0.1");
    const pickLanHost = vi.fn(() => "192.168.1.2");

    expect(
      resolveGatewayBindUrl({
        bind: "loopbackish",
        scheme: "ws",
        port: 18789,
        pickTailnetHost,
        pickLanHost,
      }),
    ).toBeNull();
    expect(pickTailnetHost).not.toHaveBeenCalled();
    expect(pickLanHost).not.toHaveBeenCalled();
  });
});
