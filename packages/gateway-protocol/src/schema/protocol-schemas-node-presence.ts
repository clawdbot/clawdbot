import { NodePresenceActivityPayloadSchema, NodePresenceAliveReasonSchema } from "./nodes.js";

export const NodePresenceProtocolSchemas = {
  NodePresenceAliveReason: NodePresenceAliveReasonSchema,
  NodePresenceActivityPayload: NodePresenceActivityPayloadSchema,
};
