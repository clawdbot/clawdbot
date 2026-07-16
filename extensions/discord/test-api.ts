// Discord API module exposes the plugin public contract.
export { discordPlugin } from "./src/channel.js";
export { buildFinalizedDiscordDirectInboundContext } from "./src/monitor/inbound-context.test-helpers.js";
export { testing as discordGatewayLifecycleTesting } from "./src/monitor/provider.lifecycle.js";
export { testing as discordThreadBindingTesting } from "./src/monitor/thread-bindings.manager.js";
export { discordOutbound } from "./src/outbound-adapter.js";
