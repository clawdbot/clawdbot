import { normalizeStringEntries } from "../shared/string-normalization.js";
import { isRecord } from "../utils.js";

export type PluginConfigContractMatch = {
  path: string;
  value: unknown;
};

type TraversalState = {
  segments: string[];
  value: unknown;
};

function normalizePathPattern(pathPattern: string): string[] {
  return normalizeStringEntries(pathPattern.split("."));
}

function appendPathSegment(path: string, segment: string): string {
  if (!path) {
    return segment;
  }
  return /^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`;
}

function parseCanonicalArrayIndex(segment: string, length: number): number | null {
  if (!/^(0|[1-9]\d*)$/.test(segment)) {
    return null;
  }
  const index = Number(segment);
  return Number.isSafeInteger(index) && index >= 0 && index < length ? index : null;
}

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
        if (Array.isArray(state.value)) {
          for (const [index, value] of state.value.entries()) {
            nextStates.push({
              segments: [...state.segments, String(index)],
              value,
            });
          }
          continue;
        }
        if (isRecord(state.value)) {
          for (const [key, value] of Object.entries(state.value)) {
            nextStates.push({
              segments: [...state.segments, key],
              value,
            });
          }
        }
        continue;
      }
      if (Array.isArray(state.value)) {
        const index = parseCanonicalArrayIndex(segment, state.value.length);
        if (index !== null) {
          nextStates.push({
            segments: [...state.segments, segment],
            value: state.value[index],
          });
        }
        continue;
      }
      if (!isRecord(state.value) || !Object.prototype.hasOwnProperty.call(state.value, segment)) {
        continue;
      }
      nextStates.push({
        segments: [...state.segments, segment],
        value: state.value[segment],
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
  }));
}
