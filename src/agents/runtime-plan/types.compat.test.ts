import { describe, expectTypeOf, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { FailoverReason } from "../pi-embedded-helpers/types.js";
import type { PromptMode } from "../system-prompt.types.js";
import type { buildAgentRuntimeDeliveryPlan, buildAgentRuntimePlan } from "./build.js";
import type {
  AgentRuntimeFailoverReason,
  AgentRuntimePromptMode,
  AgentRuntimeReplyPayload,
  AgentRuntimeThinkLevel,
  BuildAgentRuntimeDeliveryPlanParams,
  BuildAgentRuntimePlanParams,
} from "./types.js";

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;

type Assert<T extends true> = T;

describe("AgentRuntimePlan structural type compatibility", () => {
  it("keeps copied scalar unions aligned with their source contracts", () => {
    expectTypeOf<AgentRuntimeThinkLevel>().toEqualTypeOf<ThinkLevel>();
    expectTypeOf<AgentRuntimeFailoverReason>().toEqualTypeOf<FailoverReason>();
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
