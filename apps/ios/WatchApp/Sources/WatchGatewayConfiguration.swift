import Foundation
import OpenClawKit

struct WatchVoiceConnection: Sendable, Equatable {
    let gatewayID: String
    let websocketURLs: [URL]
    let setupSentAtMs: Int64?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.gatewayID.utf8.elementsEqual(rhs.gatewayID.utf8)
            && lhs.websocketURLs == rhs.websocketURLs
            && lhs.setupSentAtMs == rhs.setupSentAtMs
    }
}

struct WatchGatewayConfiguration: Codable {
    var link: GatewayConnectDeepLink
    let gatewayID: String
    let setupSentAtMs: Int64?

    init?(setupLink: GatewayConnectDeepLink, sentAtMs: Int64) {
        guard setupLink.isValidEndpoint,
              setupLink.bootstrapToken != nil,
              setupLink.token == nil,
              setupLink.password == nil,
              let endpoint = setupLink.connectionEndpoints.first(where: \.tls)
        else { return nil }
        self.link = GatewayConnectDeepLink(
            host: endpoint.host,
            port: endpoint.port,
            tls: true,
            contextPath: endpoint.contextPath,
            bootstrapToken: setupLink.bootstrapToken,
            token: nil,
            password: nil,
            fallbackEndpoints: Array(setupLink.connectionEndpoints.filter(\.tls).dropFirst()))
        // Reverse-proxied Gateways can share a host. Their path namespaces must
        // remain separate credential owners as well as separate HTTP/WS routes.
        self.gatewayID = "watch-direct:https://\(endpoint.host.lowercased()):\(endpoint.port)" +
            (endpoint.contextPath ?? "")
        self.setupSentAtMs = sentAtMs
    }

    var endpointText: String {
        Self.httpBaseURL(for: self.link)?.absoluteString ?? self.link.host
    }

    var voiceConnection: WatchVoiceConnection {
        WatchVoiceConnection(
            gatewayID: self.gatewayID,
            websocketURLs: self.link.connectionEndpoints.filter(\.tls).compactMap(\.websocketURL),
            setupSentAtMs: self.setupSentAtMs)
    }

    func withoutBootstrapToken() -> Self {
        var result = self
        result.link = GatewayConnectDeepLink(
            host: self.link.host,
            port: self.link.port,
            tls: self.link.tls,
            contextPath: self.link.contextPath,
            bootstrapToken: nil,
            token: nil,
            password: nil,
            fallbackEndpoints: self.link.fallbackEndpoints)
        return result
    }

    static func httpBaseURL(for link: GatewayConnectDeepLink) -> URL? {
        guard link.tls else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = link.host
        components.port = link.port
        components.percentEncodedPath = link.contextPath ?? ""
        return components.url
    }
}
