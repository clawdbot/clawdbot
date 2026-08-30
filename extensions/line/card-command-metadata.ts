// Line plugin module owns the card command's registration metadata.
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Registration metadata for `/card`. The bundled entry registers the command
 * eagerly and loads its handler lazily, so both sites read the metadata from
 * here; a second copy would ship one and silently discard the other.
 *
 * Lives beside the entry rather than under `src/` because the bundled channel
 * entrypoint may not statically import `./src/*` — that boundary is what keeps
 * the channel's runtime off the eager load path.
 *
 * `channels` is load-bearing: an unscoped command is offered on every channel
 * surface, including other providers' native command menus.
 */
export const LINE_CARD_COMMAND_METADATA = {
  name: "card",
  description: "Send a rich card message.",
  channels: ["line"],
  acceptsArgs: true,
  requireAuth: false,
} as const satisfies Omit<OpenClawPluginCommandDefinition, "handler">;
