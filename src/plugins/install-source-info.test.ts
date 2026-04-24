import { describe, expect, it } from "vitest";
import { describePluginInstallSource } from "./install-source-info.js";

describe("describePluginInstallSource", () => {
  it("marks exact npm specs with integrity as fully pinned", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "@vendor/demo@1.2.3",
        expectedIntegrity: " sha512-demo ",
        defaultChoice: "npm",
      }),
    ).toEqual({
      defaultChoice: "npm",
      npm: {
        spec: "@vendor/demo@1.2.3",
        packageName: "@vendor/demo",
        selector: "1.2.3",
        selectorKind: "exact-version",
        exactVersion: true,
        expectedIntegrity: "sha512-demo",
        pinState: "exact-with-integrity",
      },
      warnings: [],
    });
  });

  it("marks exact npm specs without integrity as version-pinned only", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "@vendor/demo@1.2.3",
      }),
    ).toEqual({
      npm: {
        spec: "@vendor/demo@1.2.3",
        packageName: "@vendor/demo",
        selector: "1.2.3",
        selectorKind: "exact-version",
        exactVersion: true,
        pinState: "exact-without-integrity",
      },
      warnings: ["npm-spec-missing-integrity"],
    });
  });

  it("omits whitespace-only integrity from npm source facts", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "@vendor/demo@1.2.3",
        expectedIntegrity: "   ",
      }),
    ).toEqual({
      npm: {
        spec: "@vendor/demo@1.2.3",
        packageName: "@vendor/demo",
        selector: "1.2.3",
        selectorKind: "exact-version",
        exactVersion: true,
        pinState: "exact-without-integrity",
      },
      warnings: ["npm-spec-missing-integrity"],
    });
  });

  it("treats non-string integrity metadata as missing", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "@vendor/demo@1.2.3",
        expectedIntegrity: 123,
      } as never),
    ).toEqual({
      npm: {
        spec: "@vendor/demo@1.2.3",
        packageName: "@vendor/demo",
        selector: "1.2.3",
        selectorKind: "exact-version",
        exactVersion: true,
        pinState: "exact-without-integrity",
      },
      warnings: ["npm-spec-missing-integrity"],
    });
  });

  it("surfaces floating specs with integrity without rejecting them", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "@vendor/demo@beta",
        expectedIntegrity: "sha512-demo",
      }),
    ).toEqual({
      npm: {
        spec: "@vendor/demo@beta",
        packageName: "@vendor/demo",
        selector: "beta",
        selectorKind: "tag",
        exactVersion: false,
        expectedIntegrity: "sha512-demo",
        pinState: "floating-with-integrity",
      },
      warnings: ["npm-spec-floating"],
    });
  });

  it("surfaces floating specs without integrity without rejecting them", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "@vendor/demo@beta",
      }),
    ).toEqual({
      npm: {
        spec: "@vendor/demo@beta",
        packageName: "@vendor/demo",
        selector: "beta",
        selectorKind: "tag",
        exactVersion: false,
        pinState: "floating-without-integrity",
      },
      warnings: ["npm-spec-floating", "npm-spec-missing-integrity"],
    });
  });

  it("reports invalid npm specs while preserving local source metadata", () => {
    expect(
      describePluginInstallSource({
        npmSpec: "github:vendor/demo",
        localPath: "extensions/demo",
      }),
    ).toEqual({
      local: {
        path: "extensions/demo",
      },
      warnings: ["invalid-npm-spec"],
    });
  });
});
