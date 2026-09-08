import type { ApplicationContext } from "../../app/context.ts";
import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

type SnapshotKeyHost = {
  assistantAgentId: ApplicationContext["gateway"]["snapshot"]["assistantAgentId"];
  agentsList: ApplicationContext["agents"]["state"]["agentsList"];
  hello: ApplicationContext["gateway"]["snapshot"]["hello"];
};

const loadSnapshotInvalidation = () => import("./session-snapshot-invalidation.ts");

export function clearStoredChatSnapshots(): Promise<void> {
  const invalidated = publishSnapshotInvalidation({});
  return loadSnapshotInvalidation().then(async ({ clearStoredChatSnapshotStorage }) => {
    await invalidated;
    await clearStoredChatSnapshotStorage();
  });
}

export function deleteStoredChatSessionSnapshots(
  host: SnapshotKeyHost,
  sessions: readonly Pick<SessionDeleteTarget, "agentId" | "key">[],
): Promise<void> {
  return loadSnapshotInvalidation().then(({ deleteStoredChatSnapshot, resolveChatSnapshotKey }) =>
    Promise.all(
      sessions.map(({ key, agentId }) =>
        deleteStoredChatSnapshot(
          resolveChatSnapshotKey(
            { ...host, assistantAgentId: agentId ?? host.assistantAgentId },
            { sessionKey: key, agentId },
          ),
        ),
      ),
    ).then(() => undefined),
  );
}
