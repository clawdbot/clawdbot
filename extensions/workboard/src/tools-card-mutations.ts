import {
  WORKBOARD_STATUSES,
  type WorkboardCard,
  type WorkboardCardView,
} from "@openclaw/workboard-contract";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { AgentToolResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { WorkboardMutationScope } from "./store-inputs.js";
import type { WorkboardStore } from "./store.js";

type ScopedMoveParams = {
  record: Record<string, unknown>;
  id: string;
  scope: WorkboardMutationScope;
};

const ClaimTokenFieldName = "token" as const;

export function cardIdField() {
  return Type.String({ description: "Workboard card id." });
}

export function claimTokenField(description = "Claim token returned by workboard_claim.") {
  return Type.Optional(Type.String({ description }));
}

export function createWorkboardMoveTool(params: {
  store: WorkboardStore;
  readScopedCardToolParams: (rawParams: unknown) => Promise<ScopedMoveParams>;
  redactedCardResult: (card: WorkboardCard) => AgentToolResult<{ card: WorkboardCardView }>;
}): AnyAgentTool {
  return {
    name: "workboard_move",
    label: "Workboard Move",
    description:
      "Move a Workboard card to another status. Claimed cards require matching claim scope.",
    parameters: Type.Object(
      {
        id: cardIdField(),
        status: Type.Union(
          WORKBOARD_STATUSES.map((status) => Type.Literal(status)),
          { description: "Target Workboard status." },
        ),
        [ClaimTokenFieldName]: claimTokenField("Claim token for claimed cards."),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams) => {
      const { record, id, scope } = await params.readScopedCardToolParams(rawParams);
      return params.redactedCardResult(
        await params.store.move(id, record.status, undefined, scope),
      );
    },
  };
}
