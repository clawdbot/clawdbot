/**
 * Channel approval capability adapters.
 *
 * Projects plugin approval metadata into runtime approval delivery adapters.
 */
import type { ChannelApprovalAdapter, ChannelApprovalCapability } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

/**
 * Returns the approval capability exposed by a channel plugin.
 */
export function resolveChannelApprovalCapability(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): ChannelApprovalCapability | undefined {
  return plugin?.approvalCapability;
}

/**
 * Projects a channel approval capability into the runtime approval adapter shape.
 */
export function resolveChannelApprovalAdapter(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): ChannelApprovalAdapter | undefined {
  const capability = resolveChannelApprovalCapability(plugin);
  if (!capability) {
    return undefined;
  }
  if (
    !capability.delivery &&
    !capability.nativeRuntime &&
    !capability.render &&
    !capability.native
  ) {
    // Auth-only capabilities are valid plugin metadata but do not form a delivery adapter.
    return undefined;
  }
  return {
    describeExecApprovalSetup: capability.describeExecApprovalSetup,
    describePluginApprovalSetup: capability.describePluginApprovalSetup,
    delivery: capability.delivery,
    nativeRuntime: capability.nativeRuntime,
    render: capability.render,
    native: capability.native,
  };
}
