/** Context passed to fatal-error hooks before the process exits. */
type FatalErrorHookContext = {
  reason: string;
  error?: unknown;
};

/** Hook that can return one extra diagnostic line for fatal error output. */
type FatalErrorHook = (context: FatalErrorHookContext) => string | undefined | void;

const hooks = new Set<FatalErrorHook>();

function formatHookFailure(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : "unknown";
  return `fatal-error hook failed: ${name}`;
}

/** Registers a fatal-error hook and returns an unsubscribe callback. */
export function registerFatalErrorHook(hook: FatalErrorHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Runs registered fatal-error hooks and returns non-empty diagnostic lines. */
export function runFatalErrorHooks(context: FatalErrorHookContext): string[] {
  const messages: string[] = [];
  for (const hook of hooks) {
    try {
      const message = hook(context);
      if (typeof message === "string" && message.trim()) {
        messages.push(message);
      }
    } catch (err) {
      // Fatal output must keep progressing even if a diagnostic hook itself throws.
      messages.push(formatHookFailure(err));
    }
  }
  return messages;
}

/** Clears registered fatal-error hooks; test-only helper. */
export function resetFatalErrorHooksForTest(): void {
  hooks.clear();
}
