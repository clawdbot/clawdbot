import {
  NodeInvokeInputEventSchema,
  NodeInvokeParamsSchema,
  NodeInvokeProgressParamsSchema,
  NodeInvokeRequestEventSchema,
  NodeInvokeResultParamsSchema,
} from "./nodes.js";

// Node invoke request/input/progress/result wire schemas, grouped like the
// sibling node-presence bundle so the main registry stays within its budget.
export const NodeInvokeProtocolSchemas = {
  NodeInvokeParams: NodeInvokeParamsSchema,
  NodeInvokeInputEvent: NodeInvokeInputEventSchema,
  NodeInvokeProgressParams: NodeInvokeProgressParamsSchema,
  NodeInvokeResultParams: NodeInvokeResultParamsSchema,
  NodeInvokeRequestEvent: NodeInvokeRequestEventSchema,
};
