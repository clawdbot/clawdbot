import { describe, expect, it } from "vitest";
import {
  createPluginInstallRecordMap,
  inspectPluginInstallRecordMap,
  parsePluginInstallRecordMap,
  serializePluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "./plugin-install-record-map.js";

describe("plugin install record maps", () => {
  it("normalizes known fields while preserving passthrough fields", () => {
    const records = parsePluginInstallRecordMap({
      demo: {
        source: "npm",
        spec: " demo@1.0.0 ",
        clawhubTrustReasons: [" keep ", ""],
        futureMetadata: { retained: true },
      },
    });

    expect(records).toEqual({
      demo: {
        source: "npm",
        spec: "demo@1.0.0",
        clawhubTrustReasons: ["keep"],
        futureMetadata: { retained: true },
      },
    });
    expect(Object.getPrototypeOf(records)).toBeNull();
  });

  it("distinguishes missing maps from invalid maps", () => {
    expect(inspectPluginInstallRecordMap(undefined)).toEqual({ status: "missing" });
    expect(inspectPluginInstallRecordMap({ demo: { source: "bogus" } })).toEqual({
      status: "invalid",
    });
    const empty = inspectPluginInstallRecordMap({});
    expect(empty.status).toBe("valid");
    if (empty.status === "valid") {
      expect(Object.keys(empty.records)).toEqual([]);
      expect(Object.getPrototypeOf(empty.records)).toBeNull();
    }
  });

  it("rejects invalid records atomically", () => {
    expect(
      parsePluginInstallRecordMap({
        valid: { source: "npm" },
        invalid: { source: "npm", clawpackSize: -1 },
      }),
    ).toBeNull();
  });

  it("rejects malformed accepted capability surfaces", () => {
    expect(
      parsePluginInstallRecordMap({
        demo: {
          source: "npm",
          acceptedSurface: { tools: ["read"] },
          acceptedSurfaceHash: "claimed-hash",
        },
      }),
    ).toBeNull();
  });

  it.each(["constructor", "toString", "__proto__"])(
    "rejects an invalid %s record atomically",
    (pluginId) => {
      const records = createPluginInstallRecordMap<unknown>();
      setPluginInstallRecordMapEntry(records, "valid", { source: "npm" });
      setPluginInstallRecordMapEntry(records, pluginId, { source: "bogus" });

      expect(parsePluginInstallRecordMap(records)).toBeNull();
    },
  );

  it("preserves prototype-named plugin ids as inert own properties", () => {
    const records = parsePluginInstallRecordMap(
      JSON.parse(
        '{"__proto__":{"source":"npm"},"constructor":{"source":"path"},"toString":{"source":"git"}}',
      ) as Record<string, unknown>,
    );

    expect(Object.getPrototypeOf(records)).toBeNull();
    expect(Object.keys(records ?? {})).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(records ?? {}, "__proto__")).toBe(true);
    expect(Object.hasOwn(records ?? {}, "constructor")).toBe(true);
    expect(Object.hasOwn(records ?? {}, "toString")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(records, "__proto__")?.value).toEqual({
      source: "npm",
    });
    expect(({} as Record<string, unknown>).source).toBeUndefined();
  });

  it("serializes numeric-looking and Unicode keys in UTF-8 byte order", () => {
    const records = createPluginInstallRecordMap<{ source: "npm" | "path" | "git" | "archive" }>();
    setPluginInstallRecordMapEntry(records, "\u{10000}", { source: "git" });
    setPluginInstallRecordMapEntry(records, "2", { source: "npm" });
    setPluginInstallRecordMapEntry(records, "\uE000", { source: "path" });
    setPluginInstallRecordMapEntry(records, "10", { source: "path" });
    setPluginInstallRecordMapEntry(records, "1", { source: "archive" });

    expect(serializePluginInstallRecordMap(records)).toBe(
      '{"1":{"source":"archive"},"10":{"source":"path"},"2":{"source":"npm"},"\uE000":{"source":"path"},"\u{10000}":{"source":"git"}}',
    );
  });
});
