/** ACP runtime error exports wired to OpenClaw secret redaction. */
import { configureAcpErrorRedactor } from "@openclaw/acp-core";
import { redactToolPayloadText } from "../../logging/redact.js";

// Core must import ACP errors and error text only through this barrel so the
// canonical redactor is configured first. It merges operator patterns with the
// defaults so custom logging policy cannot disable provider-token coverage.
configureAcpErrorRedactor(redactToolPayloadText);

export * from "@openclaw/acp-core/runtime/errors";
export * from "@openclaw/acp-core/runtime/error-text";
