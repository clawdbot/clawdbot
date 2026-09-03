const WINDOWS_FORBIDDEN_COMPONENT_CHARACTERS = new Set(["<", ">", ":", '"', "|", "?", "*"]);
const WINDOWS_RESERVED_DEVICE_BASENAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])$/iu;

function hasForbiddenWindowsComponentCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      (codePoint !== undefined && codePoint <= 0x1f) ||
      WINDOWS_FORBIDDEN_COMPONENT_CHARACTERS.has(character)
    ) {
      return true;
    }
  }
  return false;
}

function isWindowsReservedDeviceName(value: string): boolean {
  const extensionIndex = value.indexOf(".");
  const basename = (extensionIndex === -1 ? value : value.slice(0, extensionIndex)).replace(
    / +$/u,
    "",
  );
  return WINDOWS_RESERVED_DEVICE_BASENAME.test(basename);
}

/** Entry points must name the same ordinary file on POSIX and Windows. */
export function isSafeUpdateGenerationEntrypointPath(value: string): boolean {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) {
    return false;
  }
  return value.split("/").every((part) => {
    return (
      part !== "" &&
      part !== "." &&
      part !== ".." &&
      !hasForbiddenWindowsComponentCharacter(part) &&
      !part.endsWith(".") &&
      !part.endsWith(" ") &&
      !isWindowsReservedDeviceName(part)
    );
  });
}
