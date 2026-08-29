// Line tests cover which channels the bundled /card registration is offered on.
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import lineEntry from "./index.js";
import { registerLineCardCommand } from "./src/card-command.js";

/**
 * Collect what a registration actually hands the host.
 *
 * The bundled entry registers `/card` eagerly and loads its handler lazily, so
 * the registration the host sees is the one the entry declares, not the one
 * inside the handler module.
 */
function registeredCommands(register: (api: ReturnType<typeof createTestPluginApi>) => void) {
  const commands: OpenClawPluginCommandDefinition[] = [];
  register(
    createTestPluginApi({
      // Runs the entry's command registration without loading the channel plugin.
      registrationMode: "tool-discovery",
      registerCommand(command) {
        commands.push(command);
      },
    }),
  );
  return commands;
}

function cardCommandFrom(
  register: (api: ReturnType<typeof createTestPluginApi>) => void,
): OpenClawPluginCommandDefinition {
  const card = registeredCommands(register).find((command) => command.name === "card");
  if (!card) {
    throw new Error("LINE did not register a /card command");
  }
  return card;
}

describe("line /card registration", () => {
  it("offers the command on LINE only", () => {
    // Flex cards are a LINE transport feature. Core turns this declaration into
    // the actual gating for listings, native command menus, text matching and
    // execution; see src/plugins/commands.test.ts for that behavior.
    expect(cardCommandFrom((api) => lineEntry.register(api)).channels).toEqual(["line"]);
  });

  it("keeps the handler module's declaration identical to the shipped one", () => {
    // Two copies of this metadata would let the shipped scope drift away from
    // the one the handler module declares, with nothing reporting the gap.
    const shipped = cardCommandFrom((api) => lineEntry.register(api));
    const local = cardCommandFrom(registerLineCardCommand);
    expect(local.channels).toEqual(shipped.channels);
    expect(local.name).toBe(shipped.name);
    expect(local.description).toBe(shipped.description);
    expect(local.acceptsArgs).toBe(shipped.acceptsArgs);
    expect(local.requireAuth).toBe(shipped.requireAuth);
  });
});
