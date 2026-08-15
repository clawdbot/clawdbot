const source = { id: "fixture" };
const widened: unknown = source;
widened as { readonly id: string };
