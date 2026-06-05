// Shared command-path matching helpers for CLI startup and registration policy.
type StructuredCommandPathMatchRule = {
  pattern: readonly string[];
  exact?: boolean;
};

type CommandPathMatchRule = readonly string[] | StructuredCommandPathMatchRule;

type NormalizedCommandPathMatchRule = {
  pattern: readonly string[];
  exact: boolean;
};

function isStructuredCommandPathMatchRule(
  rule: CommandPathMatchRule,
): rule is StructuredCommandPathMatchRule {
  return !Array.isArray(rule);
}

function normalizeCommandPathMatchRule(rule: CommandPathMatchRule): NormalizedCommandPathMatchRule {
  if (!isStructuredCommandPathMatchRule(rule)) {
    return { pattern: rule, exact: false };
  }
  return { pattern: rule.pattern, exact: rule.exact ?? false };
}

/** Matches a command path prefix, or the full path when `exact` is requested. */
export function matchesCommandPath(
  commandPath: string[],
  pattern: readonly string[],
  params?: { exact?: boolean },
): boolean {
  if (pattern.some((segment, index) => commandPath[index] !== segment)) {
    return false;
  }
  return !params?.exact || commandPath.length === pattern.length;
}

/** Applies the shared command-path rule shape used by startup and help policies. */
export function matchesCommandPathRule(commandPath: string[], rule: CommandPathMatchRule): boolean {
  const normalizedRule = normalizeCommandPathMatchRule(rule);
  return matchesCommandPath(commandPath, normalizedRule.pattern, {
    exact: normalizedRule.exact,
  });
}

/** Returns whether any configured command-path rule matches the parsed command path. */
export function matchesAnyCommandPath(
  commandPath: string[],
  rules: readonly CommandPathMatchRule[],
): boolean {
  return rules.some((rule) => matchesCommandPathRule(commandPath, rule));
}
