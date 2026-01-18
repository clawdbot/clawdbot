import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { loadConfig } from "../config/config.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "../infra/voicewake.js";
import {
  ErrorCodes,
  formatValidationErrors,
  validateModelsListParams,
  validateTalkModeParams,
} from "./protocol/index.js";
import type { BridgeMethodHandler } from "./server-bridge-types.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "./server-constants.js";
import { normalizeVoiceWakeTriggers } from "./server-utils.js";

export const handleSystemBridgeMethods: BridgeMethodHandler = async (
  ctx,
  _nodeId,
  method,
  params,
) => {
  switch (method) {
    case "voicewake.get": {
      const cfg = await loadVoiceWakeConfig();
      return {
        ok: true,
        payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
      };
    }
    case "voicewake.set": {
      const triggers = normalizeVoiceWakeTriggers(params.triggers);
      const cfg = await setVoiceWakeTriggers(triggers);
      ctx.broadcastVoiceWakeChanged(cfg.triggers);
      return {
        ok: true,
        payloadJSON: JSON.stringify({ triggers: cfg.triggers }),
      };
    }
    case "health": {
      const now = Date.now();
      const cached = ctx.getHealthCache();
      if (cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
        return { ok: true, payloadJSON: JSON.stringify(cached) };
      }
      const snap = await ctx.refreshHealthSnapshot({ probe: false });
      return { ok: true, payloadJSON: JSON.stringify(snap) };
    }
    case "talk.mode": {
      if (!validateTalkModeParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
          },
        };
      }
      const payload = {
        enabled: (params as { enabled: boolean }).enabled,
        phase: (params as { phase?: string }).phase ?? null,
        ts: Date.now(),
      };
      ctx.broadcast("talk.mode", payload, { dropIfSlow: true });
      return { ok: true, payloadJSON: JSON.stringify(payload) };
    }
    case "models.list": {
      if (!validateModelsListParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
          },
        };
      }
      const models = await ctx.loadGatewayModelCatalog();
      return { ok: true, payloadJSON: JSON.stringify({ models }) };
    }
    case "skills.bins": {
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      const report = buildWorkspaceSkillStatus(workspaceDir, {
        config: cfg,
        eligibility: { remote: getRemoteSkillEligibility() },
      });
      const bins = Array.from(
        new Set(
          report.skills.flatMap((skill) => skill.requirements?.bins ?? []).filter(Boolean),
        ),
      );
      return { ok: true, payloadJSON: JSON.stringify({ bins }) };
    }
    default:
      return null;
  }
};
