// Privacy redaction helpers exposed to extensions that need to scrub PII
// before sending text to external services (e.g. TTS providers).

export { redactPii, redactPiiText } from "../privacy/payload-redact.js";
export type { PrivacyConfig } from "../privacy/types.js";
