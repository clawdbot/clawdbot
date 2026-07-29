// Media Generation Core module implements model ref behavior.
import {
  parseProviderModelRef,
  type ProviderModelRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";

/** Provider/model pair parsed from a generation model reference like `provider/model`. */
export type ParsedGenerationModelRef = ProviderModelRef;

/** Parses strict generation model refs and rejects missing provider or model segments. */
export function parseGenerationModelRef(raw: string | undefined): ProviderModelRef | null {
  return raw === undefined ? null : parseProviderModelRef(raw);
}
