import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "./installs.js";

function expectRecordedInstall(pluginId: string, next: ReturnType<typeof recordPluginInstall>) {
  expect(next).toEqual({
    plugins: {
      installs: {
        [pluginId]: {
          source: "npm",
          spec: `${pluginId}@latest`,
          installedAt: "2026-05-11T04:00:00.000Z",
        },
      },
    },
  });
}

function createExpectedResolutionFields(
  overrides: Partial<ReturnType<typeof buildNpmResolutionInstallFields>>,
) {
  return {
    resolvedName: undefined,
    resolvedVersion: undefined,
    resolvedSpec: undefined,
    integrity: undefined,
    shasum: undefined,
    resolvedAt: undefined,
    ...overrides,
  };
}

function expectResolutionFieldsCase(params: {
  input: Parameters<typeof buildNpmResolutionInstallFields>[0];
  expected: ReturnType<typeof buildNpmResolutionInstallFields>;
}) {
  expect(buildNpmResolutionInstallFields(params.input)).toEqual(params.expected);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildNpmResolutionInstallFields", () => {
  it.each([
    {
      name: "maps npm resolution metadata into install record fields",
      input: {
        name: "@openclaw/demo",
        version: "1.2.3",
        resolvedSpec: "@openclaw/demo@1.2.3",
        integrity: "sha512-abc",
        shasum: "deadbeef",
        resolvedAt: "2026-02-22T00:00:00.000Z",
      },
      expected: createExpectedResolutionFields({
        resolvedName: "@openclaw/demo",
        resolvedVersion: "1.2.3",
        resolvedSpec: "@openclaw/demo@1.2.3",
        integrity: "sha512-abc",
        shasum: "deadbeef",
        resolvedAt: "2026-02-22T00:00:00.000Z",
      }),
    },
    {
      name: "returns undefined fields when resolution is missing",
      input: undefined,
      expected: createExpectedResolutionFields({}),
    },
    {
      name: "keeps missing partial resolution fields undefined",
      input: {
        name: "@openclaw/demo",
      },
      expected: createExpectedResolutionFields({
        resolvedName: "@openclaw/demo",
      }),
    },
  ] as const)("$name", expectResolutionFieldsCase);
});

describe("recordPluginInstall", () => {
  it("stores install metadata for the plugin id", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T04:00:00.000Z"));

    const next = recordPluginInstall({}, { pluginId: "demo", source: "npm", spec: "demo@latest" });

    expectRecordedInstall("demo", next);
  });
});
