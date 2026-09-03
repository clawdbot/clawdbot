import * as nodes from "./nodes.js";
import * as nodeInvoke from "./protocol-schemas-node-invoke.js";
import * as nodePresence from "./protocol-schemas-node-presence.js";

export const NodeProtocolSchemas = {
  NodePairListParams: nodes.NodePairListParamsSchema,
  NodePairApproveParams: nodes.NodePairApproveParamsSchema,
  NodePairRejectParams: nodes.NodePairRejectParamsSchema,
  NodePairRemoveParams: nodes.NodePairRemoveParamsSchema,
  NodeRenameParams: nodes.NodeRenameParamsSchema,
  NodeListParams: nodes.NodeListParamsSchema,
  NodePluginToolDescriptor: nodes.NodePluginToolDescriptorSchema,
  NodePluginToolsUpdateParams: nodes.NodePluginToolsUpdateParamsSchema,
  NodeSkillDescriptor: nodes.NodeSkillDescriptorSchema,
  NodeSkillsUpdateParams: nodes.NodeSkillsUpdateParamsSchema,
  NodePendingAckParams: nodes.NodePendingAckParamsSchema,
  NodeDescribeParams: nodes.NodeDescribeParamsSchema,
  ...nodeInvoke.NodeInvokeProtocolSchemas,
  NodeEventParams: nodes.NodeEventParamsSchema,
  NodeEventResult: nodes.NodeEventResultSchema,
  NodePresenceAlivePayload: nodes.NodePresenceAlivePayloadSchema,
  ...nodePresence.NodePresenceProtocolSchemas,
  NodeHostStatsPayload: nodes.NodeHostStatsPayloadSchema,
  NodePendingDrainParams: nodes.NodePendingDrainParamsSchema,
  NodePendingDrainResult: nodes.NodePendingDrainResultSchema,
  NodePendingEnqueueParams: nodes.NodePendingEnqueueParamsSchema,
  NodePendingEnqueueResult: nodes.NodePendingEnqueueResultSchema,
} as const;
