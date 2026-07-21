import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DefaultInferenceRouteProjection } from "./inference-route.js";

const mocks = vi.hoisted(() => ({ copyPortableAuthProfiles: vi.fn() }));

vi.mock("../agents/auth-profiles/copy-portable.js", () => ({
  copyPortableAuthProfiles: mocks.copyPortableAuthProfiles,
}));

const { prepareFirstAgentCredentialDir, resolveVerifiedFirstAgentDir } =
  await import("./setup-first-agent.js");

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
