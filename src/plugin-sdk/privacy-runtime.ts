// Internal privacy redaction helpers. Not a public SDK contract —
// kept as an internal entrypoint for bundled plugin use only.
// A public SDK surface will be added when maintainers approve
// the generic extension privacy contract.

export { redactPii, redactPiiText } from "../privacy/payload-redact.js";
export type { PrivacyConfig } from "../privacy/types.js";
