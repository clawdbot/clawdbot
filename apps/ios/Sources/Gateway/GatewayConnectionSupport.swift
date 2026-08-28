import Foundation

struct GatewayOperatorFleetResolvedConfig: Sendable {
    let config: GatewayConnectConfig
    let name: String
}

enum GatewaySetupRouteProbeBudget {
    static let tcpConnectTimeoutSeconds = 2.0
}

func defaultGatewayTCPReachabilityProbe(
    host: String,
    port: Int,
    timeoutSeconds: Double,
    queueLabel: String) async -> Bool
{
    await TCPProbe.probe(host: host, port: port, timeoutSeconds: timeoutSeconds, queueLabel: queueLabel)
}

struct GatewayPendingTrustConnect {
    let url: URL
    let stableID: String
    let isManual: Bool
    let authOverride: GatewayConnectionController.ManualAuthOverride?
    let allowStoredDeviceAuth: Bool
    let suppressionLease: GatewayConnectionController.AutoConnectSuppressionLease
    let gatewayGeneration: UInt64?
}

func gatewayTLSProbeFailureMessage(
    _ failure: GatewayTLSFingerprintProbeFailure,
    host: String,
    port: Int) -> String
{
    switch failure {
    case .endpointUnreachable:
        if host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")).hasSuffix(".ts.net") {
            String(
                format: String(localized: """
                Can't reach gateway at %1$@:%2$@. \
                Verify Tailscale Serve is enabled and publishes this Gateway.
                """),
                host,
                String(port))
        } else {
            String(
                format: String(
                    localized: "Can't reach gateway at %1$@:%2$@. Check Tailscale or LAN."),
                host,
                String(port))
        }
    case .tlsHandshakeTimeout:
        String(
            format: String(localized: """
            TLS fingerprint verification timed out for %1$@:%2$@. \
            Secure endpoint was reached, but TLS did not finish in time.
            """),
            host,
            String(port))
    case .tlsUnavailable:
        String(
            format: String(localized: """
            No secure gateway endpoint was detected at %1$@:%2$@. \
            Enable gateway TLS or Tailscale Serve, or use a trusted private LAN address \
            with Unencrypted selected.
            """),
            host,
            String(port))
    case .certificateUnavailable:
        String(
            format: String(
                localized: "Could not read the TLS certificate from %1$@:%2$@."),
            host,
            String(port))
    }
}
