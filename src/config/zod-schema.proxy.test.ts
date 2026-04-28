import { describe, it, expect } from "vitest";
import { ProxyConfigSchema } from "./zod-schema.proxy.js";

describe("ProxyConfigSchema", () => {
  it("accepts undefined (optional)", () => {
    expect(ProxyConfigSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts an empty object", () => {
    expect(ProxyConfigSchema.parse({})).toEqual({});
  });

  it("accepts a full valid config", () => {
    const result = ProxyConfigSchema.parse({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    expect(result).toMatchObject({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
  });

  it("rejects HTTPS proxy URLs because the node:http routing layer requires HTTP proxies", () => {
    expect(() =>
      ProxyConfigSchema.parse({
        enabled: true,
        proxyUrl: "https://proxy.example.com:8443",
      }),
    ).toThrow(/http:\/\//i);
  });

  it("does not expose bundled-proxy or unsupported upstream proxy keys", () => {
    const keys = ProxyConfigSchema.unwrap().keyof().options;
    expect(keys).not.toContain("binaryPath");
    expect(keys).not.toContain("extraBlockedCidrs");
    expect(keys).not.toContain("extraAllowedHosts");
    expect(keys).not.toContain("userProxy");
  });

  it("rejects proxyUrl values that are not HTTP forward proxies", () => {
    expect(() =>
      ProxyConfigSchema.parse({ enabled: true, proxyUrl: "socks5://127.0.0.1" }),
    ).toThrow();
    expect(() => ProxyConfigSchema.parse({ enabled: true, proxyUrl: "not-a-url" })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => ProxyConfigSchema.parse({ unknownKey: true })).toThrow();
  });

  it("accepts enabled: false to disable the proxy", () => {
    const result = ProxyConfigSchema.parse({ enabled: false });
    expect(result?.enabled).toBe(false);
  });
});
