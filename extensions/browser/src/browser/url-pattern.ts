function wildcardPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += char.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&");
  }
  source += "$";
  return new RegExp(source, "u");
}

export function matchBrowserUrlPattern(pattern: string, url: string): boolean {
  const trimmedPattern = pattern.trim();
  if (!trimmedPattern) {
    return false;
  }
  if (trimmedPattern === url) {
    return true;
  }
  if (trimmedPattern === "*") {
    return true;
  }
  if (trimmedPattern.includes("*")) {
    return wildcardPatternToRegExp(trimmedPattern).test(url);
  }
  return url.includes(trimmedPattern);
}
