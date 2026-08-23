// Line tests cover allowlist config-edit adapter plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";

const allowlist = linePlugin.allowlist;

describe("line allowlist adapter", () => {
  it("exposes the config-edit contract", () => {
    expect(allowlist?.applyConfigEdit).toBeTypeOf("function");
    expect(allowlist?.readConfig).toBeTypeOf("function");
    expect(allowlist?.supportsScope).toBeTypeOf("function");
  });

  it.each([
    { scope: "dm", expected: true },
    { scope: "group", expected: true },
    { scope: "all", expected: true },
  ] as const)("supports the $scope scope", ({ scope, expected }) => {
    expect(allowlist?.supportsScope?.({ scope })).toBe(expected);
  });

  it("reads dm/group allowlists and group overrides from line config", () => {
    const cfg = {
      channels: {
        line: {
          enabled: true,
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["Ualice"],
          groupAllowFrom: ["Ubob"],
          groups: {
            Cgroup1: { allowFrom: ["Ucarol"] },
          },
        },
      },
    } as OpenClawConfig;

    expect(allowlist?.readConfig?.({ cfg, accountId: "default" })).toEqual({
      dmAllowFrom: ["Ualice"],
      groupAllowFrom: ["Ubob"],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "Cgroup1", entries: ["Ucarol"] }],
    });
  });

  it("adds a dm allowlist entry under channels.line.allowFrom", () => {
    const parsedConfig: Record<string, unknown> = {};
    const result = allowlist?.applyConfigEdit?.({
      cfg: {} as OpenClawConfig,
      parsedConfig,
      accountId: "default",
      scope: "dm",
      action: "add",
      entry: "Udave",
    });

    expect(result).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.line.allowFrom",
      writeTarget: { kind: "channel", scope: { channelId: "line" } },
    });
    expect(parsedConfig).toMatchObject({ channels: { line: { allowFrom: ["Udave"] } } });
  });

  it("adds a dm allowlist entry under the named LINE account", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: {
        line: {
          allowFrom: ["Uexisting"],
          accounts: {
            support: {},
          },
        },
      },
    };
    const result = allowlist?.applyConfigEdit?.({
      cfg: parsedConfig as OpenClawConfig,
      parsedConfig,
      accountId: "support",
      scope: "dm",
      action: "add",
      entry: "Unew",
    });

    expect(result).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.line.accounts.support.allowFrom",
      writeTarget: {
        kind: "account",
        scope: { channelId: "line", accountId: "support" },
      },
    });
    expect(parsedConfig).toMatchObject({
      channels: {
        line: {
          accounts: {
            support: { allowFrom: ["Uexisting", "Unew"] },
          },
        },
      },
    });
  });

  it("adds a group allowlist entry under channels.line.groupAllowFrom", () => {
    const parsedConfig: Record<string, unknown> = {};
    const result = allowlist?.applyConfigEdit?.({
      cfg: {} as OpenClawConfig,
      parsedConfig,
      accountId: "default",
      scope: "group",
      action: "add",
      entry: "Uerin",
    });

    expect(result).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.line.groupAllowFrom",
      writeTarget: { kind: "channel", scope: { channelId: "line" } },
    });
    expect(parsedConfig).toMatchObject({ channels: { line: { groupAllowFrom: ["Uerin"] } } });
  });

  it("treats a line:-prefixed entry as already present via the line normalizer", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { line: { allowFrom: ["Ufrank"] } },
    };
    const result = allowlist?.applyConfigEdit?.({
      cfg: {} as OpenClawConfig,
      parsedConfig,
      accountId: "default",
      scope: "dm",
      action: "add",
      entry: "line:user:Ufrank",
    });

    expect(result).toMatchObject({ kind: "ok", changed: false });
    expect(parsedConfig).toMatchObject({ channels: { line: { allowFrom: ["Ufrank"] } } });
  });

  it("removes a dm allowlist entry and keeps the rest", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { line: { allowFrom: ["Ugone", "Ustay"] } },
    };
    const result = allowlist?.applyConfigEdit?.({
      cfg: {} as OpenClawConfig,
      parsedConfig,
      accountId: "default",
      scope: "dm",
      action: "remove",
      entry: "Ugone",
    });

    expect(result).toMatchObject({ kind: "ok", changed: true });
    expect(parsedConfig).toMatchObject({ channels: { line: { allowFrom: ["Ustay"] } } });
  });
});
