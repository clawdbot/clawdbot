/**
 * Channel target resolver helpers.
 *
 * Builds unresolved rows and token-gated resolution flows for setup/allowlist targets.
 */
import type { ChannelResolveResult } from "./types.adapters.js";

/**
 * Builds unresolved target results with one common note.
 */
export function buildUnresolvedTargetResults(
  inputs: string[],
  note: string,
): ChannelResolveResult[] {
  return inputs.map((input) => ({
    input,
    resolved: false,
    note,
  }));
}

/**
 * Resolves targets only when a required token is available.
 */
export async function resolveTargetsWithOptionalToken<TResult>(params: {
  token?: string | null;
  inputs: string[];
  missingTokenNote: string;
  resolveWithToken: (params: { token: string; inputs: string[] }) => Promise<TResult[]>;
  mapResolved: (entry: TResult) => ChannelResolveResult;
}): Promise<ChannelResolveResult[]> {
  const token = params.token?.trim();
  if (!token) {
    // Preserve one output row per input so setup UIs can show which entries
    // could not be resolved while credentials are missing.
    return buildUnresolvedTargetResults(params.inputs, params.missingTokenNote);
  }
  const resolved = await params.resolveWithToken({
    token,
    inputs: params.inputs,
  });
  return resolved.map(params.mapResolved);
}
