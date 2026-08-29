// Line plugin module owns the card command's registration metadata.
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Registration metadata for `/card`.
 *
 * The bundled entry registers the command eagerly and loads its handler lazily,
 * so the metadata has to exist outside the handler module. Both sites read it
 * from here: a second copy would ship whichever one the entry happens to
 * declare and silently discard the other.
 *
 * `channels` is the load-bearing field. Flex cards are a LINE transport feature,
 * and an unscoped command is offered on every channel surface, including other
 * providers' native command menus.
 */
export const LINE_CARD_COMMAND_METADATA = {
  name: "card",
  description: "Send a rich card message.",
  channels: ["line"],
  acceptsArgs: true,
  requireAuth: false,
} as const satisfies Omit<OpenClawPluginCommandDefinition, "handler">;
