import { describe, expect, it, vi } from "vitest";
import type { MigrationProviderContext } from "../plugins/types.js";
import {
  applyMigrationConfigPatchItem,
  createMigrationConfigPatchItem,
  hasMigrationConfigPatchConflict,
  mergeMigrationConfigValue,
  writeMigrationConfigPath,
} from "./migration.js";

describe("migration config patches", () => {
  it("drops blocked keys recursively from objects and arrays", () => {
    const patch = JSON.parse(
      '{"__proto__":{"polluted":true},"safe":{"prototype":{"polluted":true},"next":true},"list":[{"constructor":{"polluted":true},"kept":true}]}',
    );

    const merged = mergeMigrationConfigValue({ safe: { keep: true } }, patch) as Record<
      string,
      unknown
    >;

    expect(merged).toEqual({
      safe: { keep: true, next: true },
      list: [{ kept: true }],
    });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(merged.safe as object)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects blocked path segments before mutating the target", () => {
    const config: Record<string, unknown> = {};

    expect(() =>
      writeMigrationConfigPath(config, ["models", "__proto__", "polluted"], true),
    ).toThrow("unsafe config patch path");
    expect(config).toEqual({});
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("reports unsafe migration items as errors without calling the config writer", async () => {
    const mutateConfigFile = vi.fn();
    const config: MigrationProviderContext["config"] = {};
    const ctx = {
      config,
      stateDir: "/tmp/openclaw-migration-test",
      logger: {},
      runtime: {
        config: {
          current: () => config,
          mutateConfigFile,
        },
      },
    } as unknown as MigrationProviderContext;
    const item = createMigrationConfigPatchItem({
      id: "config:unsafe",
      target: "models.__proto__.polluted",
      path: ["models", "__proto__", "polluted"],
      value: true,
      message: "unsafe patch",
    });

    await expect(applyMigrationConfigPatchItem(ctx, item)).resolves.toEqual(
      expect.objectContaining({ status: "error", reason: "unsafe config patch path" }),
    );
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("ignores blocked and inherited keys during conflict checks", () => {
    const patch = JSON.parse(
      '{"__proto__":{"polluted":true},"toString":{"command":"safe-own-value"}}',
    );

    expect(
      hasMigrationConfigPatchConflict({ mcp: { servers: {} } }, ["mcp", "servers"], patch),
    ).toBe(false);
  });
});
