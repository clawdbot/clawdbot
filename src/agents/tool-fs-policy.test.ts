import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEffectiveToolFsRootExpansionAllowed,
  resolveEffectiveToolFsWorkspaceOnly,
} from "./tool-fs-policy.js";

describe("resolveEffectiveToolFsWorkspaceOnly", () => {
  it("returns false by default when tools.fs.workspaceOnly is unset", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: {}, agentId: "main" })).toBe(false);
  });

  it("uses global tools.fs.workspaceOnly when no agent override exists", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override over global setting", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(false);
  });

  it("supports agent-specific enablement when global workspaceOnly is off", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });
});

describe("resolveEffectiveToolFsRootExpansionAllowed", () => {
  it("allows root expansion by default when no restrictive profile is configured", () => {
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg: {}, agentId: "main" })).toBe(true);
  });

  it("disables root expansion for messaging profile agents without filesystem opt-in", () => {
    const cfg: OpenClawConfig = {
      tools: { profile: "messaging" },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(false);
  });

  it("does not re-enable root expansion from tools.fs alone under messaging profile (#47487)", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: false },
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(false);
  });

  it("does not treat an explicit tools.fs block as a filesystem opt-in (#47487)", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: {},
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(false);
  });

  it("re-enables root expansion when alsoAllow explicitly includes read (#47487)", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        alsoAllow: ["read"],
        fs: { workspaceOnly: false },
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(true);
  });

  it("keeps root expansion disabled when tools.fs only restricts access to the workspace", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: true },
      },
    };
    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "main" })).toBe(false);
  });

  it("prefers agent profile overrides over the global profile in both directions", () => {
    const cfg: OpenClawConfig = {
      tools: { profile: "messaging" },
      agents: {
        list: [
          { id: "coder", tools: { profile: "coding" } },
          { id: "messenger", tools: { profile: "messaging" } },
        ],
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "coder" })).toBe(true);

    const invertedCfg: OpenClawConfig = {
      tools: { profile: "coding" },
      agents: {
        list: [{ id: "messenger", tools: { profile: "messaging" } }],
      },
    };

    expect(
      resolveEffectiveToolFsRootExpansionAllowed({ cfg: invertedCfg, agentId: "messenger" }),
    ).toBe(false);
  });

  it("uses agent alsoAllow in place of global alsoAllow when resolving expansion", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        alsoAllow: ["read"],
      },
      agents: {
        list: [
          {
            id: "messenger",
            tools: {
              alsoAllow: ["message"],
            },
          },
        ],
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "messenger" })).toBe(false);
  });

  it("honors agent workspaceOnly overrides over global fs opt-in", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "messaging",
        fs: { workspaceOnly: false },
      },
      agents: {
        list: [
          {
            id: "messenger",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    };

    expect(resolveEffectiveToolFsRootExpansionAllowed({ cfg, agentId: "messenger" })).toBe(false);
  });
});
