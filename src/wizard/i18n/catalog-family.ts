function readCatalogFamily(
  messages: Readonly<Record<string, string>>,
  namespace: string,
): Readonly<Record<string, string>> {
  const prefix = `${namespace}.`;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(messages)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value] as const),
    ),
  );
}

export function catalogFamily(
  messages: Readonly<Record<string, string>>,
  namespace: string,
): Readonly<Record<string, string>> {
  const family = readCatalogFamily(messages, namespace);
  if (Object.keys(family).length === 0) {
    throw new Error(`catalog has no messages under ${namespace}`);
  }
  return family;
}

export const optionalCatalogFamily = readCatalogFamily;
