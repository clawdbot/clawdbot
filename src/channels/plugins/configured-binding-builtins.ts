import { acpConfiguredBindingConsumer } from "./acp-configured-binding-consumer.js";
import { registerConfiguredBindingConsumer } from "./configured-binding-consumers.js";

/**
 * Registers configured binding consumers bundled with core.
 */
export function ensureConfiguredBindingBuiltinsRegistered(): void {
  registerConfiguredBindingConsumer(acpConfiguredBindingConsumer);
}
