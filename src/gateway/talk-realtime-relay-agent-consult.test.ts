import { expect, it, vi } from "vitest";
import type { RealtimeVoiceAgentConsultRunner } from "../talk/provider-types.js";
import { bindTalkRealtimeRelayAgentConsult } from "./talk-realtime-relay-agent-consult.js";

it("rejects a late relay startup-failure claim while consuming the retained owner", () => {
  const adoptCompletionClaims = vi.fn();
  const claimFailureAppend = vi.fn(() => true);
  const runPrompt = Object.assign(
    vi.fn<RealtimeVoiceAgentConsultRunner>(async () => ({ text: "done" })),
    {
      adoptCompletionClaims,
      claimAppend: vi.fn(() => true),
      claimFailureAppend,
    },
  );
  let current = true;
  const runAgentConsult = bindTalkRealtimeRelayAgentConsult(runPrompt as never, () => current);
  (
    runAgentConsult as RealtimeVoiceAgentConsultRunner & {
      adoptCompletionClaims?: () => void;
    }
  ).adoptCompletionClaims?.();
  expect(adoptCompletionClaims).toHaveBeenCalledOnce();
  current = false;

  expect(
    (
      runAgentConsult as RealtimeVoiceAgentConsultRunner & {
        claimFailureAppend?: () => boolean;
      }
    ).claimFailureAppend?.(),
  ).toBe(false);
  expect(claimFailureAppend).toHaveBeenCalledOnce();
});
