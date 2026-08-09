import { describe, expect, it } from "vitest";
import {
  inspectPluginInstallRecordMap,
  parsePluginInstallRecordMap,
  serializePluginInstallRecordMap,
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
  });

  it("distinguishes missing maps from invalid maps", () => {
    expect(inspectPluginInstallRecordMap(undefined)).toEqual({ status: "missing" });
    expect(inspectPluginInstallRecordMap({ demo: { source: "bogus" } })).toEqual({
      status: "invalid",
    });
    expect(inspectPluginInstallRecordMap({})).toEqual({ status: "valid", records: {} });
  });

  it("rejects invalid records atomically", () => {
    expect(
      parsePluginInstallRecordMap({
        valid: { source: "npm" },
        invalid: { source: "npm", clawpackSize: -1 },
      }),
    ).toBeNull();
  });

  it("preserves prototype-named plugin ids as inert own properties", () => {
    const records = parsePluginInstallRecordMap(
      JSON.parse(
        '{"__proto__":{"source":"npm"},"constructor":{"source":"path"},"prototype":{"source":"git"}}',
      ) as Record<string, unknown>,
    );

    expect(Object.keys(records ?? {})).toEqual(["__proto__", "constructor", "prototype"]);
    expect(Object.hasOwn(records ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(records, "__proto__")?.value).toEqual({
      source: "npm",
    });
    expect(({} as Record<string, unknown>).source).toBeUndefined();
  });

  it("serializes numeric-looking keys in canonical lexical order", () => {
    const records = {
      2: { source: "npm" as const },
      10: { source: "path" as const },
      alpha: { source: "git" as const },
      1: { source: "archive" as const },
    };

    expect(Object.keys(records)).toEqual(["1", "2", "10", "alpha"]);
    expect(serializePluginInstallRecordMap(records)).toBe(
      '{"1":{"source":"archive"},"10":{"source":"path"},"2":{"source":"npm"},"alpha":{"source":"git"}}',
    );
  });
});
