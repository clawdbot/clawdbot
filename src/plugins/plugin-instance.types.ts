/** Disposal and admission shared by instance resources and registry handles. */
export type PluginInstanceLifecycle = {
  readonly signal: AbortSignal;
  onDispose: (dispose: () => void | Promise<void>) => () => void;
};

export type PluginInstanceAdmission = {
  readonly lifecycle: PluginInstanceLifecycle;
  run<T>(run: () => T): T;
};
