const source = { id: "fixture" };
const widened: unknown = source;
widened as { readonly id: string };

const nestedSource = { id: "nested" };
const nestedWidened: unknown = nestedSource;
nestedWidened as unknown as { readonly id: string };

const aliasSource = { id: "alias" };
const aliasWidened: unknown = aliasSource;
const firstAlias = aliasWidened;
const alias = firstAlias;
alias as { readonly id: string };
