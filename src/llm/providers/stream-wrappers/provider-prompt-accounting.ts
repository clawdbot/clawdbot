import type { Context, StreamFn } from "@openclaw/llm-core";

export type ProviderPromptAccountingContext = Pick<Context, "systemPrompt"> & {
  tools?: unknown[];
};

type ProviderStreamOptions = Parameters<StreamFn>[2];

const PROVIDER_PROMPT_ACCOUNTING_CONTEXT_KEY = Symbol.for(
  "openclaw.providerPromptAccountingContext",
);

/** Carries the provider-visible prompt surface through stream wrappers for admission only. */
export function withProviderPromptAccountingContext(
  options: ProviderStreamOptions,
  accountingContext: ProviderPromptAccountingContext,
): ProviderStreamOptions {
  return Object.assign({}, options, {
    [PROVIDER_PROMPT_ACCOUNTING_CONTEXT_KEY]: accountingContext,
  }) as ProviderStreamOptions;
}

export function readProviderPromptAccountingContext(
  options: ProviderStreamOptions,
): ProviderPromptAccountingContext | undefined {
  if (!options || typeof options !== "object") {
    return undefined;
  }
  return (options as Record<PropertyKey, unknown>)[PROVIDER_PROMPT_ACCOUNTING_CONTEXT_KEY] as
    | ProviderPromptAccountingContext
    | undefined;
}

/** Removes admission-only metadata before options reach the provider transport. */
export function withoutProviderPromptAccountingContext(
  options: NonNullable<ProviderStreamOptions>,
): NonNullable<ProviderStreamOptions> {
  const transportOptions = { ...options };
  Reflect.deleteProperty(transportOptions, PROVIDER_PROMPT_ACCOUNTING_CONTEXT_KEY);
  return transportOptions;
}
