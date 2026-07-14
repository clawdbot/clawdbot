/** Test-only compatibility fixtures for plugin memory state. */
import {
  registerMemoryFlushPlanResolverForPlugin,
  registerMemoryPromptSectionForPlugin,
  registerMemoryRuntimeForPlugin,
  type MemoryFlushPlanResolver,
  type MemoryPluginRuntime,
  type MemoryPromptSectionBuilder,
} from "./memory-state.js";

export * from "./memory-state.js";

export function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  registerMemoryPromptSectionForPlugin("test-memory", builder);
}

export function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void {
  registerMemoryFlushPlanResolverForPlugin("test-memory", resolver);
}

export function registerMemoryRuntime(runtime: MemoryPluginRuntime): void {
  registerMemoryRuntimeForPlugin("test-memory", runtime);
}
