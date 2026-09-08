export type ProviderLocalServiceReconcileContext = {
  baseUrl: string;
  signal?: AbortSignal;
};

export type ProviderLocalServiceReconciler = (
  ctx: ProviderLocalServiceReconcileContext,
) => Promise<void>;

const MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL = Symbol.for(
  "openclaw.modelProviderLocalServiceReconciler",
);

type ModelWithProviderLocalServiceReconciler = {
  [MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL]?: ProviderLocalServiceReconciler;
};

/** Carry the prepared provider's reconcile hook through the model transport boundary. */
export function attachModelProviderLocalServiceReconciler<TModel extends object>(
  model: TModel,
  reconcile: ProviderLocalServiceReconciler | undefined,
): TModel {
  // SAFETY: the spread preserves TModel; the intersection exposes only the symbol assigned below.
  const next = { ...model } as TModel & ModelWithProviderLocalServiceReconciler;
  next[MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL] = reconcile;
  return next;
}

export function getModelProviderLocalServiceReconciler(
  model: object,
): ProviderLocalServiceReconciler | undefined {
  // SAFETY: only the attach helper writes this optional symbol; absent carriers read as undefined.
  return (model as ModelWithProviderLocalServiceReconciler)[
    MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL
  ];
}
