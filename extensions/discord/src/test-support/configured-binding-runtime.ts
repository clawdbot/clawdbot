type ConfiguredBindingConversationRuntimeModule = {
  ensureConfiguredBindingRouteReady: (...args: never[]) => unknown;
  resolveConfiguredBindingRoute: (...args: never[]) => unknown;
};

export async function createConfiguredBindingConversationRuntimeModuleMock<
  TModule extends ConfiguredBindingConversationRuntimeModule,
>(
  params: {
    ensureConfiguredBindingRouteReadyMock: (
      ...args: Parameters<TModule["ensureConfiguredBindingRouteReady"]>
    ) => ReturnType<TModule["ensureConfiguredBindingRouteReady"]>;
    resolveConfiguredBindingRouteMock: (
      ...args: Parameters<TModule["resolveConfiguredBindingRoute"]>
    ) => ReturnType<TModule["resolveConfiguredBindingRoute"]>;
  },
  loadActual: () => Promise<TModule>,
) {
  const actual = await loadActual();
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: (
      ...args: Parameters<TModule["ensureConfiguredBindingRouteReady"]>
    ) => params.ensureConfiguredBindingRouteReadyMock(...args),
    resolveConfiguredBindingRoute: (
      ...args: Parameters<TModule["resolveConfiguredBindingRoute"]>
    ) => params.resolveConfiguredBindingRouteMock(...args),
  } satisfies TModule;
}
