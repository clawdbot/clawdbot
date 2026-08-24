const ACCENT_CSS_VARIABLES = [
  "--ring",
  "--accent",
  "--accent-foreground",
  "--accent-hover",
  "--accent-muted",
  "--accent-subtle",
  "--accent-glow",
  "--primary",
  "--primary-hover",
  "--primary-foreground",
  "--focus",
  "--focus-ring",
  "--focus-glow",
] as const;

let operatorSeamColor: string | undefined;
let userAccentOverride: string | undefined;

export function applyControlUiAccent(userAccent?: string): void {
  userAccentOverride = userAccent;
  const root = document.documentElement;
  const hex = (userAccentOverride ?? operatorSeamColor)?.trim().replace(/^#/, "");
  const color = hex && /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
  if (!color) {
    for (const property of ACCENT_CSS_VARIABLES) {
      root.style.removeProperty(property);
    }
    return;
  }

  const linearChannel = (offset: number) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
  // Black and white reach equal WCAG contrast at relative luminance 0.179.
  const ink = luminance > 0.179 ? "#000000" : "#ffffff";
  const mix = (variable: string, amount: number) =>
    `color-mix(in srgb, var(${variable}) ${amount}%, transparent)`;

  for (const property of ["--ring", "--accent", "--accent-muted", "--primary"]) {
    root.style.setProperty(property, color);
  }
  for (const property of ["--accent-foreground", "--primary-foreground"]) {
    root.style.setProperty(property, ink);
  }
  root.style.setProperty("--accent-hover", "color-mix(in srgb, var(--accent) 82%, white 18%)");
  root.style.setProperty("--primary-hover", "color-mix(in srgb, var(--primary) 82%, white 18%)");
  root.style.setProperty("--accent-subtle", mix("--accent", 16));
  root.style.setProperty("--accent-glow", mix("--accent", 30));
  root.style.setProperty("--focus", mix("--ring", 22));
  root.style.setProperty("--focus-ring", `0 0 0 2px var(--bg), 0 0 0 3px ${mix("--ring", 80)}`);
  root.style.setProperty(
    "--focus-glow",
    "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)",
  );
}

export function applyControlUiOperatorSeamColor(seamColor?: string): void {
  operatorSeamColor = seamColor;
  applyControlUiAccent(userAccentOverride);
}
