import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog

/// Shared plumbing for the node/device pairing prompters: gateway push
/// subscription lifecycle and approve/reject RPC logging.
@MainActor
enum PairingPromptSupport {
    /// A pairing queue belongs to one subscription lifetime and physical server.
    /// Retained cards and probes keep this owner, never a newly selected Gateway.
    @MainActor
    final class Source: Equatable {
        let lease: GatewayConnection.ServerLease
        let gateway: GatewayConnection
        private var active = true
        private var listRevision = 0
        private var listTask: Task<Void, Error>?

        init(lease: GatewayConnection.ServerLease, gateway: GatewayConnection) {
            self.lease = lease
            self.gateway = gateway
        }

        var isCurrent: Bool {
            self.active && self.gateway.serverLeaseMatchesCurrentState(self.lease)
        }

        func retire() {
            self.active = false
            self.listTask?.cancel()
            self.listTask = nil
        }

        func invalidateList() {
            self.listRevision += 1
        }

        func refreshList(
            method: String,
            timeoutMs: Double? = nil,
            apply: @escaping @MainActor (Data) throws -> Void) async throws
        {
            guard !Task.isCancelled, self.isCurrent else { return }
            // Each prompter owns its Source and one list task. Queue mutations
            // invalidate snapshots; overlapping readers join without invalidating
            // one another, and an invalidated initial read still converges.
            if self.listTask == nil {
                self.listTask = Task { @MainActor in
                    defer { self.listTask = nil }
                    while !Task.isCancelled, self.isCurrent {
                        let revision = self.listRevision
                        let data = try await self.gateway.request(
                            method: method,
                            params: nil,
                            timeoutMs: timeoutMs,
                            ifCurrentServerLease: self.lease)
                        guard !Task.isCancelled, self.isCurrent else { return }
                        guard revision == self.listRevision else { continue }
                        try apply(data)
                        return
                    }
                }
            }
            try await self.listTask?.value
        }

        nonisolated static func == (lhs: Source, rhs: Source) -> Bool {
            lhs === rhs
        }
    }

    enum PairingResolution: String {
        case approved
        case rejected
    }

    struct PairingResolvedEvent: Codable {
        let requestId: String
        let decision: String
        let ts: Double
    }

    static func startPairingPushTask(
        task: inout Task<Void, Never>?,
        gateway: GatewayConnection,
        bufferingNewest: Int = 200,
        handlePush: @escaping @MainActor (GatewayConnection.PushDelivery) -> Void)
    {
        guard task == nil else { return }
        task = Task {
            _ = try? await gateway.acquireServerLease()
            await GatewayPushSubscription.consume(
                connection: gateway, bufferingNewest: bufferingNewest, onPush: handlePush)
        }
    }

    static func decide(
        requestId: String,
        kind: PairingApprovalCenter.Kind,
        decision: PairingApprovalCenter.Decision,
        source: Source,
        logger: Logger) async -> Bool
    {
        guard source.isCurrent else {
            logger.info("pairing decision discarded after the Gateway connection changed")
            return false
        }
        defer {
            if !source.isCurrent {
                logger.info("pairing decision result ignored after the Gateway connection changed")
            }
        }
        let method: GatewayConnection.Method = switch (kind, decision) {
        case (.node, .approve): .nodePairApprove
        case (.node, .reject): .nodePairReject
        case (.device, .approve): .devicePairApprove
        case (.device, .reject): .devicePairReject
        }
        do {
            _ = try await source.gateway.request(
                method: method.rawValue,
                params: ["requestId": AnyCodable(requestId)],
                timeoutMs: 10000,
                ifCurrentServerLease: source.lease)
            guard source.isCurrent else { return false }
            logger.info("""
            pairing decision confirmed method=\(method.rawValue, privacy: .public) \
            requestId=\(requestId, privacy: .public)
            """)
            return true
        } catch {
            guard source.isCurrent else { return false }
            logger.error("pairing decision failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Human-readable subject for pairing notifications: display name when
    /// present, otherwise the raw node/device id.
    static func subjectLabel(displayName: String?, fallback: String) -> String {
        let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name! : fallback
    }

    /// Decisions resolve the card optimistically before the RPC returns; when
    /// the RPC then fails the card comes back and this explains why. A failed
    /// RPC does not prove the gateway rejected the decision (it may have
    /// committed before a timeout), so the copy claims only lost confirmation;
    /// resolved events / reconcile report the authoritative outcome.
    static func notifyDecisionFailed(
        kind: PairingApprovalCenter.Kind,
        decision: PairingApprovalCenter.Decision,
        source: Source,
        subject: String) async
    {
        guard source.isCurrent else { return }
        let action = decision == .approve ? "approval" : "rejection"
        _ = await NotificationManager().send(
            title: "\(kind == .node ? "Node" : "Device") pairing \(action) not confirmed",
            body: "\(subject)\nThe gateway did not confirm the \(action); the request may still be pending.",
            sound: nil,
            priority: .active,
            requestPermission: false,
            isCurrent: { source.isCurrent })
    }
}
