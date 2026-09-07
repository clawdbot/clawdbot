// Jsdom custom elements keeps shared-worker element registrations in step with the module graph.
//
// Shared (isolate: false) jsdom lanes re-evaluate the module graph for every test
// file, so each file gets freshly evaluated component classes. jsdom keeps custom
// element definitions on the window instead, outside that graph. Every Control UI
// component registers with `if (!customElements.get(tag))`, so a definition that
// survives the reset pins the tag to the previous file's class: the next file's
// `document.createElement(tag)` then builds elements closed over the earlier file's
// module instances, and its own singletons, module mocks, and spies are never the
// ones production reaches. Registry lifetime has to match graph lifetime.
//
// Only repo-owned tags may be dropped. Dependency packages are externalized, so
// they evaluate once per worker through native ESM and never re-register; dropping
// their definitions would leave `wa-*` and friends permanently unupgraded.

type JsdomCustomElementDefinition = { name: string };

export type CustomElementTracking = {
  registry: CustomElementRegistry;
  definitions: JsdomCustomElementDefinition[];
  repoOwnedTags: Set<string>;
};

export function jsdomCustomElementDefinitions(
  registry: object,
): JsdomCustomElementDefinition[] | undefined {
  const implKey = Object.getOwnPropertySymbols(registry).find(
    (symbol) => symbol.description === "impl",
  );
  if (!implKey) {
    return undefined;
  }
  const impl = (
    registry as Record<
      symbol,
      { _customElementDefinitions?: JsdomCustomElementDefinition[] } | undefined
    >
  )[implKey];
  return impl?._customElementDefinitions;
}

// Conservative on an unreadable stack: keeping a repo tag costs a stale class in
// one lane, dropping a dependency tag would leave it unupgraded for the whole run.
export function isRepoOwnedDefineStack(stack: string | undefined): boolean {
  // [0] "Error", [1] the patched define in this module, [2] the module calling it.
  const callerFrame = (stack ?? "").split("\n")[2] ?? "";
  return callerFrame.trim() !== "" && !/[\\/]node_modules[\\/]/u.test(callerFrame);
}

// Returns undefined for anything that is not a jsdom registry: mixed lanes run
// `@vitest-environment node` files whose leftover global has no definitions to track.
export function trackCustomElementRegistry(
  registry: CustomElementRegistry,
): CustomElementTracking | undefined {
  const definitions = jsdomCustomElementDefinitions(registry);
  if (!definitions) {
    return undefined;
  }
  const tracking: CustomElementTracking = { registry, definitions, repoOwnedTags: new Set() };
  const define = registry.define.bind(registry);
  registry.define = (name, constructor, options) => {
    if (isRepoOwnedDefineStack(new Error().stack)) {
      tracking.repoOwnedTags.add(name);
    }
    define(name, constructor, options);
  };
  return tracking;
}

export function dropRepoOwnedCustomElements(tracking: CustomElementTracking): void {
  if (tracking.repoOwnedTags.size === 0) {
    return;
  }
  const survivors = tracking.definitions.filter(
    (definition) => !tracking.repoOwnedTags.has(definition.name),
  );
  tracking.definitions.length = 0;
  tracking.definitions.push(...survivors);
  tracking.repoOwnedTags.clear();
}
