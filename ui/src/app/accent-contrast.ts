export function controlUiAccentInk(accent: string): "#000000" | "#ffffff" {
  const color = accent.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(color)) {
    return "#ffffff";
  }
  const linearChannel = (offset: number) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(0) + 0.7152 * linearChannel(2) + 0.0722 * linearChannel(4);
  // Black and white reach equal WCAG contrast at relative luminance 0.179.
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
