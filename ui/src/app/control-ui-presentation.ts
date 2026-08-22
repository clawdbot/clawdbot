import {
  CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  type ControlUiEnvironment,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";

const SEAM_COLOR_CSS_VARIABLES = [
  "--ring",
  "--accent",
  "--accent-hover",
  "--accent-muted",
  "--accent-subtle",
  "--accent-glow",
  "--primary",
  "--focus",
  "--focus-ring",
  "--focus-glow",
] as const;

function applyControlUiSeamColor(value: string | undefined): void {
  const root = document.documentElement;
  const hex = value?.trim().replace(/^#/, "");
  const color = hex && /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
  if (!color) {
    for (const property of SEAM_COLOR_CSS_VARIABLES) {
      root.style.removeProperty(property);
    }
    return;
  }

  root.style.setProperty("--ring", color);
  root.style.setProperty("--accent", color);
  root.style.setProperty("--accent-hover", "color-mix(in srgb, var(--accent) 82%, white 18%)");
  root.style.setProperty("--accent-muted", color);
  root.style.setProperty("--accent-subtle", "color-mix(in srgb, var(--accent) 16%, transparent)");
  root.style.setProperty("--accent-glow", "color-mix(in srgb, var(--accent) 30%, transparent)");
  root.style.setProperty("--primary", color);
  root.style.setProperty("--focus", "color-mix(in srgb, var(--ring) 22%, transparent)");
  root.style.setProperty(
    "--focus-ring",
    "0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) 80%, transparent)",
  );
  root.style.setProperty(
    "--focus-glow",
    "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)",
  );
}

export function applyControlUiPresentation(params: {
  environment: ControlUiEnvironment | null;
  seamColor?: string;
}): void {
  applyControlUiSeamColor(params.seamColor);
  const root = document.documentElement;
  const environment = params.environment;
  if (!environment) {
    const previous = root.getAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE);
    if (previous) {
      const previousEnvironment: ControlUiEnvironment = JSON.parse(previous);
      const suffix = ` · ${previousEnvironment.label}`;
      if (document.title.endsWith(suffix)) {
        document.title = document.title.slice(0, -suffix.length);
      }
    }
    root.removeAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE);
    root.style.removeProperty("--control-ui-environment-color");
    root.style.removeProperty("--control-ui-environment-ink");
    document.querySelector(".control-ui-environment-stripe")?.remove();
    for (const icon of document.querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"][data-openclaw-original-favicon]',
    )) {
      const original: [string | null, string | null] = JSON.parse(
        icon.dataset.openclawOriginalFavicon!,
      );
      for (const [attribute, value] of [
        ["href", original[0]],
        ["type", original[1]],
      ] as const) {
        if (value === null) {
          icon.removeAttribute(attribute);
        } else {
          icon.setAttribute(attribute, value);
        }
      }
      delete icon.dataset.openclawOriginalFavicon;
    }
    return;
  }
  root.setAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE, JSON.stringify(environment));
  root.style.setProperty(
    "--control-ui-environment-color",
    `var(--control-ui-environment-${environment.color})`,
  );
  root.style.setProperty(
    "--control-ui-environment-ink",
    `var(--control-ui-environment-${environment.color}-ink)`,
  );
  if (!document.querySelector(".control-ui-environment-stripe")) {
    const stripe = document.createElement("div");
    stripe.className = "control-ui-environment-stripe";
    stripe.setAttribute("aria-hidden", "true");
    document.body.prepend(stripe);
  }
  if (!document.title.endsWith(` · ${environment.label}`)) {
    document.title = `${document.title} · ${environment.label}`;
  }

  const color = getComputedStyle(root)
    .getPropertyValue(`--control-ui-environment-${environment.color}`)
    .trim();
  if (!color) {
    return;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path fill="${color}" d="M60 10C30 10 15 35 15 55c0 20 15 40 30 45v10h10v-10h10v10h10v-10c15-5 30-25 30-45 0-20-15-45-45-45Z"/></svg>`;
  for (const icon of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    icon.dataset.openclawOriginalFavicon ??= JSON.stringify([
      icon.getAttribute("href"),
      icon.getAttribute("type"),
    ]);
    icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    icon.type = "image/svg+xml";
  }
}
