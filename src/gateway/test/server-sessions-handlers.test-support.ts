import { sessionAbortHandlers } from "../server-methods/sessions-abort.js";
import { sessionCompactHandlers } from "../server-methods/sessions-compact.js";
import { sessionCheckpointHandlers } from "../server-methods/sessions-compaction-checkpoints.js";
import { sessionCheckpointQueryHandlers } from "../server-methods/sessions-compaction-queries.js";
import { sessionCreateHandlers } from "../server-methods/sessions-create.js";
import { sessionDeleteHandlers } from "../server-methods/sessions-delete.js";
import { sessionDispatchHandlers } from "../server-methods/sessions-dispatch.js";
import { sessionGroupHandlers } from "../server-methods/sessions-groups.js";
import { sessionMessagingHandlers } from "../server-methods/sessions-messaging.js";
import { sessionMutationHandlers } from "../server-methods/sessions-mutations.js";
import { sessionReadHandlers } from "../server-methods/sessions-read.js";
import { sessionRewindHandlers } from "../server-methods/sessions-rewind.js";
import { sessionSharingHandlers } from "../server-methods/sessions-sharing.js";
import { sessionSubscriptionHandlers } from "../server-methods/sessions-subscriptions.js";
import { sessionSuggestionHandlers } from "../server-methods/sessions-suggestions.js";
import type { GatewayRequestHandlers } from "../server-methods/types.js";

export const sessionHandlerTestSurface: GatewayRequestHandlers = {
  ...sessionReadHandlers,
  ...sessionSharingHandlers,
  ...sessionSuggestionHandlers,
  ...sessionSubscriptionHandlers,
  ...sessionCreateHandlers,
  ...sessionCheckpointQueryHandlers,
  ...sessionCheckpointHandlers,
  ...sessionRewindHandlers,
  ...sessionDispatchHandlers,
  ...sessionMessagingHandlers,
  ...sessionAbortHandlers,
  ...sessionMutationHandlers,
  ...sessionDeleteHandlers,
  ...sessionGroupHandlers,
  ...sessionCompactHandlers,
};
