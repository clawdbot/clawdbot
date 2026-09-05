import type { Locator } from "playwright";

export type RenderedColor = { red: number; green: number; blue: number; alpha: number };

// Pass directly to Playwright evaluate: CSS Color 4 and transition Oklab values
// need the browser's sRGB conversion, not numeric extraction from their syntax.
export function resolveRenderedColors(
  colors: Record<string, string>,
): Record<string, RenderedColor> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  return Object.fromEntries(
    Object.entries(colors).map(([name, value]) => {
      if (!CSS.supports("color", value)) {
        throw new Error(`Expected a resolved CSS color, received ${value}`);
      }
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [name, { red: red!, green: green!, blue: blue!, alpha: alpha! / 255 }];
    }),
  );
}

export async function readTextTone(label: Locator) {
  const raw = await label.evaluate((element) => {
    const probe = document.createElement("span");
    element.append(probe);
    const resolve = (value: string) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const colors = {
      label: getComputedStyle(element).color,
      text: resolve("var(--text)"),
      muted: resolve("var(--muted)"),
    };
    probe.remove();
    return colors;
  });
  const colors = await label.page().evaluate(resolveRenderedColors, raw);
  const distance = (left: RenderedColor, right: RenderedColor) =>
    Math.hypot(left.red - right.red, left.green - right.green, left.blue - right.blue);
  return {
    raw,
    colors,
    distanceToText: distance(colors.label!, colors.text!),
    distanceToMuted: distance(colors.label!, colors.muted!),
  };
}
