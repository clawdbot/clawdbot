export async function importRuntimeModule<T>(
  baseUrl: string,
  parts: readonly string[],
): Promise<T> {
  return (await import(new URL(parts.join(""), baseUrl).href)) as T;
}
