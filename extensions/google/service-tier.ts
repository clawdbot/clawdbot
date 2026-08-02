// Google AI Studio (direct Gemini API) accepts a top-level `serviceTier`
// request field. The wire values are the documented lower-case enums
// ("flex" | "priority" | "standard"); see the API discovery document
// (GenerateContentRequest.serviceTier). Vertex ignores a request-body
// serviceTier, so this mapping must only be applied to the direct
// `google-generative-ai` transport.
const GOOGLE_SERVICE_TIERS = ["flex", "priority", "standard"] as const;

type GoogleServiceTier = (typeof GOOGLE_SERVICE_TIERS)[number];

export function resolveGoogleServiceTier(
  extraParams: Record<string, unknown> | undefined,
): GoogleServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  return (GOOGLE_SERVICE_TIERS as readonly string[]).includes(normalized)
    ? (normalized as GoogleServiceTier)
    : undefined;
}

export function applyGoogleServiceTierToPayload(
  payload: Record<string, unknown>,
  serviceTier: GoogleServiceTier,
): void {
  // An explicit payload value (e.g. set by an onPayload hook) wins over params.
  if (payload.serviceTier === undefined) {
    payload.serviceTier = serviceTier;
  }
}
