import { expect, it, vi } from "vitest";
import type { RealtimeVoiceAgentConsultRunner } from "../talk/provider-types.js";
import { bindTalkRealtimeRelayAgentConsult } from "./talk-realtime-relay-agent-consult.js";

it("rejects a late relay startup-failure claim while consuming the retained owner", () => {
  const claimFailureAppend = vi.fn(() => true);
  const runPrompt = Object.assign(
    vi.fn<RealtimeVoiceAgentConsultRunner>(async () => ({ text: "done" })),
    {
      claimAppend: vi.fn(() => true),
      claimFailureAppend,
    },
  );
  let current = true;
  const runAgentConsult = bindTalkRealtimeRelayAgentConsult(runPrompt as never, () => current);
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
