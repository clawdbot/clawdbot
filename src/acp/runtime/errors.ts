/** ACP runtime error exports wired to OpenClaw secret redaction. */
import { configureAcpErrorRedactor } from "@openclaw/acp-core";
import { redactSensitiveText } from "../../logging/redact.js";

// Core must import ACP errors and error text only through this barrel so the
// canonical redactor is configured first. ACP core keeps only a standalone fallback.
configureAcpErrorRedactor(redactSensitiveText);

export * from "@openclaw/acp-core/runtime/errors";
export * from "@openclaw/acp-core/runtime/error-text";
