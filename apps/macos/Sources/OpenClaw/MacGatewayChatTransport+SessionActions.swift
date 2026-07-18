import Foundation
import OpenClawChatUI

extension MacGatewayChatTransport {
    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else { return nil }
        if let outboxGatewayID {
            let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
            guard currentGatewayID == outboxGatewayID else { return nil }
        }
        let transport = self
        return OpenClawChatSessionMutationRouteLease { key, label, category, pinned, archived, unread in
            let target = transport.sessionTarget(for: key)
            let request = OpenClawChatGatewayRequests.patchSession(
                sessionKey: target.sessionKey,
                agentID: target.agentID,
                label: label,
                category: category,
                pinned: pinned,
                archived: archived,
                unread: unread)
            _ = try await GatewayConnection.shared.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        }
    }

    func forkSession(parentKey: String) async throws -> String {
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        if let outboxGatewayID {
            let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
            guard currentGatewayID == outboxGatewayID else {
                throw OpenClawChatTransportSendError.notDispatched
            }
        }
        let target = self.sessionTarget(for: parentKey)
        let request = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: target.agentID)
        let data = try await GatewayConnection.shared.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: serverLease)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data).key
    }
}
