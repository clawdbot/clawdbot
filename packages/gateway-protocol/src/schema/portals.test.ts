import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PortalChangedEventSchema,
  PortalCloseResultSchema,
  PortalListResultSchema,
  PortalOpenResultSchema,
  PortalSummarySchema,
  validatePortalCloseParams,
  validatePortalListParams,
  validatePortalOpenParams,
} from "../index.js";

const portal = {
  id: "p3000",
  title: "Development app",
  port: 3000,
  listenPort: 43123,
  tokenQuery: `openclaw_portal=${"a".repeat(64)}`,
  url: `http://127.0.0.1:43123/app?openclaw_portal=${"a".repeat(64)}`,
  publicUrl: "http://127.0.0.1:43123/app",
  path: "/app",
  description: "Live preview",
  createdAtMs: 123,
};

describe("portal protocol schemas", () => {
  it("accepts closed list, open, and close requests", () => {
    expect(validatePortalListParams({})).toBe(true);
    expect(validatePortalOpenParams({ port: 3000, title: "Development app", path: "/app" })).toBe(
      true,
    );
    expect(validatePortalCloseParams({ id: "p3000" })).toBe(true);
    expect(validatePortalListParams({ extra: true })).toBe(false);
    expect(validatePortalOpenParams({ port: 0 })).toBe(false);
    expect(validatePortalOpenParams({ port: 65_536 })).toBe(false);
    expect(validatePortalOpenParams({ port: 3000, path: "app" })).toBe(false);
    expect(validatePortalOpenParams({ port: 3000, host: "example.test" })).toBe(false);
    expect(validatePortalCloseParams({ id: "" })).toBe(false);
  });

  it("validates summaries, results, and full replace-set events", () => {
    expect(Value.Check(PortalSummarySchema, portal)).toBe(true);
    expect(Value.Check(PortalOpenResultSchema, portal)).toBe(true);
    expect(Value.Check(PortalListResultSchema, { portals: [portal] })).toBe(true);
    const { tokenQuery: _tokenQuery, url: _url, ...redactedPortal } = portal;
    expect(Value.Check(PortalSummarySchema, redactedPortal)).toBe(true);
    expect(Value.Check(PortalOpenResultSchema, redactedPortal)).toBe(false);
    expect(Value.Check(PortalCloseResultSchema, { closed: true })).toBe(true);
    expect(Value.Check(PortalChangedEventSchema, { portals: [portal] })).toBe(true);
    const { publicUrl: _publicUrl, ...missingPublicUrl } = portal;
    expect(Value.Check(PortalSummarySchema, missingPublicUrl)).toBe(false);
    expect(Value.Check(PortalSummarySchema, { ...portal, targetPort: 3000 })).toBe(false);
    expect(Value.Check(PortalChangedEventSchema, { portal })).toBe(false);
  });
});
