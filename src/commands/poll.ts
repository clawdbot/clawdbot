import type { CliDeps } from "../cli/deps.js";
import { withProgress } from "../cli/progress.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { success } from "../globals.js";
import { buildOutboundResultEnvelope } from "../infra/outbound/envelope.js";
import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
} from "../infra/outbound/format.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import type { RuntimeEnv } from "../runtime.js";

function parseIntOption(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return parsed;
}

export async function pollCommand(
  opts: {
    to: string;
    question: string;
    option: string[];
    maxSelections?: string;
    durationHours?: string;
    provider?: string;
    json?: boolean;
    dryRun?: boolean;
  },
  _deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const provider = (opts.provider ?? "whatsapp").toLowerCase();
  if (provider !== "whatsapp" && provider !== "discord") {
    throw new Error(`Unsupported poll provider: ${provider}`);
  }

  const maxSelections = parseIntOption(opts.maxSelections, "max-selections");
  const durationHours = parseIntOption(opts.durationHours, "duration-hours");

  const pollInput: PollInput = {
    question: opts.question,
    options: opts.option,
    maxSelections,
    durationHours,
  };
  const maxOptions = provider === "discord" ? 10 : 12;
  const normalized = normalizePollInput(pollInput, { maxOptions });

  if (opts.dryRun) {
    runtime.log(
      `[dry-run] would send poll via ${provider} -> ${opts.to}:\n  Question: ${normalized.question}\n  Options: ${normalized.options.join(", ")}\n  Max selections: ${normalized.maxSelections}`,
    );
    return;
  }

  const result = await withProgress(
    {
      label: `Sending poll via ${provider}…`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway<{
        messageId: string;
        toJid?: string;
        channelId?: string;
      }>({
        method: "poll",
        params: {
          to: opts.to,
          question: normalized.question,
          options: normalized.options,
          maxSelections: normalized.maxSelections,
          durationHours: normalized.durationHours,
          provider,
          idempotencyKey: randomIdempotencyKey(),
        },
        timeoutMs: 10_000,
        clientName: "cli",
        mode: "cli",
      }),
  );

  runtime.log(
    success(
      formatGatewaySummary({
        action: "Poll sent",
        provider,
        messageId: result.messageId ?? null,
      }),
    ),
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ...buildOutboundResultEnvelope({
            delivery: buildOutboundDeliveryJson({
              provider,
              via: "gateway",
              to: opts.to,
              result,
              mediaUrl: null,
            }),
          }),
          question: normalized.question,
          options: normalized.options,
          maxSelections: normalized.maxSelections,
          durationHours: normalized.durationHours ?? null,
        },
        null,
        2,
      ),
    );
  }
}
