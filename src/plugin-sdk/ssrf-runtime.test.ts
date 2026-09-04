import { describe, expect, expectTypeOf, it } from "vitest";
import { fetchWithSsrFGuard, isLoopbackHost, isPrivateOrLoopbackHost } from "./ssrf-runtime.js";

it("accepts synchronous final dispatch callbacks and rejects asynchronous ones", () => {
  type BeforeRequest = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["beforeRequest"]>;
  expectTypeOf<() => void>().toMatchTypeOf<BeforeRequest>();
  expectTypeOf<() => Promise<void>>().not.toMatchTypeOf<BeforeRequest>();
});

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "LOCALHOST.",
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.254",
    "::1",
    "[::1]",
    "::ffff:127.0.0.2",
    "[::ffff:127.255.255.254]",
  ])("accepts loopback host %s", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["127.0.0.1.evil.com", "128.0.0.1", "10.0.0.1", "192.168.1.1", "::", "example.com", ""])(
    "rejects non-loopback host %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  it("stays narrower than the private-or-loopback predicate", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.1")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });
});
