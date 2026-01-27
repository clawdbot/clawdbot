import { resolveMoltbotPackageRoot } from "../../infra/moltbot-root.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateUpdateRunParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const updateHandlers: GatewayRequestHandlers = {
  "update.run": async ({ params, respond }) => {
    if (!validateUpdateRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid update.run params: ${formatValidationErrors(validateUpdateRunParams.errors)}`,
        ),
      );
      return;
    }
    const sessionKey =
      typeof (params as { sessionKey?: unknown }).sessionKey === "string"
        ? (params as { sessionKey?: string }).sessionKey?.trim() || undefined
        : undefined;
    const note =
      typeof (params as { note?: unknown }).note === "string"
        ? (params as { note?: string }).note?.trim() || undefined
        : undefined;
    const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
    const restartDelayMs =
      typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
        ? Math.max(0, Math.floor(restartDelayMsRaw))
        : undefined;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.floor(timeoutMsRaw))
        : undefined;

    let result: Awaited<ReturnType<typeof runGatewayUpdate>>;
    try {
      const root =
        (await resolveMoltbotPackageRoot({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        })) ?? process.cwd();
      result = await runGatewayUpdate({
        timeoutMs,
        cwd: root,
        argv1: process.argv[1],
      });
    } catch (err) {
      result = {
        status: "error",
        mode: "unknown",
        reason: String(err),
        steps: [],
        durationMs: 0,
      };
    }

    const payload: RestartSentinelPayload = {
      kind: "update",
      status: result.status,
      ts: Date.now(),
      sessionKey,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: result.mode,
        root: result.root ?? undefined,
        before: result.before ?? null,
        after: result.after ?? null,
        steps: result.steps.map((step) => ({
          name: step.name,
          command: step.command,
          cwd: step.cwd,
          durationMs: step.durationMs,
          log: {
            stdoutTail: step.stdoutTail ?? null,
            stderrTail: step.stderrTail ?? null,
            exitCode: step.exitCode ?? null,
          },
        })),
        reason: result.reason ?? null,
        durationMs: result.durationMs,
      },
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    const restart = scheduleGatewaySigusr1Restart({
      delayMs: restartDelayMs,
      reason: "update.run",
    });

    respond(
      true,
      {
        ok: true,
        result,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
