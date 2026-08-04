import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyConfigPathMigrationOwnership } from "./include-migration-ownership.js";

describe("include migration ownership", () => {
  const configDir = path.resolve("/tmp/openclaw-config");
  const configPath = path.join(configDir, "openclaw.json");
  const diagnosticsPath = path.join(configDir, "diagnostics.json5");

  it("classifies direct config even when an unrelated include exists", () => {
    expect(
      classifyConfigPathMigrationOwnership({
        snapshot: {
          path: configPath,
          includeProvenance: [
            {
              path: ["agents"],
              kind: "single",
              hasSiblingOverrides: false,
              hasArrayAncestor: false,
              targetPath: path.join(configDir, "agents.json5"),
            },
          ],
        },
        configPath: ["diagnostics", "otel", "protocol"],
      }),
    ).toEqual({ kind: "direct" });
  });

  it("allows one internal top-level include that solely owns diagnostics", () => {
    expect(
      classifyConfigPathMigrationOwnership({
        snapshot: {
          path: configPath,
          includeProvenance: [
            {
              path: ["diagnostics"],
              kind: "single",
              hasSiblingOverrides: false,
              hasArrayAncestor: false,
              targetPath: diagnosticsPath,
            },
          ],
        },
        configPath: ["diagnostics", "otel", "protocol"],
      }),
    ).toEqual({ kind: "single-include", targetPath: diagnosticsPath });
  });

  it("allows the deepest sole owner in a nested include chain", () => {
    const otelPath = path.join(configDir, "otel.json5");
    expect(
      classifyConfigPathMigrationOwnership({
        snapshot: {
          path: configPath,
          includeProvenance: [
            {
              path: ["diagnostics", "otel"],
              kind: "single",
              hasSiblingOverrides: false,
              hasArrayAncestor: false,
              targetPath: otelPath,
            },
            {
              path: ["diagnostics"],
              kind: "single",
              hasSiblingOverrides: false,
              hasArrayAncestor: false,
              targetPath: diagnosticsPath,
            },
          ],
        },
        configPath: ["diagnostics", "otel", "protocol"],
      }),
    ).toEqual({ kind: "single-include", targetPath: otelPath });
  });

  it.each([
    {
      name: "root include",
      includeProvenance: [
        {
          path: [],
          kind: "single" as const,
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
          targetPath: path.join(configDir, "root.json5"),
        },
      ],
      targetPaths: [path.join(configDir, "root.json5")],
    },
    {
      name: "include array",
      includeProvenance: [
        {
          path: ["diagnostics"],
          kind: "multiple" as const,
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
          targetPaths: [
            path.join(configDir, "diagnostics-a.json5"),
            path.join(configDir, "diagnostics-b.json5"),
          ],
        },
      ],
      targetPaths: [
        path.join(configDir, "diagnostics-a.json5"),
        path.join(configDir, "diagnostics-b.json5"),
      ],
    },
    {
      name: "sibling override",
      includeProvenance: [
        {
          path: ["diagnostics"],
          kind: "single" as const,
          hasSiblingOverrides: true,
          hasArrayAncestor: false,
          targetPath: diagnosticsPath,
        },
      ],
      targetPaths: [diagnosticsPath],
    },
    {
      name: "external include",
      includeProvenance: [
        {
          path: ["diagnostics"],
          kind: "single" as const,
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
          targetPath: path.resolve(configDir, "..", "external-diagnostics.json5"),
        },
      ],
      targetPaths: [path.resolve(configDir, "..", "external-diagnostics.json5")],
    },
  ])("requires manual repair for $name ownership", ({ includeProvenance, targetPaths }) => {
    expect(
      classifyConfigPathMigrationOwnership({
        snapshot: { path: configPath, includeProvenance },
        configPath: ["diagnostics", "otel", "protocol"],
      }),
    ).toEqual({ kind: "manual", targetPaths });
  });

  it("requires manual repair below an actual array entry", () => {
    const targetPath = path.join(configDir, "otel.json5");
    expect(
      classifyConfigPathMigrationOwnership({
        snapshot: {
          path: configPath,
          includeProvenance: [
            {
              path: ["diagnostics", "0"],
              kind: "single",
              hasSiblingOverrides: false,
              hasArrayAncestor: true,
              targetPath,
            },
          ],
        },
        configPath: ["diagnostics", "0", "protocol"],
      }),
    ).toEqual({ kind: "manual", targetPaths: [targetPath] });
  });
});
