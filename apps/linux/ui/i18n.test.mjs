import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./i18n.js", import.meta.url), "utf8");
const bundle = JSON.parse(readFileSync(new URL("./locales.json", import.meta.url), "utf8"));
const definitions = JSON.parse(readFileSync(new URL("./messages.json", import.meta.url), "utf8"));

function createElement(textContent, dataset = {}, attributes = {}) {
  return {
    dataset,
    textContent,
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    setAttribute(name, value) {
      attributes[name] = value;
    },
  };
}

async function createRuntime({
  language = "en-US",
  languages = [language],
  stored = null,
  textNodes = [],
  attributeNodes = [],
  catalogs = bundle,
} = {}) {
  const events = [];
  const listeners = new Map();
  const saved = new Map(stored === null ? [] : [["openclaw.i18n.locale", stored]]);
  const document = {
    documentElement: { lang: "en", dir: "ltr" },
    querySelectorAll(selector) {
      return selector === "[data-i18n]" ? textNodes : attributeNodes;
    },
  };
  const window = {
    localStorage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
    addEventListener: (name, listener) => listeners.set(name, listener),
    dispatchEvent: (event) => events.push(event),
  };
  const context = {
    console,
    document,
    fetch: async () => ({ ok: true, json: async () => catalogs }),
    navigator: { language, languages },
    window,
    CustomEvent: function CustomEvent(type, options) {
      return { type, detail: options.detail };
    },
  };
  vm.runInNewContext(source, context, { filename: "apps/linux/ui/i18n.js" });
  await window.openclawDesktopI18n.ready;
  return { document, events, i18n: window.openclawDesktopI18n, listeners, saved };
}

test("desktop locale bundle reuses actual German and French shared translations", async () => {
  const connected = createElement("Connected", { i18n: "common.connected" });
  const send = createElement("", { i18nAttr: "aria-label:common.connected" }, {
    "aria-label": "Connected",
  });
  const german = await createRuntime({
    language: "de-DE",
    textNodes: [connected],
    attributeNodes: [send],
  });
  assert.equal(german.i18n.locale, "de");
  assert.equal(german.document.documentElement.lang, "de");
  assert.equal(connected.textContent, "Verbunden");
  assert.equal(send.getAttribute("aria-label"), "Verbunden");

  const french = await createRuntime({ language: "fr-CA" });
  assert.equal(french.i18n.translate("common.connected", "Connected"), "Connecté");
});

test("unsupported and untranslated messages fall back to the canonical English source", async () => {
  const runtime = await createRuntime({ language: "de-DE" });
  const englishOnly = Object.keys(bundle.en).find((key) => !Object.hasOwn(bundle.de, key));
  assert.ok(englishOnly, "fixture includes an untranslated desktop-specific message");
  assert.equal(runtime.i18n.translate(englishOnly), bundle.en[englishOnly]);
  assert.equal(runtime.i18n.translate("desktop.missing", "Explicit fallback"), "Explicit fallback");

  const unsupported = await createRuntime({ language: "eo" });
  assert.equal(unsupported.i18n.locale, "en");
});

test("locale normalization resolves regional variants and traditional Chinese correctly", async () => {
  const portuguese = await createRuntime({ language: "pt_BR" });
  assert.equal(portuguese.i18n.locale, "pt-BR");
  assert.equal(portuguese.i18n.resolveLocale("pt-PT"), "pt-BR");

  const traditional = await createRuntime({ language: "zh-Hant-HK" });
  assert.equal(traditional.i18n.locale, "zh-TW");
  assert.equal(traditional.i18n.resolveLocale("zh_HK"), "zh-TW");
  assert.equal(traditional.i18n.resolveLocale("zh-Hans-SG"), "zh-CN");
  assert.equal(traditional.i18n.resolveLocale("ja"), "ja-JP");
});

test("Arabic and Persian set right-to-left direction and other locales restore left-to-right", async () => {
  for (const language of ["ar-EG", "fa-IR"]) {
    const runtime = await createRuntime({ language });
    assert.equal(runtime.document.documentElement.dir, "rtl");
    assert.equal(runtime.i18n.setLocale("de"), true);
    assert.equal(runtime.document.documentElement.dir, "ltr");
  }
});

test("hostile or invalid locale identifiers cannot select paths or object prototypes", async () => {
  const runtime = await createRuntime({ language: "de-DE", stored: "../../etc/passwd" });
  assert.equal(runtime.i18n.locale, "de");
  for (const invalid of ["../../etc/passwd", "__proto__", "constructor", "zh/../../de", "de\0DE"]) {
    assert.equal(runtime.i18n.resolveLocale(invalid), null);
    assert.equal(runtime.i18n.setLocale(invalid), false);
  }
  assert.equal(runtime.i18n.translate("constructor", "safe"), "safe");
  assert.equal(runtime.i18n.translate("__proto__", "safe"), "safe");
});

test("interpolation preserves zero, substitutes named parameters, and retains absent parameters", async () => {
  const runtime = await createRuntime({ language: "de" });
  assert.equal(
    runtime.i18n.translate("desktop.main.discoveryFound", "{count} FOUND", { count: 0 }),
    bundle.de["desktop.main.discoveryFound"]?.replace("{count}", "0") ?? "0 FOUND",
  );
  assert.equal(
    runtime.i18n.translate("desktop.tray.status", "Gateway: {status}", { status: "bereit" }),
    (bundle.de["desktop.tray.status"] ?? "Gateway: {status}").replace("{status}", "bereit"),
  );
  assert.equal(runtime.i18n.translate("desktop.missing", "Hello {name}"), "Hello {name}");
});

