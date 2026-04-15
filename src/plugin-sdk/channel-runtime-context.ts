const contexts = new Map<string, unknown>();

export function registerChannelRuntimeContext<T>(key: string, value: T): () => void {
  contexts.set(key, value);
  return () => {
    if (contexts.get(key) === value) {
      contexts.delete(key);
    }
  };
}

export function getChannelRuntimeContext<T>(key: string): T | undefined {
  return contexts.get(key) as T | undefined;
}

export function clearChannelRuntimeContext(key: string): void {
  contexts.delete(key);
}
