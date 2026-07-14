type CustomElementModuleLoader = () => Promise<unknown>;

const pendingLoads = new Map<string, Promise<void>>();

/** Load a custom-element module once and verify that it registered its tag. */
export function ensureCustomElementDefined(
  tagName: string,
  loadModule: CustomElementModuleLoader,
): Promise<void> {
  if (customElements.get(tagName)) {
    return Promise.resolve();
  }
  const pending = pendingLoads.get(tagName);
  if (pending) {
    return pending;
  }
  const load = Promise.resolve()
    .then(loadModule)
    .then(() => {
      if (!customElements.get(tagName)) {
        throw new Error(`Custom element module did not define ${tagName}`);
      }
    })
    .finally(() => {
      pendingLoads.delete(tagName);
    });
  pendingLoads.set(tagName, load);
  return load;
}
