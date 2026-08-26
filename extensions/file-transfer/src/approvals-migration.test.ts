import { describe, expect, it } from "vitest";
import { applyApprovalMigration, listLegacyApprovalItems } from "./approvals-migration.js";

describe("file-transfer approval migration", () => {
  it("enumerates legacy positive permissions without changing wildcard semantics", () => {
    expect(
      listLegacyApprovalItems({
        nodes: {
          Shared: { allowReadPaths: ["/tmp/a", "/tmp/*.log", "/tmp/a"] },
          "*": { allowWritePaths: ["/tmp/**"] },
        },
      }),
    ).toEqual([
      { selector: "Shared", kind: "read", path: "/tmp/a" },
      { selector: "Shared", kind: "read", path: "/tmp/*.log" },
      { selector: "*", kind: "write", path: "/tmp/**" },
    ]);
  });

  it("atomically separates exact grants from confirmed authored globs", () => {
    const config = {
      nodes: {
        Shared: {
          ask: "off",
          allowReadPaths: ["/tmp/report-*.txt", "/var/log/**", "/tmp/remove.txt"],
          denyPaths: ["**/.ssh/**"],
        },
      },
    };
    const items = listLegacyApprovalItems(config);
    const migrated = applyApprovalMigration(config, [
      {
        item: items[0]!,
        action: "exact",
      },
      { item: items[1]!, action: "keep-glob" },
      { item: items[2]!, action: "remove" },
    ]);

    expect(migrated).toEqual({
      policyVersion: 2,
      nodes: {
        Shared: {
          ask: "on-miss",
          allowReadPaths: ["/var/log/**"],
          denyPaths: ["**/.ssh/**"],
        },
      },
    });
    expect(config.nodes.Shared.allowReadPaths).toEqual([
      "/tmp/report-*.txt",
      "/var/log/**",
      "/tmp/remove.txt",
    ]);
  });
});
