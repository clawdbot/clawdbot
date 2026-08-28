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
