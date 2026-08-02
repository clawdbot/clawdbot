const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
  macos: "macOS",
  darwin: "macOS",
  win32: "Windows",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  ipados: "iPadOS",
  watchos: "watchOS",
  android: "Android",
  web: "Web",
};

export function prettifyPlatform(platform: string): string {
  const [name = "", ...rest] = platform.trim().split(/\s+/u);
  // Mixed-case names ("iOS") are already branded; only capitalize all-lowercase input.
  const fallback =
    name === name.toLowerCase() ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
  const displayName = PLATFORM_DISPLAY_NAMES[name.toLowerCase()] ?? fallback;
  return [displayName, ...rest].join(" ");
}
