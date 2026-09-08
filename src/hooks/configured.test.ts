// Configured hook tests cover the closed allowlist and open discovery decisions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInternalHookSelection } from "./configured.js";

const readConfigMachineStateMock = vi.hoisted(() => vi.fn());

vi.mock("../state/config-machine-state.js", () => ({
  readConfigMachineState: readConfigMachineStateMock,
}));

describe("resolveInternalHookSelection", () => {
  beforeEach(() => {
    readConfigMachineStateMock.mockReset();
    readConfigMachineStateMock.mockReturnValue(undefined);
  });

  it.each([
    [{}, false],
    [{ hooks: { internal: { entries: { selected: { enabled: true } } } } }, true],
    [{ hooks: { internal: { entries: { selected: { enabled: false } } } } }, false],
    [{ hooks: { internal: { load: { extraDirs: ["/tmp/hooks"] } } } }, true],
  ] satisfies Array<[OpenClawConfig, boolean]>)(
    "reports whether %j selects discovery",
    (config, configured) => {
      expect(resolveInternalHookSelection(config).configured).toBe(configured);
    },
  );

  it("retains explicit and installed names while extra roots keep discovery open", () => {
    readConfigMachineStateMock.mockReturnValue({ pack: { source: "path", hooks: ["installed"] } });
    expect(
      resolveInternalHookSelection({
        hooks: {
          internal: {
            entries: { disabled: { enabled: false } },
            load: { extraDirs: ["/tmp/hooks"] },
          },
        },
      }),
    ).toEqual({ configured: true, names: null, declaredNames: new Set(["disabled", "installed"]) });
  });

  it("keeps CLI-shaped named entries closed when the master flag is enabled", () => {
    expect(
      resolveInternalHookSelection({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              enabled: { enabled: true },
              disabled: { enabled: false },
            },
          },
        },
      }).names,
    ).toEqual(new Set(["enabled"]));

    expect(
      resolveInternalHookSelection({
        hooks: {
          internal: {
            enabled: true,
            entries: { disabled: { enabled: false } },
          },
        },
      }).names,
    ).toEqual(new Set());
  });

  it("keeps a bare master enable open for broad discovery", () => {
    expect(
      resolveInternalHookSelection({
        hooks: { internal: { enabled: true } },
      }).names,
    ).toBeNull();
  });

  it("keeps extra directories open-ended even with named entries", () => {
    expect(
      resolveInternalHookSelection({
        hooks: {
          internal: {
            enabled: true,
            entries: { named: { enabled: true } },
            load: { extraDirs: ["/opt/openclaw/hooks"] },
          },
        },
      }).names,
    ).toBeNull();
  });

  it("uses declared install hook names as an allowlist", () => {
    readConfigMachineStateMock.mockReturnValue({
      pack: { source: "path", hooks: ["installed-one", "installed-two"] },
    });

    expect(resolveInternalHookSelection({}).names).toEqual(
      new Set(["installed-one", "installed-two"]),
    );
  });

  it("keeps installs with unknown dynamic hook names open-ended", () => {
    readConfigMachineStateMock.mockReturnValue({ pack: { source: "path" } });

    expect(resolveInternalHookSelection({}).names).toBeNull();
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

    expect(resolveInternalHookSelection(config).names).toEqual(new Set());
  });
});
