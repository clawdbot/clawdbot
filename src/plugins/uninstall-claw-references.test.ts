import { beforeEach, describe, expect, it, vi } from "vitest";

const readClawPackageRefsMock = vi.hoisted(() => vi.fn());

vi.mock("../claws/provenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claws/provenance.js")>()),
  readClawPackageRefs: readClawPackageRefsMock,
}));

const { collectClawPluginUninstallWarnings } = await import("./uninstall-claw-references.js");

const installRecord = {
  source: "clawhub" as const,
  clawhubPackage: "@owner/audit",
  version: "2.0.1",
};

describe("collectClawPluginUninstallWarnings", () => {
  beforeEach(() => {
    readClawPackageRefsMock.mockReset();
  });

  it("ignores a dependency that was conclusively rolled back", () => {
    readClawPackageRefsMock.mockReturnValue([
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@owner/audit",
        version: "2.0.1",
        status: "rolled_back",
        clawName: "@owner/audit-claw",
      },
    ]);

    expect(collectClawPluginUninstallWarnings({ pluginId: "audit", installRecord })).toEqual([]);
  });

  it("keeps warning for an uncertain failed install", () => {
    readClawPackageRefsMock.mockReturnValue([
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@owner/audit",
        version: "2.0.1",
        status: "failed",
        clawName: "@owner/audit-claw",
      },
    ]);

    expect(collectClawPluginUninstallWarnings({ pluginId: "audit", installRecord })).toContain(
      'Warning: plugin "audit" is referenced by Claw: @owner/audit-claw.',
    );
  });

  it.each([
    {
      label: "prefers the canonical package over the raw spec",
      record: {
        source: "clawhub" as const,
        spec: "clawhub:@alias/audit@2.0.1",
        clawhubPackage: "@owner/audit",
        version: "2.0.1",
      },
      ref: "@owner/audit",
    },
    {
      label: "falls back to the plugin id when the package fields are absent",
      record: { source: "clawhub" as const, version: "2.0.1" },
      ref: "audit",
    },
  ])("$label", ({ record, ref }) => {
    readClawPackageRefsMock.mockReturnValue([
      {
        kind: "plugin",
        source: "clawhub",
        ref,
        version: "2.0.1",
        status: "complete",
        clawName: "@owner/audit-claw",
      },
    ]);

    expect(
      collectClawPluginUninstallWarnings({
        pluginId: "audit",
        installRecord: record,
      }),
    ).toContain('Warning: plugin "audit" is referenced by Claw: @owner/audit-claw.');
  });
});
