import { onTestFinished } from "vitest";
import { createSessionCapability } from "../../lib/sessions/index.ts";

export function createChatPageSessions(
  gateway: Parameters<typeof createSessionCapability>[0] = {
    snapshot: { client: null, phase: "stopped", hello: null },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  },
) {
  const sessions = createSessionCapability(gateway);
  onTestFinished(() => sessions.dispose());
  return sessions;
}
