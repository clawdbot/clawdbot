// Qa Lab plugin module implements shared parity comparison helpers.
import { createHash } from "node:crypto";

type ParityToolCallShape = {
  argsHash: string;
  tool: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeForStableHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHash(record[key])]),
    );
  }
  return value;
}

export function stableHash(value: unknown) {
  return sha256(JSON.stringify(normalizeForStableHash(value)) ?? "null");
}

export function compareToolCallShape(
  left: readonly ParityToolCallShape[],
  right: readonly ParityToolCallShape[],
): string | undefined {
  if (left.length !== right.length) {
    return `tool call count differs (${left.length} vs ${right.length})`;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCall = left[index];
    const rightCall = right[index];
    if (!leftCall || !rightCall) {
      return `tool call row ${index + 1} missing`;
    }
    if (leftCall.tool !== rightCall.tool || leftCall.argsHash !== rightCall.argsHash) {
      return `tool call ${index + 1} differs (${leftCall.tool}/${leftCall.argsHash} vs ${rightCall.tool}/${rightCall.argsHash})`;
    }
  }
  return undefined;
}

function distinctToolCallShapes(toolCalls: readonly ParityToolCallShape[]) {
  return toolCalls.filter(
    (toolCall, index) =>
      toolCalls.findIndex(
        (candidate) => candidate.tool === toolCall.tool && candidate.argsHash === toolCall.argsHash,
      ) === index,
  );
}

export function compareCapturedToolCallShape(
  left: readonly ParityToolCallShape[],
  right: readonly ParityToolCallShape[],
) {
  const exactMatch = compareToolCallShape(left, right);
  if (exactMatch === undefined) {
    return undefined;
  }
  // Process-global captures can repeat planned rows. The canonical transcript
  // must remain an ordered subsequence; unknown shapes still fail comparison.
  let rightIndex = 0;
  for (const leftCall of left) {
    const expected = right[rightIndex];
    if (expected?.tool === leftCall.tool && expected.argsHash === leftCall.argsHash) {
      rightIndex += 1;
      continue;
    }
    const duplicatedImageShape =
      leftCall.tool === "image_generate" &&
      right.some(
        (candidate) => candidate.tool === leftCall.tool && candidate.argsHash === leftCall.argsHash,
      );
    if (!duplicatedImageShape) {
      return exactMatch;
    }
  }
  return rightIndex === right.length ? undefined : exactMatch;
}

export function hasSingleDistinctLeftToolCallShape(
  left: readonly ParityToolCallShape[],
  right: readonly ParityToolCallShape[],
) {
  const distinctLeft = distinctToolCallShapes(left);
  return (
    distinctLeft.length <= 1 &&
    right.length <= 1 &&
    (distinctLeft.length === 0 ||
      right.length === 0 ||
      compareToolCallShape(distinctLeft, right) === undefined)
  );
}
