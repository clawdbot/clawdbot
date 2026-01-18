export type ManagerLookupResult<T> = {
  manager: T | null;
  error?: string;
};

export function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function withManager<T>(params: {
  getManager: () => Promise<ManagerLookupResult<T>>;
  onMissing: (error?: string) => void;
  run: (manager: T) => Promise<void>;
  close: (manager: T) => Promise<void>;
  onCloseError?: (err: unknown) => void;
}): Promise<void> {
  const { manager, error } = await params.getManager();
  if (!manager) {
    params.onMissing(error);
    return;
  }
  try {
    await params.run(manager);
  } finally {
    try {
      await params.close(manager);
    } catch (err) {
      params.onCloseError?.(err);
    }
  }
}
