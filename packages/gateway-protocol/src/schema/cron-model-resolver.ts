/**
 * cron-model-resolver — Gateway-level canonical model-name validator.
 *
 * Reference implementation for the Gateway cron validation pipeline.
 * Inserts into validateCronAddParams / validateCronUpdateParams as a
 * content-level check between type-shape validation (already in place)
 * and the cron-store write.
 *
 * Design (locked 2026-08-06):
 *  - REJECT-AND-REQUIRE (not silent-normalize): silent normalization creates
 *    an invisible support cadre that absorbs responsibility instead of
 *    distributing it.
 *  - Five ordered validation rules.
 *  - Unknown providers → warn-but-accept (don't block future providers).
 *
 * Python spike: ~/.openclaw/agents/fae/workspace/practical/cron-model-resolver.py
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  /** The identifier that was validated */
  identifier: string;
  /** Whether the identifier passes validation */
  valid: boolean;
  /** Canonical form (only when valid, optional) */
  canonical?: string;
  /** Human-readable error message (only when invalid) */
  error?: string;
  /** Suggested correction (only when invalid, optional) */
  suggestion?: string;
  /** Non-blocking warnings (only when valid with caveats) */
  warnings: string[];
}

interface ParsedIdentifier {
  provider: string;
  model: string;
  subInfix: string | null;
  tierSuffix: string | null;
}

// ── Provider recognition tables ──────────────────────────────────────────

/** Providers that use tier suffixes (-free, -paid, etc.) */
const TIERED_PROVIDERS: Record<string, {
  prefix: string;
  tiers: string[];
  incompatibleWith: string[];
}> = {
  opencode: {
    prefix: "opencode/",
    tiers: ["-free", "-paid"],
    incompatibleWith: ["-go"], // -go infix means opencode-go provider
  },
};

/** Providers with their own namespace — no tier suffixes, pass-through */
const PASSTHROUGH_PREFIXES: string[] = [
  "openrouter/",
  "google/",
  "anthropic/",
  "openai/",
  "deepinfra/",
  "groq/",
  "xai/",
  "mistral/",
];

/** Known provider prefixes — triggers warn-but-accept for anything else */
const KNOWN_PREFIXES: string[] = [
  ...PASSTHROUGH_PREFIXES,
  "opencode/",     // opencode free tier
  "opencode-go/",  // opencode-go paid tier (opencode.ai)
];

/** Sub-provider infixes that indicate a DIFFERENT provider than the base */
const SUB_PROVIDER_INFIXES: string[] = ["-go", "-beta", "-staging"];

/** Known tier suffixes */
const TIER_SUFFIXES: string[] = ["-free", "-paid"];

// ── Parsing ──────────────────────────────────────────────────────────────