test("locale changes update static labels without overwriting dynamically owned application state", async () => {
  const staticLabel = createElement("Connected", { i18n: "common.connected" });
  const liveAgentName = createElement("Peter's real agent");
  const liveGatewayTitle = createElement("Gateway reconnecting now");
  const runtime = await createRuntime({ language: "en", textNodes: [staticLabel] });
  assert.equal(runtime.i18n.setLocale("de"), true);
  assert.equal(staticLabel.textContent, "Verbunden");
  assert.equal(liveAgentName.textContent, "Peter's real agent");
  assert.equal(liveGatewayTitle.textContent, "Gateway reconnecting now");
  assert.equal(runtime.saved.get("openclaw.i18n.locale"), "de");
});

test("every static desktop localization key exists in the bounded canonical bundle", () => {
  assert.ok(Object.keys(bundle).length >= 21);
  for (const [key, definition] of Object.entries(definitions)) {
    assert.ok(definition.defaultMessage.length > 0, `${key} default message`);
    assert.ok(definition.description.length > 0, `${key} translator description`);
    assert.equal(bundle.en[key], definition.defaultMessage, `${key} English bundle entry`);
  }
  for (const filename of ["index.html", "quickchat.html"]) {
    const html = readFileSync(new URL(`./${filename}`, import.meta.url), "utf8");
    for (const match of html.matchAll(/data-i18n="([^"]+)"/gu)) {
      assert.ok(Object.hasOwn(bundle.en, match[1]), `${filename}: ${match[1]}`);
    }
    for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/gu)) {
      for (const attribute of match[1].split(";")) {
        const key = attribute.slice(attribute.indexOf(":") + 1);
        assert.ok(Object.hasOwn(bundle.en, key), `${filename}: ${key}`);
      }
    }
  }
});

test("all locale-specific tray plural categories remain independent canonical messages", () => {
  const inventory = JSON.parse(
    readFileSync(new URL("../../.i18n/native-source.json", import.meta.url), "utf8"),
  );
  const ids = new Set();
  for (const category of ["zero", "one", "two", "few", "many", "other"]) {
    const key = `desktop.tray.pending.${category}`;
    const definition = definitions[key];
    assert.ok(definition, `${category} canonical source definition`);
    assert.equal(bundle.en[key], definition.defaultMessage, `${category} bundled English fallback`);
    assert.ok(definition.description.length > 0, `${category} translator context`);
    assert.ok(definition.defaultMessage.includes("{status}"), `${category} gateway status`);
    if (category !== "one") {
      assert.ok(definition.defaultMessage.includes("{count}"), `${category} approval count`);
    }

    const owner = inventory.entries.find(
      (entry) => entry.surface === "linux" && entry.semanticKey === key,
    );
    assert.ok(owner, `${category} native translation owner`);
    assert.equal(owner.source, definition.defaultMessage);
    assert.equal(owner.description, definition.description);
    ids.add(owner.id);
  }
  assert.equal(ids.size, 6, "identical English defaults never collapse distinct grammatical forms");
});

test("identical English text never imports a translation from another semantic context", () => {
  const inventory = JSON.parse(
    readFileSync(new URL("../../.i18n/native-source.json", import.meta.url), "utf8"),
  );
  const german = JSON.parse(
    readFileSync(new URL("../../.i18n/native/de.json", import.meta.url), "utf8"),
  );
  const key = "desktop.common.agent";
  const owner = inventory.entries.find(
    (entry) => entry.surface === "linux" && entry.semanticKey === key,
  );
  const translated = german.entries.find(
    (entry) => entry.id === owner?.id && entry.source === owner?.source,
  );

  // The web catalog also contains the English word "Agent" for an agent ID, translated as
  // "Agent-ID". Matching that English text would silently assign the wrong meaning here.
  assert.equal(bundle.de[key], translated?.translated);
  assert.notEqual(bundle.de[key], "Agent-ID");
});

test("source verification rejects stale English but permits translation-only refresh drift", () => {
  const moduleUrl = new URL("./generate-locales.ts", import.meta.url).href;
  const probe = `
    import assert from "node:assert/strict";
    import { isDesktopLocaleSourceCurrent } from ${JSON.stringify(moduleUrl)};

    const expected = {
      en: { "common.connected": "Connected", "desktop.greeting": "Hello {name}" },
      de: { "common.connected": "Verbunden" },
    };
    const source = { ...expected.en };

    assert.equal(
      isDesktopLocaleSourceCurrent({ en: source, de: { "common.connected": "Anders" } }, expected),
      true,
      "translation-only drift stays owned by the asynchronous locale refresh",
    );
    assert.equal(isDesktopLocaleSourceCurrent(null, expected), false, "missing bundle");
    assert.equal(isDesktopLocaleSourceCurrent({ de: {} }, expected), false, "missing English fallback");
    assert.equal(
      isDesktopLocaleSourceCurrent({ en: { ...source, "desktop.extra": "Extra" } }, expected),
      false,
      "extra English source key",
    );
    assert.equal(
      isDesktopLocaleSourceCurrent({ en: { "common.connected": "Connected" } }, expected),
      false,
      "missing English source key",
    );
    assert.equal(
      isDesktopLocaleSourceCurrent({ en: { ...source, "common.connected": "Changed" } }, expected),
      false,
      "changed English source text",
    );
    assert.equal(isDesktopLocaleSourceCurrent({ en: source, de: [] }, expected), false);
    assert.equal(isDesktopLocaleSourceCurrent({ en: source, de: { key: 4 } }, expected), false);
    assert.equal(
      isDesktopLocaleSourceCurrent({ en: source, de: { "desktop.greeting": "Hallo" } }, expected),
      false,
      "malformed translation placeholders cannot produce a runnable bundle",
    );
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
