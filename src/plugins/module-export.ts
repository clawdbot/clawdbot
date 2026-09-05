import type { OpenClawPluginDefinition } from "./types.js";

/** Unwraps nested default exports produced by mixed ESM/CJS plugin bundles. */
export function unwrapDefaultModuleExport(moduleExport: unknown): unknown {
  let resolved = moduleExport;
  const seen = new Set<unknown>();

  while (resolved && typeof resolved === "object" && "default" in resolved && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = resolved.default;
  }

  return resolved;
}

export function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const seen = new Set<unknown>();
  const candidates: unknown[] = [unwrapDefaultModuleExport(moduleExport), moduleExport];
  for (let index = 0; index < candidates.length && index < 12; index += 1) {
    const resolved = candidates[index];
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    if (typeof resolved === "function") {
      // SAFETY: Callable plugin entrypoints implement the register(api) module contract.
      return { register: resolved as OpenClawPluginDefinition["register"] };
    }
    if (resolved && typeof resolved === "object") {
      // SAFETY: Object entrypoints carry optional plugin metadata; register is checked before use.
      const definition = resolved as OpenClawPluginDefinition;
      const register = definition.register;
      if (typeof register === "function") {
        return { definition, register };
      }
      for (const key of ["default", "module"]) {
        if (key in definition) {
          candidates.push(Reflect.get(definition, key));
        }
      }
    }
  }
  const resolved = candidates[0];
  if (resolved && typeof resolved === "object") {
    // SAFETY: Preserve the object entrypoint so the loader can diagnose its missing registration.
    const definition = resolved as OpenClawPluginDefinition;
    return { definition, register: definition.register };
  }
  return {};
}
