// Sessions gateway methods are grouped by lifecycle responsibility so the
// public registration remains small while each owner module stays reviewable.
import { sessionAbortHandlers } from "./sessions-abort.js";
import { sessionCompactHandlers } from "./sessions-compact.js";
import { sessionCheckpointHandlers } from "./sessions-compaction-checkpoints.js";
import { sessionCheckpointQueryHandlers } from "./sessions-compaction-queries.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import { sessionGroupHandlers } from "./sessions-groups.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { sessionReadHandlers } from "./sessions-read.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { GatewayRequestHandlers } from "./types.js";

export const sessionsHandlers: GatewayRequestHandlers = {
  ...sessionReadHandlers,
  ...sessionSubscriptionHandlers,
  ...sessionCreateHandlers,
  ...sessionCheckpointQueryHandlers,
  ...sessionCheckpointHandlers,
  ...sessionDispatchHandlers,
  ...sessionMessagingHandlers,
  ...sessionAbortHandlers,
  ...sessionMutationHandlers,
  ...sessionDeleteHandlers,
  ...sessionGroupHandlers,
  ...sessionCompactHandlers,
};
