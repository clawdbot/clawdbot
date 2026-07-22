import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DefaultInferenceRouteProjection } from "./inference-route.js";

const mocks = vi.hoisted(() => ({
  copyPortableAuthProfiles: vi.fn(),
  verifySetupInferenceConfig: vi.fn(),
}));

vi.mock("../agents/auth-profiles/copy-portable.js", () => ({
  copyPortableAuthProfiles: mocks.copyPortableAuthProfiles,
}));

vi.mock("./setup-inference.js", () => ({
  verifySetupInferenceConfig: mocks.verifySetupInferenceConfig,
}));

const {
  prepareAndVerifyFirstAgentCredentialDir,
  prepareFirstAgentCredentialDir,
  resolveVerifiedFirstAgentDir,
} = await import("./setup-first-agent.js");

it("keeps renamed and later literal-main agent directories distinct", async () => {
  const stateDir = "/tmp/openclaw-setup-agent-dirs";
  const researchDir = path.join(stateDir, "agents", "research-buddy", "agent");
  const config = {
    agents: {
      list: [{ id: "research-buddy", default: true, agentDir: researchDir }],
    },
  } satisfies OpenClawConfig;
  const mainDir = path.join(stateDir, "agents", "main", "agent");
  const verifiedRoute = {
    route: { agentId: "main", agentDir: mainDir },
  } as unknown as DefaultInferenceRouteProjection;

  expect(
    resolveVerifiedFirstAgentDir({ agentId: "research-buddy", verifiedRoute }),
  ).toBeUndefined();
  await expect(
    prepareFirstAgentCredentialDir({
      agentId: "research-buddy",
      config,
      verifiedAgentDir: mainDir,
    }),
  ).resolves.toBe(researchDir);
  expect(mocks.copyPortableAuthProfiles).toHaveBeenCalledWith({
    sourceAgentDir: mainDir,
    destAgentDir: researchDir,
  });
  expect(resolveAgentDir(config, "main", { OPENCLAW_STATE_DIR: stateDir })).not.toBe(researchDir);
});

it("verifies inference against the staged roster after credential relocation", async () => {
  const config = {
    agents: {
      defaults: { model: "openai/gpt-5.5" },
      list: [{ id: "research-buddy", default: true, agentDir: "/agents/research-buddy" }],
    },
  } satisfies OpenClawConfig;
  mocks.verifySetupInferenceConfig.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 1,
  });

  await expect(
    prepareAndVerifyFirstAgentCredentialDir({
      agentId: "research-buddy",
      config,
      expectedRoute: {
        route: { modelLabel: "openai/gpt-5.5" },
      } as DefaultInferenceRouteProjection,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      verifiedAgentDir: "/agents/main",
    }),
  ).resolves.toBe("/agents/research-buddy");
  expect(mocks.verifySetupInferenceConfig).toHaveBeenCalledWith({
    config,
    runtime: expect.any(Object),
  });
});
