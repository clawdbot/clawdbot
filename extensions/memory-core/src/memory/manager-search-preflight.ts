export function resolveMemorySearchPreflight(params: { query: string; hasIndexedContent: boolean }):
  | {
      normalizedQuery: string;
      shouldInitializeProvider: boolean;
      shouldSearch: true;
    }
  | {
      normalizedQuery: string;
      shouldInitializeProvider: false;
      shouldSearch: false;
    } {
  const normalizedQuery = params.query.trim();
  if (!normalizedQuery) {
    return {
      normalizedQuery,
      shouldInitializeProvider: false,
      shouldSearch: false,
    };
  }
  if (!params.hasIndexedContent) {
    return {
      normalizedQuery,
      shouldInitializeProvider: false,
      shouldSearch: false,
    };
  }
  return {
    normalizedQuery,
    shouldInitializeProvider: true,
    shouldSearch: true,
  };
}
