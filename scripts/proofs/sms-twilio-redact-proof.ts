/**
 * Proof: redactToolPayloadText prevents Basic Auth credential leakage
 * in Twilio SMS API error response bodies.
 *
 * Run: node --import tsx scripts/proofs/sms-twilio-redact-proof.ts
 *
 * - Removes `rm scripts/proofs/sms-twilio-redact-proof.ts`
 *   before merging (CI does not need proof scripts).
 */
import { redactToolPayloadText } from "../../src/logging/redact.js";

const accountSid = "AC0123456789abcdef0123456789abcd";
const authToken = "01a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6";
const credential = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

// Simulate an upstream proxy that reflects the Authorization header
// in a non-JSON error response body (the highest-risk path because
// non-JSON bypasses parseTwilioApiError and enters Error.message directly).
const rawText = [
  "<html>",
  "<h1>502 Bad Gateway</h1>",
  "<p>upstream proxy error</p>",
  "<!-- reflected: Authorization: Basic " + credential + " -->",
  "</html>",
].join("\n");

console.log("=== RAW TEXT (as returned by proxy) ===");
console.log(rawText);
console.log();

const redacted = redactToolPayloadText(rawText);

console.log("=== REDACTED TEXT (after redactToolPayloadText) ===");
console.log(redacted);
console.log();

const tokenLeaked = redacted.includes(credential);
const headerLabelKept = redacted.includes("Authorization: Basic");
const errorTextKept = redacted.includes("502 Bad Gateway");

console.log("=== VERDICT ===");
console.log(`Token leaked:         ${tokenLeaked ? "FAIL" : "PASS"}`);
console.log(`Auth header label ok: ${headerLabelKept ? "PASS" : "FAIL"}`);
console.log(`Error detail kept:    ${errorTextKept ? "PASS" : "FAIL"}`);
console.log(
  `Overall:              ${!tokenLeaked && headerLabelKept && errorTextKept ? "PASS" : "FAIL"}`,
);
