export const explicitUndefinedLegacyObjectPropertyValue = Symbol(
  "explicit undefined legacy object property value",
);

export function mergeConditionalLiteralTexts(previous, next) {
  if (next.length === 0) {
    return previous ?? null;
  }
  return [...new Set([...(previous ?? []), ...next])];
}

export function mergeExhaustiveLiteralTexts(left, right) {
  if (left.length === 0 && right.length === 0) {
    return null;
  }
  return [...new Set([...left, ...right])];
}

export function mergeLegacyObjectPropertyValues(left, right) {
  if (left === true || right === true) {
    return true;
  }
  if (
    left === explicitUndefinedLegacyObjectPropertyValue ||
    right === explicitUndefinedLegacyObjectPropertyValue ||
    left === undefined ||
    right === undefined
  ) {
    return explicitUndefinedLegacyObjectPropertyValue;
  }
  return false;
}

export function mergeConditionalLegacyObjectPropertyValue(previous, next) {
  if (previous === undefined && next === false) {
    return null;
  }
  return mergeLegacyObjectPropertyValues(previous, next);
}

function branchAssignmentPropertyValue(assignment, propertyKey) {
  if (assignment.objectProperties.has(propertyKey)) {
    return { known: true, value: assignment.objectProperties.get(propertyKey) };
  }
  if (assignment.knownObjectLiteral) {
    return { known: true, value: explicitUndefinedLegacyObjectPropertyValue };
  }
  return { known: false, value: null };
}

function mergeBranchLegacyObjectPropertyValue(leftAssignment, rightAssignment, propertyKey) {
  const left = branchAssignmentPropertyValue(leftAssignment, propertyKey);
  const right = branchAssignmentPropertyValue(rightAssignment, propertyKey);
  if (!left.known && !right.known) {
    return null;
  }
  if (left.value === true || right.value === true) {
    return true;
  }
  if (
    left.value === explicitUndefinedLegacyObjectPropertyValue ||
    right.value === explicitUndefinedLegacyObjectPropertyValue
  ) {
    return explicitUndefinedLegacyObjectPropertyValue;
  }
  return left.known && right.known ? false : null;
}

export function mergeLegacyPathBranchAssignments(left, right) {
  const propertyKeys = new Set([...left.objectProperties.keys(), ...right.objectProperties.keys()]);
  const objectProperties = new Map();
  for (const propertyKey of propertyKeys) {
    const value = mergeBranchLegacyObjectPropertyValue(left, right, propertyKey);
    if (value !== null) {
      objectProperties.set(propertyKey, value);
    }
  }

  const knownObjectLiteralKeys = new Set([
    ...left.knownObjectLiterals.keys(),
    ...right.knownObjectLiterals.keys(),
  ]);
  const knownObjectLiterals = new Map();
  for (const key of knownObjectLiteralKeys) {
    knownObjectLiterals.set(
      key,
      left.knownObjectLiterals.get(key) === true && right.knownObjectLiterals.get(key) === true,
    );
  }

  return {
    knownObjectLiteral: left.knownObjectLiteral && right.knownObjectLiteral,
    knownObjectLiterals,
    knownUndefined: left.knownUndefined || right.knownUndefined,
    literalTexts: mergeExhaustiveLiteralTexts(left.literalTexts, right.literalTexts),
    objectProperties,
    value: left.value === true || right.value === true,
  };
}
