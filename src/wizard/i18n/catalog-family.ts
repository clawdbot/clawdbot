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

export function optionalCatalogFamily(
  messages: Readonly<Record<string, string>>,
  namespace: string,
  fallback?: {
    sourceMessages: Readonly<Record<string, string>>;
    translatedSourceMessages: Readonly<Record<string, string>>;
  },
): Readonly<Record<string, string>> {
  const translated = readCatalogFamily(messages, namespace);
  if (!fallback) {
    return translated;
  }
  const source = readCatalogFamily(fallback.sourceMessages, namespace);
  const translatedSource = readCatalogFamily(fallback.translatedSourceMessages, namespace);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source).map(([key, value]) => [
        key,
        translated[key] !== undefined && translatedSource[key] === value ? translated[key] : value,
      ]),
    ),
  );
}
