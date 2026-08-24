/** Encode every UTF-16 string injectively without rejecting unpaired surrogates. */
function encodePluginOwnerSegment(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = value[index] ?? "";
    if (/^[A-Za-z0-9_.!~*'()-]$/.test(character)) {
      encoded += character;
    } else if (code <= 0x7f) {
      encoded += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      encoded += `%u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return encoded;
}

/** Canonical runtime identity for a plugin manifest's local SecretRef owner. */
export function runtimePluginManifestSecretOwnerId(pluginId: string, ownerId: string): string {
  return `${encodePluginOwnerSegment(pluginId)}:${encodePluginOwnerSegment(ownerId)}`;
}
