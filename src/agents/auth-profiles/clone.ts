import type { AuthProfileStore } from "./types.js";

export function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return JSON.parse(
    JSON.stringify(store, (_key, value: unknown) => {
      if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        throw new TypeError(`AuthProfileStore contains non-JSON value: ${typeof value}`);
      }
      return value;
    }),
  ) as AuthProfileStore;
}
