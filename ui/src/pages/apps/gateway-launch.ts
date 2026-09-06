/** Launch links carry only an address; the Mac app owns authentication and approval. */
export function buildMacGatewayLaunchUrl(
  gatewayUrl: string,
  controlUiIdentityUrl?: unknown,
): string | null {
  try {
    const address = new URL(
      typeof controlUiIdentityUrl === "string" ? controlUiIdentityUrl : gatewayUrl,
    );
    if (address.protocol === "wss:") {
      address.protocol = "https:";
    }
    if (
      address.protocol !== "https:" ||
      address.username ||
      address.password ||
      address.href.includes("?") ||
      address.href.includes("#")
    ) {
      return null;
    }
    const launch = new URL("openclaw://gateway/add");
    launch.searchParams.set("url", address.href);
    return launch.href;
  } catch {
    return null;
  }
}
