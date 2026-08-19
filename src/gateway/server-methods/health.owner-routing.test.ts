import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { healthHandlers } from "./health.js";

afterEach(() => {
  resetConfigRuntimeState();
});

async function callStatus(config: OpenClawConfig) {
  setRuntimeConfigSnapshot(config, config);
  const respond = vi.fn();
  await healthHandlers.status!({
    req: {} as never,
    params: { includeChannelSummary: false },
    respond: respond as never,
    context: {} as never,
    client: { connect: { role: "operator", scopes: ["operator.read"] } } as never,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("Gateway status owner routing", () => {
  it("uses the configured system owner without making public main aliases implicit", async () => {
    await withStateDirEnv("openclaw-gateway-status-owner-", async ({ stateDir }) => {
      const config = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, molty: {} },
        },
        session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
      } satisfies OpenClawConfig;

      const respond = await callStatus(config);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[2]).toBeUndefined();
      expect(resolveRequestedSessionAgentId(config, "main")).toMatchObject({ ok: false });
      expect(resolveRequestedSessionAgentId(config, "agent:molty:main")).toEqual({
        ok: true,
        agentId: "molty",
      });
    });
  });

  it("keeps single-agent status unchanged", async () => {
    await withStateDirEnv("openclaw-gateway-status-single-", async ({ stateDir }) => {
      const respond = await callStatus({
        agents: { entries: { main: {} } },
        session: { store: path.join(stateDir, "sessions.json") },
      });

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[2]).toBeUndefined();
    });
  });
});
