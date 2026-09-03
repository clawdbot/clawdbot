import path from "node:path";

// Resolve against published pages, not URLs with a hosting base prefix. Markdown
// objects are always written at pageMarkdownRoute, even for base-path builds.
/** @public Consumed by openclaw/docs build.mjs through the docs-sync support contract. */
export function resolveRedirects({
  redirects,
  pages,
  localeCodes,
  prefixes,
  publicPath,
  knownLocales = localeCodes,
  onError,
}) {
  const rules = new Map();
  for (const { source, destination } of redirects) {
    const route = redirectSource(source);
    const dest = redirectDestination(destination);
    if (rules.has(route) && rules.get(route).value !== dest.value) {
      throw new Error(
        `Conflicting redirect rules for ${route}: ${rules.get(route).value} and ${dest.value}`,
      );
    }
    rules.set(route, dest);
  }
  for (const prefix of prefixes) {
    redirectSource(prefix);
  }
  const knownLocaleCodes = new Set([...knownLocales, ...localeCodes]);
  const pageByRoute = new Map();
  for (const page of pages) {
    pageByRoute.set(page.route, page);
    if (page.route === "/") {
      pageByRoute.set("/index", page);
    } else {
      pageByRoute.set(`${page.route}/index`, page);
    }
  }
  const splitLocale = (route) => {
    const first = route.split("/")[1];
    return knownLocaleCodes.has(first)
      ? { locale: first, route: route.slice(first.length + 1) || "/" }
      : { locale: undefined, route };
  };
  const localized = (route, locale) =>
    locale === "en" ? route : `/${locale}${route === "/" ? "" : route}`;

  function resolve(source, preferredLocale) {
    let route = source;
    let locale = preferredLocale;
    let query = "";
    let fragment = "";
    const visited = new Set();
    while (true) {
      const explicit = splitLocale(route);
      if (explicit.locale !== undefined) {
        locale = explicit.locale;
      }
      const localRoute = localized(explicit.route, locale);
      const page = pageByRoute.get(localRoute) ?? pageByRoute.get(explicit.route);
      // The writer skips existing source HTML. Emitted aliases follow their
      // configured rule once, then actual terminal pages win over further rules.
      if (page && visited.size > 0) {
        return {
          destination: publicPath(page.route) + query + fragment,
          markdownTarget: page.markdownRoute + query + fragment,
        };
      }
      const ruleRoute = explicit.locale === undefined ? localRoute : route;
      if (visited.has(ruleRoute)) {
        throw new Error(`Redirect cycle: ${[...visited, ruleRoute].join(" -> ")}`);
      }
      visited.add(ruleRoute);
      const dest = rules.get(ruleRoute) ?? rules.get(explicit.route);
      if (!dest) {
        throw new Error(`Redirect has no terminal Markdown page: ${[...visited].join(" -> ")}`);
      }
      if (dest.external) {
        return { destination: dest.value };
      }
      if (dest.query !== undefined) {
        query = dest.query;
      }
      if (dest.fragment !== undefined) {
        fragment = dest.fragment;
      }
      // Exact page routes can contain dots (e.g. AGENTS.default). Other file
      // destinations retain HTML behavior without inventing Markdown objects.
      const next = splitLocale(dest.pathname);
      const nextLocale = next.locale ?? locale;
      if (
        path.posix.extname(next.route) &&
        !pageByRoute.has(localized(next.route, nextLocale)) &&
        !pageByRoute.has(next.route) &&
        !rules.has(dest.pathname)
      ) {
        return { destination: publicPath(dest.pathname) + query + fragment };
      }
      route = dest.pathname;
    }
  }

  const records = new Map();
  for (const source of [...rules.keys()].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const explicit = splitLocale(source);
    const variants = explicit.locale === undefined ? [...localeCodes] : [explicit.locale];
    for (const locale of variants) {
      const alias = explicit.locale === undefined ? localized(explicit.route, locale) : source;
      // Explicit locale rules own their route over automatically localized rules.
      if (alias !== source && rules.has(alias)) {
        continue;
      }
      let resolved;
      try {
        resolved = resolve(alias, locale);
      } catch (error) {
        if (!onError) {
          throw error;
        }
        onError(alias, error);
        continue;
      }
      for (const prefix of ["", ...prefixes]) {
        const route = redirectSource(`${prefix}${alias}`);
        const record = { source: route, ...resolved };
        const previous = records.get(route);
        if (
          previous &&
          (previous.destination !== record.destination ||
            previous.markdownTarget !== record.markdownTarget)
        ) {
          throw new Error(
            `Conflicting generated redirects for ${route}: ${previous.destination} and ${record.destination}`,
          );
        }
        records.set(route, record);
      }
    }
  }
  return [...records.values()].toSorted((a, b) => a.source.localeCompare(b.source));
}

function redirectSource(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[?#]/u.test(value)
  ) {
    throw new Error(`Unsupported redirect source: ${value}`);
  }
  validatePath(value);
  return value.replace(/\/$/u, "") || "/";
}

function redirectDestination(value) {
  if (typeof value !== "string" || hasUnsafeRedirectCharacters(value)) {
    throw new Error(`Unsupported redirect destination: ${value}`);
  }
  if (/^(https?:)?\/\//u.test(value)) {
    return { value, external: true };
  }
  if (!value.startsWith("/")) {
    throw new Error(`Unsupported redirect destination: ${value}`);
  }
  const [, pathname, query, fragment] = value.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/u);
  validatePath(pathname);
  return { value, pathname: pathname.replace(/\/$/u, "") || "/", query, fragment };
}

function validatePath(value) {
  if (hasUnsafeRedirectCharacters(value) || value.includes(":")) {
    throw new Error(`Unsafe redirect path: ${value}`);
  }
  for (const segment of value.split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`Unsafe redirect path: ${value}`);
    }
    if (decoded === "." || decoded === ".." || /[/\\]/u.test(decoded)) {
      throw new Error(`Unsafe redirect path: ${value}`);
    }
  }
}

function hasUnsafeRedirectCharacters(value) {
  // Reject raw C0/space and HTML/path metacharacters before URL normalization
  // or generated HTML can change their meaning.
  return [...value].some(
    (character) => character.charCodeAt(0) <= 0x20 || "<>\\*".includes(character),
  );
}