function parseIdentifier(identifier: string): ParsedIdentifier {
  const slashIdx = identifier.indexOf("/");
  if (slashIdx === -1) {
    return { provider: identifier, model: "", subInfix: null, tierSuffix: null };
  }

  const provider = identifier.slice(0, slashIdx);
  const model = identifier.slice(slashIdx + 1);

  // Detect sub-provider infix in the provider part
  let subInfix: string | null = null;
  for (const infix of SUB_PROVIDER_INFIXES) {
    if (provider.endsWith(infix)) {
      subInfix = infix;
      break;
    }
  }

  // Detect tier suffix in the model part
  let tierSuffix: string | null = null;
  for (const suffix of TIER_SUFFIXES) {
    if (model.endsWith(suffix)) {
      tierSuffix = suffix;
      break;
    }
  }

  return { provider, model, subInfix, tierSuffix };
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Validate a single model identifier.
 *
 * Rules (evaluated in order):
 *   1. -go infix AND -free suffix in same identifier → REJECT with suggestion
 *   2. Known pass-through prefix → accept silently (no tiers)
 *   3. Known tiered provider without mixing → accept silently
 *   4. Other infix+tier combos matched against incompatibility table → REJECT
 *   5. Unknown provider → warn-but-accept (don't block future providers)
 */
export function validate(identifier: string): ValidationResult {
  // ── Rule 1: -go AND -free in same identifier → REJECT ──
  const parsed = parseIdentifier(identifier);
  const hasGo = parsed.subInfix === "-go";
  const hasFree = parsed.tierSuffix === "-free";

  if (hasGo && hasFree) {
    const baseProvider = parsed.provider.replace(/-go$/, "");
    const suggestion = `${baseProvider}/${parsed.model}`;
    return {
      identifier,
      valid: false,
      error:
        `Mixed provider identifier: '${identifier}' combines ` +
        `the '-go' infix (opencode-go provider) with the '-free' ` +
        `suffix (opencode free tier). These are DIFFERENT providers. ` +
        `'-go' = paid opencode.ai tier; '-free' = free opencode tier.`,
      suggestion,
      warnings: [],
    };
  }

  // ── Rule 2: Known pass-through prefix → accept silently ──
  for (const prefix of PASSTHROUGH_PREFIXES) {
    if (identifier.startsWith(prefix)) {
      return { identifier, valid: true, warnings: [] };
    }
  }

  // ── Rule 3: Known provider without mixing → accept silently ──
  for (const prefix of KNOWN_PREFIXES) {
    if (identifier.startsWith(prefix) && !PASSTHROUGH_PREFIXES.includes(prefix)) {
      return { identifier, valid: true, warnings: [] };
    }
  }

  // ── Rule 4: Other infix+tier combos against incompatibility table ──
  if (parsed.subInfix && parsed.tierSuffix) {
    for (const [providerKey, config] of Object.entries(TIERED_PROVIDERS)) {
      if (parsed.provider.startsWith(providerKey)) {
        for (const infix of config.incompatibleWith) {
          if (parsed.provider.endsWith(infix)) {
            const base = parsed.provider.replace(new RegExp(`${infix}$`), "");
            const suggestion = `${base}/${parsed.model}`;
            return {
              identifier,
              valid: false,
              error:
                `Incompatible provider infix + tier suffix in '${identifier}': ` +
                `'${infix}' sub-provider does not support '${parsed.tierSuffix}' tier.`,
              suggestion,
              warnings: [],
            };
          }
        }
      }
    }
  }

  // ── Rule 5: Unknown provider → warn-but-accept ──
  return {
    identifier,
    valid: true,
    warnings: [
      `Unknown provider prefix in '${identifier}' — accepted but not validated.`,
    ],
  };
}

/**
 * Validate multiple identifiers. Returns results and aggregate validity.
 */
export function validateBatch(
  identifiers: string[]
): { results: ValidationResult[]; allValid: boolean } {
  const results = identifiers.map(validate);
  const allValid = results.every((r) => r.valid);
  return { results, allValid };
}

// ── Gateway integration helpers ──────────────────────────────────────────

/**
 * Validate cron payload model fields.
 *
 * Call this inside validateCronAddParams / validateCronUpdateParams
 * AFTER the type-shape validation passes (model is string, fallbacks is
 * string[]), and BEFORE the cron-store write.
 *
 * Returns an array of error messages. Empty array = all valid.
 *
 * @param model - The primary model string from payload.model
 * @param fallbacks - Optional fallback model strings from payload.fallbacks
 * @param thinking - Optional thinking model string from payload.thinking
 */
export function validateCronModelFields(
  model: string,
  fallbacks?: string[] | null,
  thinking?: string | null
): string[] {
  const errors: string[] = [];
  const identifiers = [model];

  if (fallbacks && fallbacks.length > 0) {
    identifiers.push(...fallbacks);
  }
  if (thinking) {
    identifiers.push(thinking);
  }

  for (const id of identifiers) {
    const result = validate(id);
    if (!result.valid) {
      const msg = result.suggestion
        ? `${result.error} Did you mean '${result.suggestion}'?`
        : result.error!;
      errors.push(msg);
    }
  }

  return errors;
}

// ── Self-test (run with: npx tsx cron-model-resolver.ts --test) ──────────

function runTests(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;

  function expect(
    identifier: string,
    expectedValid: boolean,
    description: string
  ): void {
    const result = validate(identifier);
    if (result.valid === expectedValid) {
      passed++;
    } else {
      failed++;
      console.error(
        `FAIL: ${description}\n` +
        `  identifier: ${identifier}\n` +
        `  expected valid=${expectedValid}, got valid=${result.valid}\n` +
        `  error: ${result.error ?? "none"}\n` +
        `  warnings: ${result.warnings.join(", ") || "none"}`
      );
    }
  }

  // Should REJECT: -go infix + -free suffix
  expect("opencode-go/deepseek-v4-flash-free", false, "-go + -free → REJECT");
  expect("opencode-go/mimo-v2.5-free", false, "-go + -free (mimo) → REJECT");

  // Should ACCEPT: known valid identifiers
  expect("opencode/deepseek-v4-flash-free", true, "opencode/-free → VALID");
  expect("opencode-go/deepseek-v4-flash", true, "opencode-go/paid → VALID");
  expect("google/gemini-2.5-flash", true, "google/ → VALID (pass-through)");
  expect("openrouter/deepseek/deepseek-v4-flash", true, "openrouter/ → VALID (pass-through)");
  expect("anthropic/claude-sonnet-4-20250514", true, "anthropic/ → VALID (pass-through)");
  expect("openai/gpt-5.1", true, "openai/ → VALID (pass-through)");

  // Unknown provider → warn-but-accept
  const unknown = validate("future-ai/super-model-v2");
  if (unknown.valid === true && unknown.warnings.length > 0) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: unknown provider → warn-but-accept (valid=${unknown.valid}, warnings=${unknown.warnings.length})`);
  }

  // Batch test with the stale cron dump identifiers
  const staleDumpIds = [
    "opencode-go/deepseek-v4-flash-free",
    "opencode-go/mimo-v2.5-free",
    "opencode/deepseek-v4-flash-free",
    "opencode-go/deepseek-v4-flash",
    "google/gemini-2.5-flash",
    "openrouter/deepseek/deepseek-v4-flash",
  ];
  const { results: batchResults, allValid } = validateBatch(staleDumpIds);
  const rejects = batchResults.filter((r) => !r.valid);
  const accepts = batchResults.filter((r) => r.valid);

  if (rejects.length === 2 && accepts.length === 4 && !allValid) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: batch validation — expected 2 rejects + 4 accepts, got ${rejects.length} + ${accepts.length}`
    );
  }

  // validateCronModelFields integration test
  const integrationErrors = validateCronModelFields(
    "opencode-go/deepseek-v4-flash-free",
    ["opencode/deepseek-v4-flash-free", "google/gemini-2.5-flash"],
    "opencode-go/mimo-v2.5-free"
  );
  // model + thinking are invalid, fallback[0] is valid, fallback[1] is valid
  if (integrationErrors.length === 2) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: validateCronModelFields — expected 2 errors, got ${integrationErrors.length}`
    );
  }

  return { passed, failed };
}

// ── CLI ──────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cron-model-resolver.ts")) {
  if (process.argv.includes("--test")) {
    const { passed, failed } = runTests();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }

  const identifiers = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (identifiers.length === 0) {
    console.error("Usage: npx tsx cron-model-resolver.ts [--test] <model-identifier> [...]");
    process.exit(2);
  }

  const { results, allValid } = validateBatch(identifiers);
  for (const r of results) {
    if (r.valid) {
      const warnFlag = r.warnings.length > 0 ? " ⚠️" : "";
      console.log(`  ✅ VALID${warnFlag}  ${r.identifier}`);
      for (const w of r.warnings) {
        console.log(`         ↳ ${w}`);
      }
    } else {
      console.log(`  ❌ REJECT  ${r.identifier}`);
      console.log(`         ↳ ${r.error}`);
      if (r.suggestion) {
        console.log(`         ↳ Did you mean: '${r.suggestion}'?`);
      }
    }
  }
  process.exit(allValid ? 0 : 1);
}
