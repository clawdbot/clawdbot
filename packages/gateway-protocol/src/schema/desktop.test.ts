import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  DesktopLaunchParamsSchema,
  DesktopObserveResultSchema,
  validateDesktopObserveParams,
} from "../index.js";

describe("desktop protocol schemas", () => {
  it("accepts host, environment, and node observe sources", () => {
    expect(validateDesktopObserveParams({ source: { kind: "host" }, control: true })).toBe(true);
    expect(
      validateDesktopObserveParams({
        source: { kind: "host" },
        credentials: { username: "operator", password: "secret" },
      }),
    ).toBe(true);
    expect(
      validateDesktopObserveParams({
        source: { kind: "environment", environmentId: "worker:one" },
      }),
    ).toBe(true);
    expect(validateDesktopObserveParams({ source: { kind: "node", nodeId: "one" } })).toBe(true);
    expect(
      validateDesktopObserveParams({
        source: { kind: "node", nodeId: "one" },
        credentials: { username: "operator", password: "secret" },
      }),
    ).toBe(true);
    expect(
      validateDesktopObserveParams({
        source: { kind: "node", nodeId: "one" },
        credentials: { password: "secret" },
      }),
    ).toBe(true);
    expect(validateDesktopObserveParams({ source: { kind: "node", nodeId: "" } })).toBe(false);
    expect(validateDesktopObserveParams({ source: { kind: "future" } })).toBe(false);
    expect(
      validateDesktopObserveParams({
        source: { kind: "environment", environmentId: "worker:one" },
        credentials: { password: "secret" },
      }),
    ).toBe(false);
    expect(
      validateDesktopObserveParams({
        source: { kind: "host" },
        credentials: { username: "", password: "secret" },
      }),
    ).toBe(false);
    expect(validateDesktopObserveParams({ source: { kind: "host", environmentId: "one" } })).toBe(
      false,
    );
  });

  it("keeps launch environment-only and desktop auth additive", () => {
    expect(
      Value.Check(DesktopLaunchParamsSchema, {
        source: { kind: "environment", environmentId: "worker:one" },
        app: "browser",
      }),
    ).toBe(true);
    expect(
      Value.Check(DesktopLaunchParamsSchema, { source: { kind: "host" }, app: "browser" }),
    ).toBe(false);
    expect(
      Value.Check(DesktopObserveResultSchema, {
        transport: "rfb",
        wsPath: "/desktop/observe?token=abc",
        expiresAtMs: 1,
        control: false,
        auth: "ard-account",
        preauthenticated: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(DesktopObserveResultSchema, {
        transport: "rfb",
        wsPath: "/desktop/observe?token=abc",
        expiresAtMs: 1,
        control: false,
        auth: "vencrypt",
      }),
    ).toBe(false);
  });
});
