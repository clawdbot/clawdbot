import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    func loadMediaArtifact(
        sessionKey: String,
        agentID: String?,
        artifactId: String,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode?,
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
        if playback != .transcode,
           let encoded = response.data?.trimmingCharacters(in: .whitespacesAndNewlines),
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
              let url = OpenClawChatMediaURL.resolve(
                  gatewayURL: lease.route.url,
                  ticketedPath: ticketedPath,
                  playback: playback)
        else { return nil }

        let canStreamDirectly = kind == .video &&
            url.scheme?.lowercased() == "https" &&
            lease.route.browserSession == nil &&
            lease.route.tls == nil &&
            declaredMIME?.hasPrefix(kind.mimeTypePrefix) == true
        if canStreamDirectly, playback != .transcode, let declaredMIME {
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
        if canStreamDirectly {
            urlRequest.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        }
        // Artifact tickets do not bypass the ingress issuer. Reuse the socket's
        // exact session and reject redirects before any credential can leave its authority.
        for (name, value) in try lease.route.browserSession?.headers(for: url) ?? [:] {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        let tls = lease.route.tls?.params ?? GatewayTLSParams(
            required: lease.route.browserSession != nil,
            expectedFingerprint: nil,
            allowTOFU: false,
            storeKey: nil)
        let session = GatewayTLSPinningSession(
            params: tls,
            allowsRedirects: lease.route.browserSession == nil,
            allowsStoredCredentials: lease.route.browserSession == nil)
        defer { session.finishTasksAndInvalidate() }
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let transferID = UUID()
        let transfer = Task { [urlRequest] in
            try await session.data(for: urlRequest, maximumBytes: maximumBytes) { [weak self] in
                self?.serverLeaseMatchesCurrentState(lease) == true
            }
        }
        self.managedMediaTransfers[transferID] = transfer
        defer { self.managedMediaTransfers[transferID] = nil }
        let (data, urlResponse) = try await withTaskCancellationHandler {
            try await transfer.value
        } onCancel: {
            transfer.cancel()
        }
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let http = urlResponse as? HTTPURLResponse else { return nil }
        if http.statusCode == 202 {
            return .preparing
        }
        guard (200..<300).contains(http.statusCode),
              let mimeType = http.mimeType?.lowercased(),
              mimeType.hasPrefix(kind.mimeTypePrefix)
        else { return nil }
        if canStreamDirectly {
            return .stream(OpenClawChatMediaStream(
                url: url,
                mimeType: mimeType,
                sizeBytes: response.artifact.sizebytes))
        }
        return .data(OpenClawChatMediaData(data: data, mimeType: mimeType))
    }

    private static func maximumManagedMediaBytes(for kind: OpenClawChatMediaKind) -> Int {
        switch kind {
        case .image: 12 * 1024 * 1024
        case .audio, .video: 16 * 1024 * 1024
        }
    }
}
