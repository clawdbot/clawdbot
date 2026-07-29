// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper preserves plugin-specific hook API type.
export function registerHookHandlersForTest<TApi>(params: {
  config: Record<string, unknown>;
  register: (api: TApi) => void;
}) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const api = {
    config: params.config,
    on: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(hookName, handler);
    },
  } as TApi;
  params.register(api);
  return handlers;
}

export function getRequiredHookHandler(
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
  hookName: string,
): (event: unknown, ctx: unknown) => unknown {
  const handler = handlers.get(hookName);
  if (!handler) {
    throw new Error(`expected ${hookName} hook handler`);
  }
  return handler;
}
