import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

private let gatewayManagedMediaPathPrefix = "/api/chat/media/outgoing/"

extension GatewayConnection {
    func loadMediaArtifact(
        sessionKey: String,
        agentID: String?,
        artifactId: String,
        kind: OpenClawChatMediaKind,
        ifCurrentServerLease lease: ServerLease) async throws -> OpenClawChatLoadedMedia?
    {
        guard kind.acceptsManagedArtifactID(artifactId) else { return nil }
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
        let maximumBytes = Self.maximumManagedMediaBytes(for: kind)
        let declaredMIME = response.artifact.mimetype?.lowercased()
        if let encoded = response.data?.trimmingCharacters(in: .whitespacesAndNewlines),
           !encoded.isEmpty
        {
            guard response.encoding == "base64",
                  let declaredMIME,
                  declaredMIME.hasPrefix(kind.mimeTypePrefix),
                  let data = Data(base64Encoded: encoded),
                  data.count <= maximumBytes
            else { return nil }
            guard await self.isCurrentServerLease(lease) else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            return .data(OpenClawChatMediaData(data: data, mimeType: declaredMIME))
        }
        guard let ticketedPath = response.url?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = Self.managedMediaURL(gatewayURL: lease.route.url, ticketedPath: ticketedPath)
        else { return nil }

        if kind == .video,
           url.scheme?.lowercased() == "https",
           lease.route.tls == nil,
           let declaredMIME,
           declaredMIME.hasPrefix(kind.mimeTypePrefix)
        {
            guard await self.isCurrentServerLease(lease) else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            return .stream(OpenClawChatMediaStream(
                url: url,
                mimeType: declaredMIME,
                sizeBytes: response.artifact.sizebytes))
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = kind == .video ? 60 : 20
        urlRequest.setValue("\(kind.rawValue)/*", forHTTPHeaderField: "Accept")
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
            maximumBytes: maximumBytes)
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let http = urlResponse as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let mimeType = http.mimeType?.lowercased(),
              mimeType.hasPrefix(kind.mimeTypePrefix)
        else { return nil }
        return .data(OpenClawChatMediaData(data: data, mimeType: mimeType))
    }

    private static func maximumManagedMediaBytes(for kind: OpenClawChatMediaKind) -> Int {
        switch kind {
        case .image: 12 * 1024 * 1024
        case .audio, .video: 16 * 1024 * 1024
        }
    }

    private static func managedMediaURL(gatewayURL: URL, ticketedPath: String) -> URL? {
        guard ticketedPath.hasPrefix(gatewayManagedMediaPathPrefix),
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
