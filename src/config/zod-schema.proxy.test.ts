import { describe, it, expect } from "vitest";
import { ProxyConfigSchema } from "./zod-schema.proxy.js";

function expectProxyConfigFailure(value: unknown) {
  const result = ProxyConfigSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("Expected proxy config to fail schema validation.");
  }
  return result.error.issues;
}

describe("ProxyConfigSchema", () => {
  it("accepts undefined (optional)", () => {
    expect(ProxyConfigSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts an empty object", () => {
    expect(ProxyConfigSchema.parse({})).toStrictEqual({});
  });

  it("accepts a full valid config", () => {
    const result = ProxyConfigSchema.parse({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "gateway-only",
    });
    expect(result).toEqual({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "gateway-only",
    });
  });

  it("accepts loopbackMode policy values", () => {
    expect(ProxyConfigSchema.parse({ loopbackMode: "gateway-only" })?.loopbackMode).toBe(
      "gateway-only",
    );
    expect(ProxyConfigSchema.parse({ loopbackMode: "proxy" })?.loopbackMode).toBe("proxy");
    expect(ProxyConfigSchema.parse({ loopbackMode: "block" })?.loopbackMode).toBe("block");
  });

  it("rejects unknown loopbackMode values", () => {
    const issues = expectProxyConfigFailure({ loopbackMode: "bypass" });
    expect(issues.map((issue) => issue.path.join("."))).toContain("loopbackMode");
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
    const socksIssues = expectProxyConfigFailure({
      enabled: true,
      proxyUrl: "socks5://127.0.0.1",
    });
    const invalidUrlIssues = expectProxyConfigFailure({ enabled: true, proxyUrl: "not-a-url" });
    expect(socksIssues.map((issue) => issue.path.join("."))).toContain("proxyUrl");
    expect(invalidUrlIssues.map((issue) => issue.path.join("."))).toContain("proxyUrl");
  });

  it("rejects unknown keys (strict)", () => {
    const issues = expectProxyConfigFailure({ unknownKey: true });
    expect(issues[0]?.code).toBe("unrecognized_keys");
  });

  it("accepts enabled: false to disable the proxy", () => {
    const result = ProxyConfigSchema.parse({ enabled: false });
    expect(result?.enabled).toBe(false);
  });
});
