import { isDeepStrictEqual } from "node:util";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import { isPlainObject } from "../infra/plain-object.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

type ConfigLayer = { id: string; config: unknown };

type ConfigLayerFinding = {
  reason:
    | "EmptyLayerId"
    | "DuplicateLayerId"
    | "InvalidLayerDocument"
    | "BlockedConfigPath"
    | "ControlledByEarlierLayer"
    | "WouldWeakenEarlierLayer";
  layer: string;
  path?: string;
  controllingLayer?: string;
};

type ConfigLayerResult =
  | { valid: true; config: Record<string, unknown> }
  | { valid: false; findings: ConfigLayerFinding[] };

type Control = "exact" | "allow-set-ceiling" | "deny-set-floor";
type Claim = { path: string[]; layer: string; control: Control; value: unknown };

const BOUNDED_CONTROL = new Map<string, Exclude<Control, "exact">>([
  ["tools.allow", "allow-set-ceiling"],
  ["tools.deny", "deny-set-floor"],
]);

function canonicalToolSet(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return [...new Set(value as string[])].toSorted();
}

function isToolPolicyExpression(entry: string): boolean {
  return entry.startsWith("group:") || /[*?[]/.test(entry);
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function pathLabel(path: readonly string[]): string {
  return path.join(".");
}

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const shared = Math.min(a.length, b.length);
  return a.slice(0, shared).every((segment, index) => segment === b[index]);
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const leaf = path.at(-1);
  if (leaf === undefined) {
    return;
  }
  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    const current = cursor[segment];
    if (isPlainObject(current)) {
      cursor = current;
    } else {
      const next: Record<string, unknown> = {};
      cursor[segment] = next;
      cursor = next;
    }
  }
  cursor[leaf] = structuredClone(value);
}

function compareBounded(control: Exclude<Control, "exact">, inherited: unknown, next: unknown) {
  const inheritedSet = canonicalToolSet(inherited);
  const nextSet = canonicalToolSet(next);
  if (!inheritedSet || !nextSet) {
    return undefined;
  }
  const nextValues = new Set(nextSet);
  const accepted =
    control === "allow-set-ceiling"
      ? inheritedSet.length === 0 ||
        (nextSet.length > 0 &&
          nextSet.every((entry) =>
            isToolPolicyExpression(entry)
              ? inheritedSet.includes(entry) || inheritedSet.includes("*")
              : isToolAllowedByPolicyName(entry, { allow: inheritedSet }),
          ))
      : inheritedSet.every(
          (entry) =>
            nextValues.has(entry) ||
            nextValues.has("*") ||
            (!isToolPolicyExpression(entry) &&
              !isToolAllowedByPolicyName(entry, { deny: nextSet })),
        );
  return accepted ? nextSet : undefined;
}

/**
 * Composes sparse config documents in declared order. The first declaration
 * owns an exact path; later layers may repeat the same value but may not replace
 * it. `tools.allow` may only narrow and `tools.deny` may only expand.
 */
export function composeConfigLayers(layers: readonly ConfigLayer[]): ConfigLayerResult {
  const findings: ConfigLayerFinding[] = [];
  const seen = new Set<string>();
  const claims = new Map<string, Claim>();
  const config: Record<string, unknown> = {};

  for (const layer of layers) {
    if (!layer.id.trim()) {
      findings.push({ reason: "EmptyLayerId", layer: layer.id });
      continue;
    }
    if (seen.has(layer.id)) {
      findings.push({ reason: "DuplicateLayerId", layer: layer.id });
      continue;
    }
    seen.add(layer.id);
    if (!isPlainObject(layer.config)) {
      findings.push({ reason: "InvalidLayerDocument", layer: layer.id });
      continue;
    }

    const visit = (value: Record<string, unknown>, parent: string[]) => {
      for (const key of Object.keys(value).toSorted()) {
        const path = [...parent, key];
        if (isBlockedObjectKey(key)) {
          findings.push({ reason: "BlockedConfigPath", layer: layer.id, path: pathLabel(path) });
          continue;
        }
        const candidate = value[key];
        if (isPlainObject(candidate) && Object.keys(candidate).length > 0) {
          const overlapping = [...claims.values()].find(
            (claim) =>
              claim.path.length <= path.length &&
              claim.path.every((segment, index) => segment === path[index]),
          );
          if (overlapping) {
            findings.push({
              reason: "ControlledByEarlierLayer",
              layer: layer.id,
              path: pathLabel(path),
              controllingLayer: overlapping.layer,
            });
          } else {
            visit(candidate, path);
          }
          continue;
        }

        const existing =
          claims.get(pathKey(path)) ??
          [...claims.values()].find((claim) => overlaps(claim.path, path));
        if (!existing) {
          const control = BOUNDED_CONTROL.get(pathLabel(path)) ?? "exact";
          const prepared =
            control === "exact" ? candidate : (canonicalToolSet(candidate) ?? candidate);
          claims.set(pathKey(path), { path, layer: layer.id, control, value: prepared });
          setPath(config, path, prepared);
          continue;
        }
        if (existing.control === "exact") {
          if (!isDeepStrictEqual(existing.value, candidate)) {
            findings.push({
              reason: "ControlledByEarlierLayer",
              layer: layer.id,
              path: pathLabel(path),
              controllingLayer: existing.layer,
            });
          }
          continue;
        }
        const bounded = compareBounded(existing.control, existing.value, candidate);
        if (!bounded) {
          findings.push({
            reason: "WouldWeakenEarlierLayer",
            layer: layer.id,
            path: pathLabel(path),
            controllingLayer: existing.layer,
          });
          continue;
        }
        existing.value = bounded;
        setPath(config, path, bounded);
      }
    };

    visit(layer.config, []);
  }

  return findings.length > 0 ? { valid: false, findings } : { valid: true, config };
}
