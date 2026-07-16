export function matchBrowserUrlPattern(pattern: string, url: string): boolean {
  const trimmedPattern = pattern.trim();
  if (!trimmedPattern) {
    return false;
  }
  if (trimmedPattern === url) {
    return true;
  }
  if (trimmedPattern.includes("*")) {
    const escaped = trimmedPattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\*\*/g, ".*").replace(/\*/g, ".*")}$`);
    return regex.test(url);
  }
  return url.includes(trimmedPattern);
}
