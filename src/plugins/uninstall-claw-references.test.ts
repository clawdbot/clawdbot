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

  it("matches a scoped ClawHub spec recorded without a version", () => {
    readClawPackageRefsMock.mockReturnValue([
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@owner/audit",
        version: "2.0.1",
        status: "installed",
        clawName: "@owner/audit-claw",
      },
    ]);

    expect(
      collectClawPluginUninstallWarnings({
        pluginId: "audit",
        installRecord: {
          source: "clawhub" as const,
          spec: "clawhub:@owner/audit",
          version: "2.0.1",
        },
      }),
    ).toContain('Warning: plugin "audit" is referenced by Claw: @owner/audit-claw.');
  });
});
