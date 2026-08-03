// Gateway hook payload type aliases.
// Keeps hook-facing channel ids on public plugin channel contracts.
import type { ChannelId } from "../channels/plugins/types.public.js";

// Gateway hooks use public channel ids so hook payloads stay aligned with plugin
// channel contracts instead of internal runtime ids.
/** Public channel id type carried by gateway hook payloads. */
export type HookMessageChannel = ChannelId;
