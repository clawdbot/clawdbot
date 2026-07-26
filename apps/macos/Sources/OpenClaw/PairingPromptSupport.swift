import Foundation
import OpenClawKit
import OSLog
import UserNotifications

/// Shared plumbing for the node/device pairing prompters: gateway push
/// subscription lifecycle and approve/reject RPC logging.
@MainActor
enum PairingPromptSupport {
    enum PairingResolution: String {
        case approved
        case rejected
    }

    struct PairingResolvedEvent: Codable {
        let requestId: String
        let decision: String
        let ts: Double
    }

    static func runPairingPushTask(
        bufferingNewest: Int = 200,
        loadPending: @escaping @MainActor () async -> Void,
        handlePush: @escaping @MainActor (GatewayPush) -> Void) async
    {
        _ = try? await GatewayConnection.shared.refresh()
        await loadPending()
        await GatewayPushSubscription.consume(bufferingNewest: bufferingNewest, onPush: handlePush)
    }

    static func startPairingPushTask(
        task: inout Task<Void, Never>?,
        isStopping: inout Bool,
        bufferingNewest: Int = 200,
        loadPending: @escaping @MainActor () async -> Void,
        handlePush: @escaping @MainActor (GatewayPush) -> Void)
    {
        guard task == nil else { return }
        isStopping = false
        task = Task {
            await self.runPairingPushTask(
                bufferingNewest: bufferingNewest,
                loadPending: loadPending,
                handlePush: handlePush)
        }
    }

    static func stopPairingPrompter(
        isStopping: inout Bool,
        task: inout Task<Void, Never>?,
        queue: inout [some Any])
    {
        isStopping = true
        task?.cancel()
        task = nil
        queue.removeAll(keepingCapacity: false)
    }

    static func approveRequest(
        requestId: String,
        kind: String,
        logger: Logger,
        action: @escaping () async throws -> Void) async -> Bool
    {
        do {
            try await action()
            logger.info("approved \(kind, privacy: .public) pairing requestId=\(requestId, privacy: .public)")
            return true
        } catch {
            logger.error("approve failed requestId=\(requestId, privacy: .public)")
            logger.error("approve failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Human-readable subject for pairing notifications: display name when
    /// present, otherwise the raw node/device id.
    static func subjectLabel(displayName: String?, fallback: String) -> String {
        let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name! : fallback
    }

    static func notificationsAuthorized() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus == .authorized ||
            settings.authorizationStatus == .provisional
    }

    /// Decisions resolve the card optimistically before the RPC returns; when
    /// the RPC then fails the card comes back and this explains why. A failed
    /// RPC does not prove the gateway rejected the decision (it may have
    /// committed before a timeout), so the copy claims only lost confirmation;
    /// resolved events / reconcile report the authoritative outcome.
    static func notifyDecisionFailed(
        kind: PairingApprovalCenter.Kind,
        decision: PairingApprovalCenter.Decision,
        subject: String) async
    {
        guard await self.notificationsAuthorized() else { return }
        let action = decision == .approve ? "approval" : "rejection"
        _ = await NotificationManager().send(
            title: "\(kind == .node ? "Node" : "Device") pairing \(action) not confirmed",
            body: "\(subject)\nThe gateway did not confirm the \(action); the request may still be pending.",
            sound: nil,
            priority: .active)
    }

    @discardableResult
    static func rejectRequest(
        requestId: String,
        kind: String,
        logger: Logger,
        action: @escaping () async throws -> Void) async -> Bool
    {
        do {
            try await action()
            logger.info("rejected \(kind, privacy: .public) pairing requestId=\(requestId, privacy: .public)")
            return true
        } catch {
            logger.error("reject failed requestId=\(requestId, privacy: .public)")
            logger.error("reject failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}
