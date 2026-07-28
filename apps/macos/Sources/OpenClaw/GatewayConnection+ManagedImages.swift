import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

private let gatewayManagedImagePathPrefix = "/api/chat/media/outgoing/"

extension GatewayConnection {
    func loadImageArtifact(
        sessionKey: String,
        agentID: String?,
        artifactId: String,
        ifCurrentServerLease lease: ServerLease) async throws -> OpenClawChatLoadedImage?
    {
        let request = OpenClawChatGatewayRequests.artifactDownload(
            sessionKey: sessionKey,
            agentID: agentID,
            artifactId: artifactId)
        let responseData = try await self.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: lease)
        let response = try JSONDecoder().decode(ArtifactsDownloadResult.self, from: responseData)
        guard let ticketedPath = response.url?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = Self.managedImageURL(gatewayURL: lease.route.url, ticketedPath: ticketedPath)
        else { return nil }

        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 20
        urlRequest.setValue("image/*", forHTTPHeaderField: "Accept")
        // Native macOS has no per-Gateway proxy-header configuration surface today. If one is
        // added, carry its immutable snapshot on Route so the socket and ticket GET cannot diverge.
        let tls = lease.route.tls?.params ?? GatewayTLSParams(
            required: false,
            expectedFingerprint: nil,
            allowTOFU: false,
            storeKey: nil)
        let session = GatewayTLSPinningSession(params: tls)
        defer { session.finishTasksAndInvalidate() }
        let (data, urlResponse) = try await session.data(
            for: urlRequest,
            maximumBytes: 12 * 1024 * 1024)
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let http = urlResponse as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let mimeType = http.mimeType?.lowercased(),
              mimeType.hasPrefix("image/")
        else { return nil }
        return OpenClawChatLoadedImage(data: data, mimeType: mimeType)
    }

    private static func managedImageURL(gatewayURL: URL, ticketedPath: String) -> URL? {
        guard ticketedPath.hasPrefix(gatewayManagedImagePathPrefix),
              let relative = URLComponents(string: ticketedPath),
              relative.scheme == nil,
              relative.host == nil,
              relative.fragment == nil,
              relative.queryItems?.contains(where: {
                  $0.name == "mediaTicket" && $0.value?.isEmpty == false
              }) == true,
              var base = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false),
              base.host != nil
        else { return nil }
        switch base.scheme?.lowercased() {
        case "wss", "https": base.scheme = "https"
        case "ws", "http": base.scheme = "http"
        default: return nil
        }
        base.percentEncodedPath = relative.percentEncodedPath
        base.percentEncodedQuery = relative.percentEncodedQuery
        base.fragment = nil
        return base.url
    }
}
