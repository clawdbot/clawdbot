/**
 * Control UI custom properties published to embedded MCP apps, keyed by the
 * specification variable they satisfy. The key set is closed by the MCP Apps
 * specification, so an OpenClaw name can never be added here; the canonical
 * meaning of each key lives in the carapace embed contract.
 *
 * Only keys Control UI can honestly source are listed. The specification lets
 * a host publish any subset, and an app resolves the rest from its own
 * fallbacks, so omitting a key is preferable to inventing a value for it.
 */
const HOST_TOKEN_SOURCES = {
  "--color-background-primary": "--card",
  "--color-background-secondary": "--bg",
  "--color-background-tertiary": "--bg-elevated",
  "--color-background-inverse": "--text",
  "--color-background-disabled": "--bg-muted",
  "--color-background-success": "--ok-subtle",
  "--color-background-warning": "--warn-subtle",
  "--color-background-danger": "--danger-subtle",

  "--color-text-primary": "--text",
  "--color-text-secondary": "--muted-strong",
  "--color-text-tertiary": "--muted",
  "--color-text-inverse": "--bg",
  "--color-text-success": "--ok",
  "--color-text-warning": "--warn",
  "--color-text-danger": "--danger",
  "--color-text-info": "--info",

  "--color-border-primary": "--border",
  "--color-border-secondary": "--border-strong",
  // Inverse borders sit on the inverse background, so they use its foreground.
  "--color-border-inverse": "--bg",
  "--color-ring-primary": "--ring",

  /*
   * Only the monospace stack is published. Control UI's body font leads with a
   * webfont, and an embedded app cannot load it: the sandbox policy allows
   * font requests only from resource domains the app itself declares. Sending
   * it would resolve to an arbitrary system face instead of failing visibly.
   * The monospace stack degrades correctly because its fallbacks are system
   * faces. Apps supply their own sans stack until Control UI adopts the
   * carapace embed tokens, which define a sandbox-safe one.
   */
  "--font-mono": "--mono",

  "--font-text-xs-size": "--control-ui-text-xs",
  "--font-text-sm-size": "--control-ui-text-sm",
  "--font-text-md-size": "--control-ui-text-md",
  "--font-text-lg-size": "--control-ui-text-lg",

  "--border-radius-xs": "--radius-sm",
  "--border-radius-sm": "--radius-sm",
  "--border-radius-md": "--radius",
  "--border-radius-lg": "--radius-lg",
  "--border-radius-xl": "--radius-xl",
  "--border-radius-full": "--radius-full",

  "--shadow-sm": "--shadow-sm",
  "--shadow-md": "--shadow-md",
  "--shadow-lg": "--shadow-lg",
} as const;

/** Values with no Control UI source, fixed by the specification's own scale. */
const STATIC_VARIABLES = {
  "--border-width-regular": "1px",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
} as const;

type StyleVariableKey = keyof typeof HOST_TOKEN_SOURCES | keyof typeof STATIC_VARIABLES;
type StyleVariables = Partial<Record<StyleVariableKey, string>>;

/**
 * Snapshot the current theme as MCP Apps style variables.
 *
 * Values are read as computed custom properties, which substitutes nested
 * `var()` references and leaves a self-contained value. That matters because
 * the app document is a separate origin: an unresolved reference to a Control
 * UI token would have nothing to resolve against once it crosses the boundary.
 */
export function collectMcpAppStyleVariables(
  root: HTMLElement | undefined = document.documentElement,
): StyleVariables | undefined {
  if (!root) {
    return undefined;
  }
  const computed = getComputedStyle(root);
  const variables: Record<string, string> = { ...STATIC_VARIABLES };
  for (const [specKey, hostToken] of Object.entries(HOST_TOKEN_SOURCES)) {
    const value = computed.getPropertyValue(hostToken).trim();
    if (value) {
      variables[specKey] = value;
    }
  }
  return variables as StyleVariables;
}
