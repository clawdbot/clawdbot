type PreparedStateBinding = {
  get: () => unknown;
  set: (value: never) => void;
};

type PreparedStateBindingValues<Bindings extends Record<string, PreparedStateBinding>> = {
  [Key in keyof Bindings]: ReturnType<Bindings[Key]["get"]>;
};

export function extendPreparedDispatchState<
  State extends object,
  Values extends object,
  Bindings extends Record<string, PreparedStateBinding>,
>(
  state: State,
  values: Values,
  bindings: Bindings,
): State & Values & PreparedStateBindingValues<Bindings> {
  Object.assign(state, values);
  for (const [key, binding] of Object.entries(bindings)) {
    Object.defineProperty(state, key, {
      configurable: true,
      enumerable: true,
      get: binding.get,
      set: binding.set,
    });
  }
  return state as State & Values & PreparedStateBindingValues<Bindings>;
}
