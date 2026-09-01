export function assertAutomaticBindingsWriteAllowed(params: {
  bindingsIncludeOwned: boolean;
  ownershipPaths: readonly (readonly string[])[];
}): void {
  if (
    params.bindingsIncludeOwned &&
    params.ownershipPaths.some((ownershipPath) => ownershipPath[0] === "bindings")
  ) {
    throw Object.assign(
      new Error(
        "Automatic agent ownership materialization cannot append to $include-owned bindings. Add the required channel-wide binding to the include, then retry.",
      ),
      { code: "CONFIG_WRITE_REJECTED" },
    );
  }
}
