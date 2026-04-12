import type { ChannelApprovalAdapter, ChannelApprovalCapability } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

export function resolveChannelApprovalCapability(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): ChannelApprovalCapability | undefined {
  return plugin?.approvalCapability;
}

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
    return undefined;
  }
  return {
    describeExecApprovalSetup: capability.describeExecApprovalSetup,
    delivery: capability.delivery,
    nativeRuntime: capability.nativeRuntime,
    render: capability.render,
    native: capability.native,
  };
}
