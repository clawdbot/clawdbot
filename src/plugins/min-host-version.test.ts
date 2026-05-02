import { describe, expect, it } from "vitest";
import {
  checkMinHostVersion,
  MIN_HOST_VERSION_FORMAT,
  parseMinHostVersionRequirement,
  validateMinHostVersion,
} from "./min-host-version.js";

const MIN_HOST_REQUIREMENT = {
  raw: ">=2026.3.22",
  minimumLabel: "2026.3.22",
};
const BETA_MIN_HOST_REQUIREMENT = {
  raw: ">=2026.5.1-beta.1",
  minimumLabel: "2026.5.1-beta.1",
};

function expectValidHostCheck(currentVersion: string, minHostVersion?: string) {
  expectHostCheckResult({
    currentVersion,
    minHostVersion,
    expected: {
      ok: true,
      requirement: minHostVersion ? MIN_HOST_REQUIREMENT : null,
    },
  });
}

function expectHostCheckResult(params: {
  currentVersion: string;
  minHostVersion?: string | number;
  expected: unknown;
}) {
  expect(
    checkMinHostVersion({
      currentVersion: params.currentVersion,
      minHostVersion: params.minHostVersion,
    }),
  ).toEqual(params.expected);
}

function expectInvalidMinHostVersion(minHostVersion: string | number) {
  expect(validateMinHostVersion(minHostVersion)).toBe(MIN_HOST_VERSION_FORMAT);
  expectHostCheckResult({
    currentVersion: "2026.3.22",
    minHostVersion,
    expected: {
      ok: false,
      kind: "invalid",
      error: MIN_HOST_VERSION_FORMAT,
    },
  });
}

describe("min-host-version", () => {
  it("accepts empty metadata", () => {
    expect(validateMinHostVersion(undefined)).toBeNull();
    expect(parseMinHostVersionRequirement(undefined)).toBeNull();
    expectValidHostCheck("2026.3.22");
  });

  it("parses semver floors", () => {
    expect(parseMinHostVersionRequirement(">=2026.3.22")).toEqual(MIN_HOST_REQUIREMENT);
    expect(parseMinHostVersionRequirement(">=2026.5.1-beta.1")).toEqual(BETA_MIN_HOST_REQUIREMENT);
    expect(parseMinHostVersionRequirement(">=2026.5.1+20260501")).toEqual({
      raw: ">=2026.5.1+20260501",
      minimumLabel: "2026.5.1+20260501",
    });
  });

  it("can parse legacy bare semver floors for runtime upgrade compatibility", () => {
    expect(parseMinHostVersionRequirement("2026.3.22", { allowLegacyBareSemver: true })).toEqual({
      raw: "2026.3.22",
      minimumLabel: "2026.3.22",
    });
    expect(
      checkMinHostVersion({
        currentVersion: "2026.3.22",
        minHostVersion: "2026.3.22",
        allowLegacyBareSemver: true,
      }),
    ).toEqual({
      ok: true,
      requirement: {
        raw: "2026.3.22",
        minimumLabel: "2026.3.22",
      },
    });
  });

  it.each(["2026.3.22", 123, ">=2026.3.22 garbage"] as const)(
    "rejects invalid floor syntax and host checks: %p",
    (minHostVersion) => {
      expectInvalidMinHostVersion(minHostVersion);
    },
  );

  it.each([
    {
      name: "reports unknown host versions distinctly",
      currentVersion: "unknown",
      expected: {
        ok: false,
        kind: "unknown_host_version",
        requirement: MIN_HOST_REQUIREMENT,
      },
    },
    {
      name: "reports incompatible hosts",
      currentVersion: "2026.3.21",
      expected: {
        ok: false,
        kind: "incompatible",
        currentVersion: "2026.3.21",
        requirement: MIN_HOST_REQUIREMENT,
      },
    },
  ] as const)("$name", ({ currentVersion, expected }) => {
    expectHostCheckResult({
      currentVersion,
      minHostVersion: ">=2026.3.22",
      expected,
    });
  });

  it.each(["2026.3.22", "2026.4.0"] as const)(
    "accepts equal or newer hosts: %s",
    (currentVersion) => {
      expectValidHostCheck(currentVersion, ">=2026.3.22");
    },
  );
});
