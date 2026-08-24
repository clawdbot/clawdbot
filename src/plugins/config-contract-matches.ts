// Matches plugin config contracts against config paths and values.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";

type PluginConfigContractMatch = {
  /** Concrete config path matched by the contract pattern. */
  path: string;
  /** Config value stored at the matched path. */
  value: unknown;
  /** Exact matched container and key so assignments update the original location directly. */
  parent: Record<string, unknown> | unknown[];
  key: string;
};

type TraversalState = {
  segments: Array<string | number>;
  value: unknown;
  parent?: Record<string, unknown> | unknown[];
};

function normalizePathPattern(pathPattern: string): string[] {
  return normalizeStringEntries(pathPattern.split("."));
}

function appendPathSegment(path: string, segment: string | number): string {
  if (typeof segment === "number") {
    return `${path}[${segment}]`;
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(segment)) {
    return `${path}[${JSON.stringify(segment)}]`;
  }
  return path ? `${path}.${segment}` : segment;
}

function parseCanonicalArrayIndex(segment: string, length: number): number | null {
  const index = parseConfigPathArrayIndex(segment);
  return index !== undefined && index < length ? index : null;
}

/** Collect concrete config values that match a plugin contract path pattern. */
export function collectPluginConfigContractMatches(params: {
  root: unknown;
  pathPattern: string;
}): PluginConfigContractMatch[] {
  const pattern = normalizePathPattern(params.pathPattern);
  if (pattern.length === 0) {
    return [];
  }

  let states: TraversalState[] = [{ segments: [], value: params.root }];
  for (const segment of pattern) {
    const nextStates: TraversalState[] = [];
    for (const state of states) {
      if (segment === "*") {
        // Wildcards fan out across arrays and records so contracts can cover account maps/lists.
        if (Array.isArray(state.value)) {
          for (const [index, value] of state.value.entries()) {
            nextStates.push({
              segments: [...state.segments, index],
              value,
              parent: state.value,
            });
          }
          continue;
        }
        if (isRecord(state.value)) {
          for (const [key, value] of Object.entries(state.value)) {
            nextStates.push({
              segments: [...state.segments, key],
              value,
              parent: state.value,
            });
          }
        }
        continue;
      }
      if (Array.isArray(state.value)) {
        const index = parseCanonicalArrayIndex(segment, state.value.length);
        if (index !== null) {
          nextStates.push({
            segments: [...state.segments, index],
            value: state.value[index],
            parent: state.value,
          });
        }
        continue;
      }
      if (!isRecord(state.value) || !Object.hasOwn(state.value, segment)) {
        continue;
      }
      nextStates.push({
        segments: [...state.segments, segment],
        value: state.value[segment],
        parent: state.value,
      });
    }
    states = nextStates;
    if (states.length === 0) {
      break;
    }
  }

  return states.map((state) => ({
    path: state.segments.reduce(appendPathSegment, ""),
    value: state.value,
    parent: state.parent!,
    key: String(state.segments.at(-1)!),
  }));
}
