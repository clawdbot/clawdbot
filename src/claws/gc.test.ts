import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { clawhubRefOfRecord, collectClawGarbageCandidates } from "./gc.js";
import type { PersistedClawPackageRef } from "./provenance.js";

function pluginRecord(
  source: PluginInstallRecord["source"],
  extra: Partial<PluginInstallRecord> = {},
) {
  return { source, ...extra } as PluginInstallRecord;
}

function refRow(kind: "plugin" | "skill", ref: string): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "worker",
    clawName: "@acme/worker",
    kind,
    source: "clawhub",
    ref,
    version: "1.0.0",
    integrity: `sha256:${"a".repeat(64)}`,
    status: "complete",
    relationship: "managed",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("collectClawGarbageCandidates", () => {
  it("flags ClawHub plugins and skills without any package ref", () => {
    const plan = collectClawGarbageCandidates({
      plugins: {
        orphan: pluginRecord("clawhub", { clawhubPackage: "orphan", version: "1.0.0" }),
        npm: pluginRecord("npm", { spec: "npm:x" }),
      },
      skillSlugs: [{ ref: "stale-skill", workspace: "/tmp/workspace-worker" }],
      refs: [],
    });
    expect(plan.plugins).toEqual([{ installId: "orphan", ref: "orphan", version: "1.0.0" }]);
    expect(plan.skills).toEqual([{ ref: "stale-skill", workspace: "/tmp/workspace-worker" }]);
  });

  it("protects operator-owned and still-referenced packages", () => {
    const plan = collectClawGarbageCandidates({
      plugins: {
        orphan: pluginRecord("clawhub", { clawhubPackage: "orphan" }),
        referenced: pluginRecord("clawhub", { clawhubPackage: "referenced" }),
      },
      skillSlugs: [{ ref: "referenced-skill", workspace: "/tmp/workspace-worker" }],
      refs: [refRow("plugin", "referenced"), refRow("skill", "referenced-skill")],
    });
    expect(plan.plugins).toEqual([{ installId: "orphan", ref: "orphan" }]);
    expect(plan.skills).toEqual([]);
  });

  it("derives the ClawHub ref from the spec when clawhubPackage is absent", () => {
    expect(clawhubRefOfRecord(pluginRecord("clawhub", { spec: "clawhub:pager@1.0.0" }))).toBe(
      "pager",
    );
    expect(clawhubRefOfRecord(pluginRecord("clawhub", { clawhubPackage: "explicit" }))).toBe(
      "explicit",
    );
    expect(clawhubRefOfRecord(pluginRecord("npm"))).toBeUndefined();
  });
});
