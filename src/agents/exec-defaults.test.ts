// Verifies exec host, sandbox, and approval-default resolution for embedded agents.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import * as execApprovals from "../infra/exec-approvals.js";
import { resolveExecDefaults, resolveNodeExecEligibility } from "./exec-defaults.js";

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
    expect(defaults.mode).toBe("full");
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
    expect(defaults.mode).toBe("deny");
    expect(defaults.security).toBe("deny");
    expect(defaults.ask).toBe("off");
  });

  it("ignores host approval defaults when auto resolves to sandbox", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockReturnValue({
      version: 1,
      defaults: {
        security: "full",
        ask: "always",
      },
      agents: {},
    });

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

    // Sandbox mode is intentionally self-contained: gateway approval floors
    // must not leak into the local deny-by-default sandbox contract.
    expect(defaults.effectiveHost).toBe("sandbox");
    expect(defaults.security).toBe("deny");
    expect(defaults.ask).toBe("off");
    expect(execApprovals.loadExecApprovals).not.toHaveBeenCalled();
  });

  it("maps normalized auto mode to allowlist plus on-miss approvals", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        },
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
    });
  });

  it("reports host approval floors after normalized exec modes", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockReturnValue({
      version: 1,
      defaults: {
        security: "deny",
        ask: "off",
      },
      agents: {},
    });

    // Approval floors clamp normalized mode upward/downward after config mode
    // mapping so persisted host policy remains the final safety boundary.
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        },
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "deny",
      security: "deny",
      ask: "on-miss",
    });
  });

  it("reports agent-scoped host approval floors", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockReturnValue({
      version: 1,
      agents: {
        "agent-a": {
          security: "full",
          ask: "always",
        },
      },
    });

    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              mode: "full",
            },
          },
        },
        agentId: "agent-a",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "ask",
      security: "full",
      ask: "always",
    });
  });

  it("keeps agent mode overrides ahead of the global mode", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
          agents: {
            list: [
              {
                id: "agent-a",
                tools: {
                  exec: {
                    mode: "full",
                  },
                },
              },
            ],
          },
        },
        agentId: "agent-a",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "full",
      security: "full",
      ask: "off",
    });
  });

  it("derives security fields from an agent mode override", () => {
    expect(
      resolveExecDefaults({
        cfg: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
          agents: {
            list: [
              {
                id: "agent-a",
                tools: {
                  exec: {
                    mode: "allowlist",
                  },
                },
              },
            ],
          },
        },
        agentId: "agent-a",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "allowlist",
      security: "allowlist",
      ask: "off",
    });
  });

  it("blocks node skill eligibility for deny policy and preserves node bindings", () => {
    expect(
      resolveNodeExecEligibility({
        cfg: {
          tools: {
            exec: {
              host: "node",
              mode: "deny",
              node: "build-mac",
            },
          },
        },
      }),
    ).toEqual({ canExec: false, node: "build-mac" });
  });

  it("blocks node skill eligibility when the gateway denies system.run", () => {
    expect(
      resolveNodeExecEligibility({
        cfg: {
          gateway: { nodes: { commands: { deny: [" system.run "] } } },
          tools: { exec: { host: "node", mode: "full" } },
        },
      }),
    ).toEqual({ canExec: false });
  });
});
