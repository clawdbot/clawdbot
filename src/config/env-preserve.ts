// Normalizes preserved environment-variable config for subprocess launches.
import { isPlainObject } from "../infra/plain-object.js";

/**
 * Preserves `${VAR}` environment variable references during config write-back.
 *
 * When config is read, `${VAR}` references are resolved to their values.
 * When writing back, callers pass the resolved config. This module detects
 * values that match what a `${VAR}` reference would resolve to and restores
 * the original reference, so env var references survive config round-trips.
 *
 * A value is restored only if:
 * 1. The pre-substitution value contained a `${VAR}` pattern
 * 2. Resolving that pattern with current env vars produces the incoming value
 *
 * If a caller intentionally set a new value (different from what the env var
 * resolves to), the new value is kept as-is.
 */

const ENV_VAR_PATTERN = /\$\{[A-Z_][A-Z0-9_]*\}/;

/**
 * Check if a string contains any `${VAR}` env var references.
 */
function hasEnvVarRef(value: string): boolean {
  return ENV_VAR_PATTERN.test(value);
}

/**
 * Resolve `${VAR}` references in a single string using the given env.
 * Returns null if any referenced var is missing (instead of throwing).
 *
 * Mirrors the substitution semantics of `substituteString` in env-substitution.ts:
 * - `${VAR}` → env value (returns null if missing)
 * - `$${VAR}` → literal `${VAR}` (escape sequence)
 */
function tryResolveString(template: string, env: NodeJS.ProcessEnv): string | null {
  const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;
  const chunks: string[] = [];

  for (let i = 0; i < template.length; i++) {
    if (template[i] === "$") {
      // Escaped: $${VAR} -> literal ${VAR}
      if (template[i + 1] === "$" && template[i + 2] === "{") {
        const start = i + 3;
        const end = template.indexOf("}", start);
        if (end !== -1) {
          const name = template.slice(start, end);
          if (ENV_VAR_NAME.test(name)) {
            chunks.push(`\${${name}}`);
            i = end;
            continue;
          }
        }
      }

      // Substitution: ${VAR} -> env value
      if (template[i + 1] === "{") {
        const start = i + 2;
        const end = template.indexOf("}", start);
        if (end !== -1) {
          const name = template.slice(start, end);
          if (ENV_VAR_NAME.test(name)) {
            const val = env[name];
            if (val === undefined || val === "") {
              return null;
            }
            chunks.push(val);
            i = end;
            continue;
          }
        }
      }
    }
    chunks.push(template[i]);
  }

  return chunks.join("");
}

/**
 * Deep-walk the incoming config and restore `${VAR}` references from the
 * pre-substitution parsed config wherever the resolved value matches.
 *
 * @param incoming - The resolved config about to be written
 * @param parsed - The pre-substitution parsed config (from the current file on disk)
 * @param env - Environment variables for verification
 * @returns A new config object with env var references restored where appropriate
 */
export function restoreEnvVarRefs(
  incoming: unknown,
  parsed: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  // If parsed has no env var refs at this level, return incoming as-is
  if (parsed === null || parsed === undefined) {
    return incoming;
  }

  // String leaf: check if parsed was a ${VAR} template that resolves to incoming
  if (typeof incoming === "string" && typeof parsed === "string") {
    if (hasEnvVarRef(parsed)) {
      const resolved = tryResolveString(parsed, env);
      if (resolved === incoming) {
        // The incoming value matches what the env var resolves to — restore the reference
        return parsed;
      }
    }
    return incoming;
  }

  // Arrays: walk element by element
  if (Array.isArray(incoming) && Array.isArray(parsed)) {
    return incoming.map((item, i) =>
      i < parsed.length ? restoreEnvVarRefs(item, parsed[i], env) : item,
    );
  }

  // Objects: walk key by key
  if (isPlainObject(incoming) && isPlainObject(parsed)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (key in parsed) {
        result[key] = restoreEnvVarRefs(value, parsed[key], env);
      } else {
        // New key added by caller — keep as-is
        result[key] = value;
      }
    }
    return result;
  }

  // Mismatched types or primitives — keep incoming
  return incoming;
}
