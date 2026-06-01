package ai.openclaw.app.gateway

/** Resolved gateway address and optional metadata discovered from Bonjour/manual entry. */
data class GatewayEndpoint(
  val stableId: String,
  val name: String,
  val host: String,
  val port: Int,
  val lanHost: String? = null,
  val tailnetDns: String? = null,
  val gatewayPort: Int? = null,
  val canvasPort: Int? = null,
  val tlsEnabled: Boolean = false,
  val tlsFingerprintSha256: String? = null,
) {
  companion object {
    /** Builds a stable manual endpoint key that survives display-name changes. */
    fun manual(
      host: String,
      port: Int,
    ): GatewayEndpoint =
      GatewayEndpoint(
        stableId = "manual|${host.lowercase()}|$port",
        name = "$host:$port",
        host = host,
        port = port,
        tlsEnabled = false,
        tlsFingerprintSha256 = null,
      )
  }
}
