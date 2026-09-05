/// One capability-scoped Canvas URL and the transport trust bound to its route.
public struct GatewayCanvasHostRoute: Sendable, Equatable {
    public let url: String
    public let tlsFingerprintSHA256: String?

    public init(url: String, tlsFingerprintSHA256: String?) {
        self.url = url
        self.tlsFingerprintSHA256 = tlsFingerprintSHA256
    }
}
