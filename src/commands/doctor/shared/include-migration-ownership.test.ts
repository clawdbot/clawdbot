import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  classifyOtelGrpcMigrationOwnership,
  isSingleTopLevelIncludeMigration,
} from "./include-migration-ownership.js";

const sourceConfig = {
  mcp: { servers: { local: { command: "node", disabled: true } } },
} as unknown as OpenClawConfig;
const candidate = {
  mcp: { servers: { local: { command: "node", enabled: false } } },
} as OpenClawConfig;

describe("include migration ownership", () => {
  const configDir = path.resolve("/tmp/openclaw-config");
  const configPath = path.join(configDir, "openclaw.json");
  const diagnosticsPath = path.join(configDir, "diagnostics.json5");
  const classifyOtelOwnership = (
    includeProvenance: NonNullable<
      Parameters<typeof classifyOtelGrpcMigrationOwnership>[0]["snapshot"]["includeProvenance"]
    >,
  ) =>
    classifyOtelGrpcMigrationOwnership({
      snapshot: { path: configPath, includeProvenance },
      authoredConfig: { diagnostics: { otel: { protocol: "grpc" } } },
      resolvedConfig: { diagnostics: { otel: { protocol: "grpc" } } },
    });

  it("classifies direct config even when an unrelated include exists", () => {
    expect(
      classifyOtelOwnership([
        {
          path: ["agents"],
          kind: "single",
          hasSiblingOverrides: false,
          targetPath: path.join(configDir, "agents.json5"),
        },
      ]),
    ).toEqual({ kind: "direct" });
  });

  it("allows one internal top-level include that solely owns diagnostics", () => {
    expect(
      classifyOtelOwnership([
        {
          path: ["diagnostics"],
          kind: "single",
          hasSiblingOverrides: false,
          targetPath: diagnosticsPath,
        },
      ]),
    ).toEqual({ kind: "single-top-level-include", targetPath: diagnosticsPath });
  });

  it.each([
    {
      name: "root include",
      includeProvenance: [
        {
          path: [],
          kind: "single" as const,
          hasSiblingOverrides: false,
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
      name: "nested include",
      includeProvenance: [
        {
          path: ["diagnostics", "otel"],
          kind: "single" as const,
          hasSiblingOverrides: false,
          targetPath: path.join(configDir, "otel.json5"),
        },
      ],
      targetPaths: [path.join(configDir, "otel.json5")],
    },
    {
      name: "sibling override",
      includeProvenance: [
        {
          path: ["diagnostics"],
          kind: "single" as const,
          hasSiblingOverrides: true,
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
          targetPath: path.resolve(configDir, "..", "external-diagnostics.json5"),
        },
      ],
      targetPaths: [path.resolve(configDir, "..", "external-diagnostics.json5")],
    },
  ])("requires manual repair for $name ownership", ({ includeProvenance, targetPaths }) => {
    expect(classifyOtelOwnership(includeProvenance)).toEqual({ kind: "manual", targetPaths });
  });

  it("allows one isolated direct top-level string include", () => {
    expect(
      isSingleTopLevelIncludeMigration({
        parsed: { mcp: { $include: "./mcp.json5" } },
        sourceConfig,
        candidate,
      }),
    ).toBe(true);
  });

  it.each([
    ["root include", { $include: "./openclaw.json5" }],
    ["include array", { mcp: { $include: ["./a.json5", "./b.json5"] } }],
    ["nested include", { mcp: { servers: { $include: "./servers.json5" } } }],
    ["sibling override", { mcp: { $include: "./mcp.json5", sessionIdleTtlMs: 1000 } }],
  ])("rejects %s ownership", (_label, parsed) => {
    expect(isSingleTopLevelIncludeMigration({ parsed, sourceConfig, candidate })).toBe(false);
  });

  it("rejects migrations that change more than one top-level section", () => {
    expect(
      isSingleTopLevelIncludeMigration({
        parsed: { mcp: { $include: "./mcp.json5" }, gateway: { mode: "local" } },
        sourceConfig: { ...sourceConfig, gateway: { mode: "local" } },
        candidate: { ...candidate, gateway: { mode: "remote" } },
      }),
    ).toBe(false);
  });
});
