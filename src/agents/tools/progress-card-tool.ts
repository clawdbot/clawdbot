import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  ProgressCardStepSchema,
  type ProgressCardPutResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeProgressCardInput,
  PROGRESS_CARD_MAX_STEPS,
  ProgressCardInputError,
} from "../../session-cards/progress-card-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

const ProgressCardToolSchema = Type.Object(
  {
    markdown: Type.Optional(Type.String()),
    plan: Type.Optional(Type.Array(ProgressCardStepSchema, { maxItems: PROGRESS_CARD_MAX_STEPS })),
  },
  { additionalProperties: false },
);

type ProgressCardToolOptions = {
  agentSessionKey?: string;
  callGateway?: InProcessGatewayCaller;
};

export function createProgressCardTool(options: ProgressCardToolOptions = {}): AnyAgentTool {
  const gatewayCall = options.callGateway ?? callInProcessGatewayTool;
  return {
    name: "progress_card",
    label: "Progress Card",
    description:
      'Maintain this session\'s progress card: the single durable status surface shown next to the session in OpenClaw\'s UIs, for someone who is not reading the transcript. Keep it current on any task that takes more than a moment — it is how the user watches you work without scrolling. Each call replaces the whole card. Pick the representation that fits the work, using either or both parts: `markdown` — a compact note; tables for comparisons or metrics, <progress value="3" max="7"></progress> bars for one long operation, a bold one-liner for simple state; other raw HTML is stripped. And `plan` — an ordered step checklist (pending | in_progress | completed, at most one in_progress) for genuinely sequential work. The checklist is optional: omit it whenever a table, bar, or sentence says it better, and never repeat the same facts in both parts. Call with both parts empty to clear. Update on meaningful change — a step done, a blocker, results in — not every message. Max 8 KB markdown, 50 steps.',
    parameters: ProgressCardToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const sessionKey = options.agentSessionKey?.trim();
      if (!sessionKey) {
        throw new ToolInputError("progress_card requires an agent session");
      }
      let input;
      try {
        const params = asOptionalObjectRecord(rawArgs);
        input = normalizeProgressCardInput({
          markdown: params?.markdown,
          plan: params?.plan,
        });
      } catch (error) {
        if (error instanceof ProgressCardInputError) {
          throw new ToolInputError(error.message);
        }
        throw error;
      }
      const result = await gatewayCall<ProgressCardPutResult>("progressCard.put", {
        sessionKey,
        ...(input.markdown ? { markdown: input.markdown } : {}),
        ...(input.steps ? { plan: input.steps } : {}),
      });
      const completed =
        result.card?.steps?.filter((step) => step.status === "completed").length ?? 0;
      const total = result.card?.steps?.length ?? 0;
      const payload = {
        revision: result.card?.revision ?? null,
        steps: total > 0 ? { completed, total } : null,
      };
      const json = jsonResult(payload);
      return {
        ...json,
        content: [
          {
            type: "text",
            text: !result.card
              ? "Progress card cleared"
              : total > 0
                ? `Progress card updated (rev ${result.card.revision}, ${completed}/${total} done)`
                : `Progress card updated (rev ${result.card.revision})`,
          },
          ...json.content,
        ],
      };
    },
  };
}
