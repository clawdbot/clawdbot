export async function deriveLegacyV4RecoveryScope(material: string | undefined): Promise<string> {
  if (!material || typeof crypto === "undefined" || !crypto.subtle) {
    return "";
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return "";
  }
}
