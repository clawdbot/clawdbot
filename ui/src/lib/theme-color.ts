/** Resolve theme colors for consumers that require concrete RGB values. */
export function resolveThemeColor(styles: CSSStyleDeclaration, property: string): string {
  const value = styles.getPropertyValue(property).trim();
  if (!value || /^#[\da-f]{6}$/iu.test(value)) {
    return value.toLowerCase();
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) {
    return value;
  }
  // Custom themes use modern color functions; terminal OSC colors and Mermaid
  // require concrete #rrggbb values. A painted pixel resolves either syntax.
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return `#${Array.from(context.getImageData(0, 0, 1, 1).data)
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}
