import { acpConfiguredBindingConsumer } from "./acp-configured-binding-consumer.js";
import { registerConfiguredBindingConsumer } from "./configured-binding-consumers.js";

export function ensureConfiguredBindingBuiltinsRegistered(): void {
  registerConfiguredBindingConsumer(acpConfiguredBindingConsumer);
}
