import { expectDefined } from "@openclaw/normalization-core";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { listSessionsFromStoreAsync } from "./session-utils-list.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

function fixtureOwner(cfg: OpenClawConfig, key: string, agentId?: string): string {
  const configured = listAgentIds(cfg);
  return expectDefined(
    parseAgentSessionKey(key)?.agentId ??
      agentId ??
      (key !== "global" && key !== "unknown" && configured.length === 1
        ? configured[0]
        : undefined),
    `fixture owner for ${key}`,
  );
}

export function buildSessionRowFixture(
  params: Omit<Parameters<typeof buildGatewaySessionRow>[0], "agentId"> & { agentId?: string },
) {
  return buildGatewaySessionRow({
    ...params,
    agentId: fixtureOwner(params.cfg, params.key, params.agentId),
  });
}

/** Synthetic stores have no loader; declare their unqualified row owner in the fixture. */
export function listSessionFixture(
  params: Omit<Parameters<typeof listSessionsFromStoreAsync>[0], "targetsBySessionKey"> & {
    fixtureAgentId?: string;
  },
) {
  const { fixtureAgentId, ...input } = params;
  const targetsBySessionKey = new Map(
    Object.keys(input.store).map((key) => {
      const agentId = fixtureOwner(input.cfg, key, input.opts.agentId ?? fixtureAgentId);
      return [key, { agentId, storeTarget: { agentId, storePath: input.storePath } }] as const;
    }),
  );
  return listSessionsFromStoreAsync({ ...input, targetsBySessionKey });
}
