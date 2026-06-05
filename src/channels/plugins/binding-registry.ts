/**
 * Configured binding registry public facade.
 *
 * Lazily registers built-in binding providers before resolving configured bindings.
 */
import { ensureConfiguredBindingBuiltinsRegistered } from "./configured-binding-builtins.js";
import {
  primeConfiguredBindingRegistry as primeConfiguredBindingRegistryRaw,
  resolveConfiguredBinding as resolveConfiguredBindingRaw,
  resolveConfiguredBindingRecord as resolveConfiguredBindingRecordRaw,
  resolveConfiguredBindingRecordBySessionKey as resolveConfiguredBindingRecordBySessionKeyRaw,
  resolveConfiguredBindingRecordForConversation as resolveConfiguredBindingRecordForConversationRaw,
} from "./configured-binding-registry.js";

export function primeConfiguredBindingRegistry(
  ...args: Parameters<typeof primeConfiguredBindingRegistryRaw>
): ReturnType<typeof primeConfiguredBindingRegistryRaw> {
  ensureConfiguredBindingBuiltinsRegistered();
  return primeConfiguredBindingRegistryRaw(...args);
}

export function resolveConfiguredBindingRecord(
  ...args: Parameters<typeof resolveConfiguredBindingRecordRaw>
): ReturnType<typeof resolveConfiguredBindingRecordRaw> {
  ensureConfiguredBindingBuiltinsRegistered();
  return resolveConfiguredBindingRecordRaw(...args);
}

export function resolveConfiguredBindingRecordForConversation(
  ...args: Parameters<typeof resolveConfiguredBindingRecordForConversationRaw>
): ReturnType<typeof resolveConfiguredBindingRecordForConversationRaw> {
  ensureConfiguredBindingBuiltinsRegistered();
  return resolveConfiguredBindingRecordForConversationRaw(...args);
}

export function resolveConfiguredBinding(
  ...args: Parameters<typeof resolveConfiguredBindingRaw>
): ReturnType<typeof resolveConfiguredBindingRaw> {
  ensureConfiguredBindingBuiltinsRegistered();
  return resolveConfiguredBindingRaw(...args);
}

export function resolveConfiguredBindingRecordBySessionKey(
  ...args: Parameters<typeof resolveConfiguredBindingRecordBySessionKeyRaw>
): ReturnType<typeof resolveConfiguredBindingRecordBySessionKeyRaw> {
  ensureConfiguredBindingBuiltinsRegistered();
  return resolveConfiguredBindingRecordBySessionKeyRaw(...args);
}
