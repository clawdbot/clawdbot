import { describe, expect, it } from "vitest";
import {
  ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV,
  formatFutureConfigActionBlock,
  resolveFutureConfigActionBlock,
} from "./future-version-guard.js";
import type { ConfigFileSnapshot } from "./types.js";

function snapshotWithTouchedVersion(
  version: string,
): Pick<ConfigFileSnapshot, "config" | "sourceConfig"> {
  return {
    sourceConfig: { meta: { lastTouchedVersion: version } } as ConfigFileSnapshot["sourceConfig"],
    config: {} as ConfigFileSnapshot["config"],
  };
}

describe("resolveFutureConfigActionBlock", () => {
  it("blocks destructive actions from older binaries", () => {
    const block = resolveFutureConfigActionBlock({
      action: "restart the gateway service",
      currentVersion: "2026.4.5",
      snapshot: snapshotWithTouchedVersion("2026.4.23"),
      env: {},
    });

    expect(block?.message).toContain("Refusing to restart the gateway service");
    expect(block?.message).toContain("2026.4.5");
    expect(block?.message).toContain("2026.4.23");
    expect(formatFutureConfigActionBlock(block!)).toContain(
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
