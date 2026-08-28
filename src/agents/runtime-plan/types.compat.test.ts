// Runtime plan type-compat tests keep copied structural aliases aligned with
// their source runtime contracts without importing those sources in production.
import { describe, expectTypeOf, it } from "vitest";
import type { FailoverReason as ProtocolFailoverReason } from "../../../packages/gateway-protocol/src/failover-reasons.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { PromptMode } from "../system-prompt.types.js";
import type { buildAgentRuntimeDeliveryPlan, buildAgentRuntimePlan } from "./build.js";
import type {
  AgentRuntimePlan,
  BuildAgentRuntimeDeliveryPlanParams,
  BuildAgentRuntimePlanParams,
} from "./types.js";

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;

type Assert<T extends true> = T;

type AgentRuntimeFailoverReason = NonNullable<
  Extract<
    ReturnType<AgentRuntimePlan["outcome"]["classifyRunResult"]>,
    { message: string }
  >["reason"]
>;
type AgentRuntimePromptMode = Parameters<
  AgentRuntimePlan["prompt"]["resolveSystemPromptContribution"]
>[0]["promptMode"];
type AgentRuntimeReplyPayload = Parameters<
  AgentRuntimePlan["delivery"]["resolveFollowupRoute"]
>[0]["payload"];
type AgentRuntimeThinkLevel = NonNullable<BuildAgentRuntimePlanParams["thinkingLevel"]>;

describe("AgentRuntimePlan structural type compatibility", () => {
  it("keeps scalar unions and the failover projection aligned with their owners", () => {
    expectTypeOf<AgentRuntimeThinkLevel>().toEqualTypeOf<Exclude<ThinkLevel, "ultra">>();
    expectTypeOf<AgentRuntimeFailoverReason>().toEqualTypeOf<ProtocolFailoverReason>();
    expectTypeOf<AgentRuntimePromptMode>().toEqualTypeOf<PromptMode>();
  });

  it("keeps reply payload shapes structurally compatible with the runtime leaf payload shape", () => {
    type _ReplyPayloadKeysStayInSync = Assert<
      Equal<keyof ReplyPayload, keyof AgentRuntimeReplyPayload>
    >;
    expectTypeOf<ReplyPayload>().toMatchTypeOf<AgentRuntimeReplyPayload>();
    expectTypeOf<AgentRuntimeReplyPayload>().toMatchTypeOf<ReplyPayload>();
  });

  it("keeps builder call signatures aligned with exported structural params", () => {
    expectTypeOf<
      Parameters<typeof buildAgentRuntimeDeliveryPlan>[0]
    >().toEqualTypeOf<BuildAgentRuntimeDeliveryPlanParams>();
    expectTypeOf<
      Parameters<typeof buildAgentRuntimePlan>[0]
    >().toEqualTypeOf<BuildAgentRuntimePlanParams>();
  });
});
