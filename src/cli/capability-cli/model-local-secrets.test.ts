import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  resolveAgentDir: vi.fn((_cfg: OpenClawConfig, agentId: string) => `/tmp/agent-${agentId}`),
  getRuntimeConfigSourceSnapshot: vi.fn<() => OpenClawConfig | null>(() => null),
  getActiveSecretsRuntimeConfigSnapshot: vi.fn<() => OpenClawConfig | null>(() => null),
  prepareSecretsRuntimeSnapshot: vi.fn(async (_params: unknown) => ({ marker: "snapshot" })),
  activateSecretsRuntimeSnapshot: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfigSourceSnapshot: mocks.getRuntimeConfigSourceSnapshot,
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.getActiveSecretsRuntimeConfigSnapshot,
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: mocks.prepareSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshot: mocks.activateSecretsRuntimeSnapshot,
}));

import { prepareLocalModelRunAccountSecrets } from "./model-local-secrets.js";

describe("prepareLocalModelRunAccountSecrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(null);
    mocks.getActiveSecretsRuntimeConfigSnapshot.mockReturnValue(null);
  });

  it("prepares only the selected agent auth store and preserves the source config", async () => {
    const cfg: OpenClawConfig = { agents: { defaults: { workspace: "/tmp/workspace" } } };
    const sourceConfig: OpenClawConfig = { secrets: { providers: {} } };
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(sourceConfig);

    await prepareLocalModelRunAccountSecrets({ cfg, agentId: "ops" });

    expect(mocks.resolveAgentDir).toHaveBeenCalledWith(cfg, "ops");
    expect(mocks.prepareSecretsRuntimeSnapshot).toHaveBeenCalledWith({
      config: sourceConfig,
      assignmentConfig: cfg,
      agentDirs: ["/tmp/agent-ops"],
      includeConfigRefs: false,
    });
    expect(mocks.activateSecretsRuntimeSnapshot).toHaveBeenCalledWith({ marker: "snapshot" });
  });

  it("does not replace an already active secrets runtime snapshot", async () => {
    const cfg: OpenClawConfig = {};
    mocks.getActiveSecretsRuntimeConfigSnapshot.mockReturnValue({});

    await prepareLocalModelRunAccountSecrets({ cfg, agentId: "main" });

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.prepareSecretsRuntimeSnapshot).not.toHaveBeenCalled();
    expect(mocks.activateSecretsRuntimeSnapshot).not.toHaveBeenCalled();
  });
});
