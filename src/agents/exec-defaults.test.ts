import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import * as execApprovals from "../infra/exec-approvals.js";
import { canExecRequestNode, resolveExecDefaults } from "./exec-defaults.js";

describe("resolveExecDefaults", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({
      version: 1,
      agents: {},
    });
  });

  it("does not advertise node routing when exec host is pinned to gateway", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "gateway",
            },
          },
        },
        sandboxAvailable: false,
      }).canRequestNode,
    ).toBe(false);
  });

  it("does not advertise node routing when exec host is auto and sandbox is available", () => {
    const defaults = resolveExecDefaults({
      cfg: {
        tools: {
          exec: {
            host: "auto",
          },
        },
      },
      sandboxAvailable: true,
    });

    expect(defaults.host).toBe("auto");
    expect(defaults.effectiveHost).toBe("sandbox");
    expect(defaults.canRequestNode).toBe(false);
  });

  it("keeps node routing available when exec host is auto without sandbox", () => {
    const defaults = resolveExecDefaults({
      cfg: {
        tools: {
          exec: {
            host: "auto",
          },
        },
      },
      sandboxAvailable: false,
    });

    expect(defaults.host).toBe("auto");
    expect(defaults.effectiveHost).toBe("gateway");
    expect(defaults.canRequestNode).toBe(true);
  });

  it("honors session-level exec host overrides", () => {
    const sessionEntry = {
      execHost: "node",
    } as SessionEntry;
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              host: "gateway",
            },
          },
        },
        sessionEntry,
        sandboxAvailable: false,
      }).canRequestNode,
    ).toBe(true);
  });

  it("uses host approval defaults for gateway when exec policy is unset", () => {
    const defaults = resolveExecDefaults({
      cfg: {
        tools: {
          exec: {
            host: "auto",
          },
        },
      },
      sandboxAvailable: false,
    });

    expect(defaults.host).toBe("auto");
    expect(defaults.effectiveHost).toBe("gateway");
    expect(defaults.security).toBe("full");
    expect(defaults.ask).toBe("off");
  });

  it("keeps sandbox deny by default when auto resolves to sandbox", () => {
    const defaults = resolveExecDefaults({
      cfg: {
        tools: {
          exec: {
            host: "auto",
          },
        },
      },
      sandboxAvailable: true,
    });

    expect(defaults.host).toBe("auto");
    expect(defaults.effectiveHost).toBe("sandbox");
    expect(defaults.security).toBe("deny");
    expect(defaults.ask).toBe("off");
  });

  it("blocks node advertising in helper calls when sandbox is available", () => {
    expect(
      canExecRequestNode({
        cfg: {
          tools: {
            exec: {
              host: "auto",
            },
          },
        },
        sandboxAvailable: true,
      }),
    ).toBe(false);
  });
});
