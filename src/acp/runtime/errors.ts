import { configureAcpErrorRedactor } from "@openclaw/acp-core";
import { redactSensitiveText } from "../../logging/redact.js";

configureAcpErrorRedactor(redactSensitiveText);

export * from "@openclaw/acp-core/runtime/errors";
