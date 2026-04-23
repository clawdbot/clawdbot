export type FatalErrorHookContext = {
  reason: string;
  error?: unknown;
};

export type FatalErrorHook = (context: FatalErrorHookContext) => string | undefined | void;

const hooks = new Set<FatalErrorHook>();

function formatHookFailure(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : "unknown";
  return `fatal-error hook failed: ${name}`;
}

export function registerFatalErrorHook(hook: FatalErrorHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

export function runFatalErrorHooks(context: FatalErrorHookContext): string[] {
  const messages: string[] = [];
  for (const hook of hooks) {
    try {
      const message = hook(context);
      if (typeof message === "string" && message.trim()) {
        messages.push(message);
      }
    } catch (err) {
      messages.push(formatHookFailure(err));
    }
  }
  return messages;
}

export function resetFatalErrorHooksForTest(): void {
  hooks.clear();
}
