import {
  validateUpdateHoldParams,
  validateUpdateHoldResult,
  validateUpdateRunsGetParams,
  validateUpdateRunsListParams,
  validateUpdateStatusParams,
  validateUpdateStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { gatewayUpdateCampaign } from "../../infra/update-campaign.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import {
  findActiveUpdateRun,
  getUpdateRun,
  listUpdateRuns,
} from "../../infra/update-run-ledger.js";
import {
  getUpdateAvailable,
  getUpdateEffectiveChannel,
  getUpdateSchedule,
  refreshGatewayUpdateStatus,
} from "../../infra/update-startup.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import {
  getLatestUpdateRestartSentinel,
  refreshLatestUpdateRestartSentinel,
} from "../server-restart-sentinel.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const updateStatusHandlers: GatewayRequestHandlers = {
  "update.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateUpdateStatusParams, "update.status", respond)) {
      return;
    }
    let sentinel: RestartSentinelPayload | null;
    try {
      sentinel = await refreshLatestUpdateRestartSentinel();
    } catch (err) {
      context?.logGateway?.warn(
        `update.status sentinel refresh failed: ${formatErrorMessage(err)}`,
      );
      sentinel = getLatestUpdateRestartSentinel();
    }
    const config = context?.getRuntimeConfig?.();
    const configChannel = normalizeUpdateChannel(config?.update?.channel);
    if (params.refreshCheckout === true && config) {
      try {
        await refreshGatewayUpdateStatus(config);
      } catch (err) {
        context?.logGateway?.warn(
          `update.status checkout refresh failed: ${formatErrorMessage(err)}`,
        );
      }
    }
    const schedule = getUpdateSchedule();
    let effectiveChannel = configChannel ?? normalizeUpdateChannel(schedule?.channel);
    if (!effectiveChannel) {
      try {
        effectiveChannel = await getUpdateEffectiveChannel();
      } catch (err) {
        context?.logGateway?.warn(
          `update.status install identity failed: ${formatErrorMessage(err)}`,
        );
      }
    }
    const activeRun = findActiveUpdateRun();
    const [lastRun] = listUpdateRuns({ limit: 1 });
    const result = {
      sentinel,
      ...(activeRun ? { activeRun } : {}),
      ...(lastRun ? { lastRun } : {}),
      updateAvailable: getUpdateAvailable(),
      ...(effectiveChannel ? { effectiveChannel } : {}),
      ...(schedule ? { schedule } : {}),
    };
    if (!validateUpdateStatusResult(result)) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "update status is temporarily unavailable",
      });
      return;
    }
    respond(true, result);
  },
  "update.hold": ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateUpdateHoldParams, "update.hold", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const campaignBeforeHold = gatewayUpdateCampaign.getState();
    const ok = gatewayUpdateCampaign.hold();
    const schedule = getUpdateSchedule();
    if (ok) {
      const heldCampaign = gatewayUpdateCampaign.getState();
      context?.logGateway?.info(
        `update.hold granted ${formatControlPlaneActor(actor)} holdUntilMs=${heldCampaign?.holdUntilMs} forceAtMs=${heldCampaign?.forceAtMs}`,
      );
    } else {
      const reason = !campaignBeforeHold
        ? "no campaign"
        : campaignBeforeHold.state === "applying"
          ? "applying"
          : "already held";
      context?.logGateway?.info(`update.hold refused ${formatControlPlaneActor(actor)}`, {
        reason,
      });
    }
    const result = {
      ok,
      ...(schedule ? { schedule } : {}),
    };
    if (!validateUpdateHoldResult(result)) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "update hold status is temporarily unavailable",
      });
      return;
    }
    respond(true, result);
  },
  "update.runs.get": ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateRunsGetParams, "update.runs.get", respond)) {
      return;
    }
    respond(true, { run: getUpdateRun(params.runId) ?? null });
  },
  "update.runs.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateRunsListParams, "update.runs.list", respond)) {
      return;
    }
    respond(true, { runs: listUpdateRuns(params) });
  },
};
