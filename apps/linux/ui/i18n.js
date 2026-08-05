(() => {
  const PREFERENCE_KEY = "openclaw.i18n.locale";
  const RTL_LANGUAGES = new Set(["ar", "fa"]);
  let catalogs = { en: {} };
  let locale = "en";

  function resolveLocale(requested) {
    if (typeof requested !== "string" || requested.length > 40) {
      return null;
    }
    const normalized = requested.trim().replaceAll("_", "-");
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(normalized)) {
      return null;
    }
    const lower = normalized.toLowerCase();
    const available = Object.keys(catalogs);
    const exact = available.find((candidate) => candidate.toLowerCase() === lower);
    if (exact) {
      return exact;
    }
    const subtags = lower.split("-");
    if (subtags[0] === "zh") {
      const traditional = subtags.some((part) => ["hant", "tw", "hk", "mo"].includes(part));
      const candidate = traditional ? "zh-TW" : "zh-CN";
      return Object.hasOwn(catalogs, candidate) ? candidate : null;
    }
    return available.find((candidate) => candidate.split("-")[0].toLowerCase() === subtags[0]) ?? null;
  }

  function storedLocale() {
    try {
      return window.localStorage?.getItem(PREFERENCE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  function translate(key, fallback = key, values = {}) {
    const selected = catalogs[locale];
    const english = catalogs.en;
    const message =
      (Object.hasOwn(selected ?? {}, key) ? selected[key] : undefined) ??
      (Object.hasOwn(english ?? {}, key) ? english[key] : undefined) ??
      fallback;
    if (typeof message !== "string") {
      return fallback;
    }
    return message.replace(/\{([A-Za-z][\w]*)\}/gu, (placeholder, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : placeholder,
    );
  }

  function applyDocument() {
    document.documentElement.lang = locale;
    document.documentElement.dir = RTL_LANGUAGES.has(locale.split("-")[0]) ? "rtl" : "ltr";
    for (const element of document.querySelectorAll("[data-i18n]")) {
      element.textContent = translate(element.dataset.i18n, element.textContent);
    }
    for (const element of document.querySelectorAll("[data-i18n-attr]")) {
      for (const definition of element.dataset.i18nAttr.split(";")) {
        const separator = definition.indexOf(":");
        if (separator < 1) {
          continue;
        }
        const attribute = definition.slice(0, separator).trim();
        const key = definition.slice(separator + 1).trim();
        element.setAttribute(attribute, translate(key, element.getAttribute(attribute) ?? ""));
      }
    }
    window.dispatchEvent(new CustomEvent("openclaw:localechange", { detail: { locale } }));
  }

  function resolvePreferredLocale() {
    const preferences = [
      storedLocale(),
      ...(Array.isArray(navigator.languages) ? navigator.languages : []),
      navigator.language,
    ];
    return preferences.map(resolveLocale).find((candidate) => candidate !== null) ?? "en";
  }

  function setLocale(requested, persist = true) {
    const resolved = resolveLocale(requested);
    if (!resolved) {
      return false;
    }
    locale = resolved;
    if (persist) {
      try {
        window.localStorage?.setItem(PREFERENCE_KEY, locale);
      } catch {
        // Preferences are optional in blocked-storage WebViews.
      }
    }
    applyDocument();
    return true;
  }

  const ready = fetch("./locales.json")
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Desktop locale bundle returned HTTP ${response.status}`);
      }
      const loaded = await response.json();
      if (!loaded || typeof loaded !== "object" || Array.isArray(loaded) || !loaded.en) {
        throw new Error("Desktop locale bundle has no English fallback");
      }
      catalogs = loaded;
      locale = resolvePreferredLocale();
      applyDocument();
    })
    .catch((error) => {
      console.error("Could not load desktop localization bundle", error);
      applyDocument();
    });

  window.addEventListener("languagechange", () => {
    if (!storedLocale()) {
      setLocale(resolvePreferredLocale(), false);
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === PREFERENCE_KEY) {
      setLocale(resolvePreferredLocale(), false);
    }
  });

  window.openclawDesktopI18n = {
    get locale() {
      return locale;
    },
    ready,
    resolveLocale,
    setLocale,
    translate,
  };
})();
