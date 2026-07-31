/** Tests ACP translator session-list cursor and page-size helpers. */
import { describe, expect, it } from "vitest";
import {
  ACP_LIST_SESSIONS_MAX_FETCH_LIMIT,
  assertAbsoluteCwd,
  decodeListSessionsCursor,
  encodeListSessionsCursor,
  resolveListSessionsPageSize,
} from "./translator.session-list.js";

describe("ACP translator session list helpers", () => {
  it("round-trips opaque cursors with optional cwd filters", () => {
    const cursor = encodeListSessionsCursor({ offset: 25, cwd: "/tmp/work" });

    expect(decodeListSessionsCursor(cursor)).toEqual({ offset: 25, cwd: "/tmp/work" });
  });

  it("rejects invalid cursor payloads", () => {
    expect(() => decodeListSessionsCursor("not-base64-json")).toThrow(
      "Invalid ACP session list cursor.",
    );
    expect(() =>
      decodeListSessionsCursor(
        Buffer.from(
          JSON.stringify({ v: 1, offset: ACP_LIST_SESSIONS_MAX_FETCH_LIMIT }),
          "utf8",
        ).toString("base64url"),
      ),
    ).toThrow("Invalid ACP session list cursor offset.");
  });

  it("rejects altered and non-emitted cursor spellings", () => {
    const canonical = encodeListSessionsCursor({ offset: 25, cwd: "/tmp/work" });
    const extraField = Buffer.from(
      JSON.stringify({ v: 1, offset: 25, cwd: "/tmp/work", extra: true }),
      "utf8",
    ).toString("base64url");

    for (const cursor of [`${canonical}$`, `${canonical}=`, ` ${canonical} `, extraField]) {
      expect(() => decodeListSessionsCursor(cursor)).toThrow("Invalid ACP session list cursor.");
    }
  });

  it("clamps page size metadata to the bridge maximum", () => {
    expect(resolveListSessionsPageSize(null)).toBe(100);
    expect(resolveListSessionsPageSize({ limit: 2.9 })).toBe(2);
    expect(resolveListSessionsPageSize({ pageSize: 1_000 })).toBe(100);
    expect(resolveListSessionsPageSize({ limit: -1 })).toBe(1);
  });

  it("requires absolute cwd filters", () => {
    expect(() => assertAbsoluteCwd("relative", "session/list")).toThrow(
      "ACP session/list requires an absolute cwd.",
    );
    expect(() => assertAbsoluteCwd("/tmp/work", "session/list")).not.toThrow();
  });
});
