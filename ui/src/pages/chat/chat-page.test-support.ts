import { onTestFinished } from "vitest";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";

export function createChatPageSessions(
  gateway: Parameters<typeof createTestSessionCapability>[0] = {
    snapshot: { client: null, phase: "stopped", hello: null },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  },
) {
  const sessions = createTestSessionCapability(gateway);
  onTestFinished(() => sessions.dispose());
  return sessions;
}
