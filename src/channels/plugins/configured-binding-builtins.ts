/**
 * Configured binding built-in registration.
 *
 * Registers core configured binding consumers exactly when the registry facade needs them.
 */
import { acpConfiguredBindingConsumer } from "./acp-configured-binding-consumer.js";
import { registerConfiguredBindingConsumer } from "./configured-binding-consumers.js";

/**
 * Registers configured binding consumers bundled with core.
 */
export function ensureConfiguredBindingBuiltinsRegistered(): void {
  registerConfiguredBindingConsumer(acpConfiguredBindingConsumer);
}
