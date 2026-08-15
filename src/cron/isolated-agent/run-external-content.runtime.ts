// Runtime external-content safety seam for hook-triggered cron runs.
export {
  buildSafeExternalPrompt,
  detectSuspiciousPatterns,
} from "../../security/external-content.js";
