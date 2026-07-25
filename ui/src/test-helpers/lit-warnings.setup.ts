// Lit emits a one-time dev-mode warning in test builds. Pre-mark it as issued
// so broad UI suites stay signal-heavy instead of repeating the same console.warn.
const issuedWarnings = ((globalThis as { litIssuedWarnings?: Set<string> }).litIssuedWarnings ??=
  new Set<string>());

issuedWarnings.add("dev-mode");

// Web Awesome resolves `for` targets while Lit content is still in a detached
// render root. The app renders into a connected root; JSDOM unit helpers do not.
const findElementById = (root: ParentNode, id: string) =>
  [...root.querySelectorAll<HTMLElement>("[id]")].find((element) => element.id === id) ?? null;

if (typeof DocumentFragment !== "undefined" && !("getElementById" in DocumentFragment.prototype)) {
  Object.defineProperty(DocumentFragment.prototype, "getElementById", {
    configurable: true,
    value(this: DocumentFragment, id: string) {
      return findElementById(this, id);
    },
  });
}

if (typeof Element !== "undefined" && !("getElementById" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getElementById", {
    configurable: true,
    value(this: Element, id: string) {
      return findElementById(this, id);
    },
  });
}

// JSDOM has no Web Animations API. Web Awesome uses this probe to skip
// animations when none are active.
if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
}

// JSDOM exposes partial ElementInternals. Web Awesome form controls require
// the form-associated methods even when tests do not mount them in a form.
if (typeof HTMLElement !== "undefined") {
  Object.defineProperty(HTMLElement.prototype, "attachInternals", {
    configurable: true,
    value() {
      const validity = { valid: true } as ValidityState;
      return {
        checkValidity: () => true,
        form: null,
        labels: null,
        reportValidity: () => true,
        setFormValue: () => {},
        setValidity: () => {},
        states: new Set<string>(),
        validationMessage: "",
        validity,
        willValidate: true,
      };
    },
  });
}

if (typeof HTMLDialogElement !== "undefined" && !("showModal" in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
}

if (typeof HTMLDialogElement !== "undefined" && !("close" in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
}

// Node 25+ enables WebStorage by default with a global localStorage getter
// that is dead without --localstorage-file (undefined on 26.5, reported to
// throw or return an inert proxy on other 25/26 releases). During jsdom
// global population it shadows the DOM Storage (globalThis is the window),
// so storage-touching tests crash on newer local Node while Linux CI
// (Node 24, no default WebStorage) passes. Capability-probe instead of
// trusting any one shape, then install an in-memory Storage.
function globalLocalStorageIsUsable(): boolean {
  try {
    const existing = globalThis.localStorage;
    if (!existing) {
      return false;
    }
    existing.setItem("__openclaw_probe__", "1");
    const roundTrips = existing.getItem("__openclaw_probe__") === "1";
    existing.removeItem("__openclaw_probe__");
    return roundTrips;
  } catch {
    return false;
  }
}

function usableWindowLocalStorage(): Storage | null {
  try {
    const candidate = window.localStorage;
    if (!candidate) {
      return null;
    }
    candidate.setItem("__openclaw_probe__", "1");
    const roundTrips = candidate.getItem("__openclaw_probe__") === "1";
    candidate.removeItem("__openclaw_probe__");
    return roundTrips ? candidate : null;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined" && !globalLocalStorageIsUsable()) {
  const backing = new Map<string, string>();
  // Prefer jsdom's own Storage when only the global alias is dead so
  // `localStorage` and `window.localStorage` stay the same object.
  const storage: Storage = usableWindowLocalStorage() ?? {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
  const install = (target: object) =>
    Object.defineProperty(target, "localStorage", {
      configurable: true,
      enumerable: false,
      get: () => storage,
    });
  install(globalThis);
  if ((window as unknown) !== globalThis) {
    install(window);
  }
}
