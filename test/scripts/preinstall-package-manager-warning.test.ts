import { describe, expect, it, vi } from "vitest";
import {
  createPackageManagerWarningMessage,
  detectLifecyclePackageManager,
  warnIfNonPnpmLifecycle,
} from "../../scripts/preinstall-package-manager-warning.mjs";

function requireFirstWarning(warn: ReturnType<typeof vi.fn>): unknown {
  const [message] = warn.mock.calls[0] ?? [];
  if (message === undefined) {
    throw new Error("expected package manager warning");
  }
  return message;
}

describe("detectLifecyclePackageManager", () => {
  it("prefers npm_config_user_agent when present", () => {
    expect(
      detectLifecyclePackageManager({
        npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
      }),
    ).toBe("npm");
  });

  it("falls back to npm_execpath when user agent is missing", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/Users/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
      }),
    ).toBe("pnpm");
  });

  it("ignores untrusted user-agent tokens with control characters", () => {
    expect(
      detectLifecyclePackageManager({
        npm_config_user_agent: "\u001bnpm/11.4.1 node/v22.20.0 darwin arm64",
        npm_execpath: "/Users/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
      }),
    ).toBe("pnpm");
  });
});

describe("createPackageManagerWarningMessage", () => {
  it("returns null for pnpm", () => {
    expect(createPackageManagerWarningMessage("pnpm")).toBeNull();
  });

  it("warns for npm installs", () => {
    expect(createPackageManagerWarningMessage("npm")).toContain("prefer: corepack pnpm install");
  });
});

describe("warnIfNonPnpmLifecycle", () => {
  it("warns once for npm lifecycle runs", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
        },
        warn,
      ),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(requireFirstWarning(warn)).toContain("detected npm");
  });

  it("stays quiet for pnpm", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "pnpm/10.32.1 npm/? node/v22.20.0 darwin arm64",
        },
        warn,
      ),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
