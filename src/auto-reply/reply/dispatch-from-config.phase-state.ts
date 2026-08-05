export function extendPreparedDispatchState<State extends object, Values extends object>(
  state: State,
  values: Values,
): State & Values {
  return Object.assign(state, values);
}
