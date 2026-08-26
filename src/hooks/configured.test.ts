// Configured hook tests cover the closed allowlist and open discovery decisions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredInternalHookNames } from "./configured.js";

const readConfigMachineStateMock = vi.hoisted(() => vi.fn());

vi.mock("../state/config-machine-state.js", () => ({
  readConfigMachineState: readConfigMachineStateMock,
}));

describe("resolveConfiguredInternalHookNames", () => {
  beforeEach(() => {
    readConfigMachineStateMock.mockReset();
    readConfigMachineStateMock.mockReturnValue(undefined);
  });

  it("keeps CLI-shaped named entries closed when the master flag is enabled", () => {
    expect(
      resolveConfiguredInternalHookNames({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              enabled: { enabled: true },
              disabled: { enabled: false },
            },
          },
        },
      }),
    ).toEqual(new Set(["enabled"]));

    expect(
      resolveConfiguredInternalHookNames({
        hooks: {
          internal: {
            enabled: true,
            entries: { disabled: { enabled: false } },
          },
        },
      }),
    ).toEqual(new Set());
  });

  it("keeps a bare master enable open for broad discovery", () => {
    expect(
      resolveConfiguredInternalHookNames({
        hooks: { internal: { enabled: true } },
      }),
    ).toBeNull();
  });

  it("keeps extra directories open-ended even with named entries", () => {
    expect(
      resolveConfiguredInternalHookNames({
        hooks: {
          internal: {
            enabled: true,
            entries: { named: { enabled: true } },
            load: { extraDirs: ["/opt/openclaw/hooks"] },
          },
        },
      }),
    ).toBeNull();
  });

  it("uses declared install hook names as an allowlist", () => {
    readConfigMachineStateMock.mockReturnValue({
      pack: { source: "path", hooks: ["installed-one", "installed-two"] },
    });

    expect(resolveConfiguredInternalHookNames({})).toEqual(
      new Set(["installed-one", "installed-two"]),
    );
  });

  it("keeps installs with unknown dynamic hook names open-ended", () => {
    readConfigMachineStateMock.mockReturnValue({ pack: { source: "path" } });

    expect(resolveConfiguredInternalHookNames({})).toBeNull();
  });

  it("lets explicit disablement override every discovery surface", () => {
    readConfigMachineStateMock.mockReturnValue({ pack: { source: "path" } });
    const config = {
      hooks: {
        internal: {
          enabled: false,
          entries: { named: { enabled: true } },
          load: { extraDirs: ["/opt/openclaw/hooks"] },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveConfiguredInternalHookNames(config)).toEqual(new Set());
  });
});
