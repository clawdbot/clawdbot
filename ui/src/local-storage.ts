// Control UI module implements local storage behavior.
function isStorage(value: unknown): value is Storage {
  return (
    Boolean(value) &&
    typeof (value as Storage).getItem === "function" &&
    typeof (value as Storage).setItem === "function"
  );
}

function getSafeStorage(name: "localStorage" | "sessionStorage"): Storage | null {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);

  if (typeof process !== "undefined" && process.env?.VITEST) {
    return descriptor && !descriptor.get && isStorage(descriptor.value) ? descriptor.value : null;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const storage = window[name];
      return isStorage(storage) ? storage : null;
    } catch {
      return null;
    }
  }

  return descriptor && !descriptor.get && isStorage(descriptor.value) ? descriptor.value : null;
}

export function getSafeLocalStorage(): Storage | null {
  return getSafeStorage("localStorage");
}

export function getSafeSessionStorage(): Storage | null {
  return getSafeStorage("sessionStorage");
}
