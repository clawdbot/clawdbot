import { normalizeProviderId } from "../agents/provider-id.js";

export function normalizeMediaProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "gemini") {
    return "google";
  }
  if (normalized === "minimax-cn") {
    return "minimax";
  }
  if (normalized === "minimax-portal-cn") {
    return "minimax-portal";
  }
  return normalized;
}

export function normalizeMediaExecutionProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "minimax-cn" || normalized === "minimax-portal-cn") {
    return normalized;
  }
  return normalizeMediaProviderId(normalized);
}
