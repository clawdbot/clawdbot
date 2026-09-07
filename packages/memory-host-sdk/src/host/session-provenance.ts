import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { MemoryOriginClass } from "./types.js";

export function classifySessionMessageOrigin(
  message: {
    role?: unknown;
    provenance?: unknown;
  } & Record<string, unknown>,
  turnOrigin: MemoryOriginClass,
): MemoryOriginClass {
  if (message.role === "assistant") {
    const openClawMetadata = asOptionalRecord(message["__openclaw"]);
    if (openClawMetadata?.turnTainted === true) {
      return "untrusted";
    }
    return turnOrigin === "owner" ? "agent" : turnOrigin;
  }
  const provenance = asOptionalRecord(message.provenance);
  if (provenance?.kind === "internal_system") {
    return "system";
  }
  const metadata = asOptionalRecord(message["__openclaw"]);
  return metadata?.senderIsOwner === true ? "owner" : "untrusted";
}
