/** One injection stays revoked even if its source later appears current again. */
export function createMessageInjectionAuthority(canInject: () => boolean): () => void {
  let revoked: Error | undefined;
  return () => {
    if (!revoked) {
      try {
        if (canInject()) {
          return;
        }
      } catch (cause) {
        revoked = new Error("Message injection authority is no longer current", { cause });
      }
      revoked ??= new Error("Message injection authority is no longer current");
    }
    throw revoked;
  };
}
