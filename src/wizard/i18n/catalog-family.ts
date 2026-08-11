export function catalogFamily(
  messages: Readonly<Record<string, string>>,
  namespace: string,
): Readonly<Record<string, string>> {
  const prefix = `${namespace}.`;
  const entries = Object.entries(messages)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value] as const);
  if (entries.length === 0) {
    throw new Error(`catalog has no messages under ${namespace}`);
  }
  return Object.freeze(Object.fromEntries(entries));
}
