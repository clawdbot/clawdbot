/**
 * Suppress Node.js deprecation warnings.
 *
 * On Node.js v23+ `process.noDeprecation` may be a read-only property
 * (defined via a getter on the prototype with no setter), so the
 * assignment can throw. We fall back to the environment variable which
 * achieves the same effect.
 */
export function suppressDeprecations(): void {
  try {
    process.noDeprecation = true;
  } catch {
    // read-only on Node v23+; NODE_NO_WARNINGS below covers this case
  }
  process.env.NODE_NO_WARNINGS = "1";
}
