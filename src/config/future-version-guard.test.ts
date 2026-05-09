import { describe, expect, it } from "vitest";
import {
  ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV,
  formatFutureConfigActionBlock,
  resolveFutureConfigActionBlock,
} from "./future-version-guard.js";
import type { FutureConfigActionBlock } from "./future-version-guard.js";
import type { ConfigFileSnapshot } from "./types.js";

function snapshotWithTouchedVersion(
  version: string,
): Pick<ConfigFileSnapshot, "config" | "sourceConfig"> {
  return {
    sourceConfig: { meta: { lastTouchedVersion: version } } as ConfigFileSnapshot["sourceConfig"],
    config: {} as ConfigFileSnapshot["config"],
  };
}

function expectFutureActionBlock(block: FutureConfigActionBlock | null): FutureConfigActionBlock {
  if (block === null) {
    throw new Error("Expected destructive action to be blocked by future config version");
  }
  return block;
}

describe("resolveFutureConfigActionBlock", () => {
  it("blocks destructive actions from older binaries", () => {
    const block = resolveFutureConfigActionBlock({
      action: "restart the gateway service",
      currentVersion: "2026.4.5",
      snapshot: snapshotWithTouchedVersion("2026.4.23"),
      env: {},
    });

    const actionBlock = expectFutureActionBlock(block);
    expect(actionBlock.message).toContain("Refusing to restart the gateway service");
    expect(actionBlock.message).toContain("2026.4.5");
    expect(actionBlock.message).toContain("2026.4.23");
    expect(formatFutureConfigActionBlock(actionBlock)).toContain(
      ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV,
    );
  });

  it("allows same stable family and older configs", () => {
    expect(
      resolveFutureConfigActionBlock({
        action: "restart the gateway service",
        currentVersion: "2026.4.23",
        snapshot: snapshotWithTouchedVersion("2026.4.23"),
        env: {},
      }),
    ).toBeNull();
    expect(
      resolveFutureConfigActionBlock({
        action: "restart the gateway service",
        currentVersion: "2026.4.23",
        snapshot: snapshotWithTouchedVersion("2026.4.5"),
        env: {},
      }),
    ).toBeNull();
  });

  it("allows beta binaries to refresh services written by the same stable release", () => {
    expect(
      resolveFutureConfigActionBlock({
        action: "install or rewrite the gateway service",
        currentVersion: "2026.5.2-beta.3",
        snapshot: snapshotWithTouchedVersion("2026.5.2"),
        env: {},
      }),
    ).toBeNull();
  });

  it("allows intentional downgrade override through env", () => {
    expect(
      resolveFutureConfigActionBlock({
        action: "restart the gateway service",
        currentVersion: "2026.4.5",
        snapshot: snapshotWithTouchedVersion("2026.4.23"),
        env: { [ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]: "1" },
      }),
    ).toBeNull();
  });
});
