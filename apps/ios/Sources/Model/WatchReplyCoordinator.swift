import Foundation
import OpenClawChatUI
import OpenClawKit

/// Three recovery sources represent the same gateway-owned approval readback.
/// Preserve their source so cached cards, migration rows, and held Watch actions
/// share one classifier without losing source-specific cleanup.
enum WatchApprovalReadbackCandidate<Prompt, PersistedReadback> {
    case cached(Prompt)
    case persisted(PersistedReadback)
    case held(WatchExecApprovalSnapshotRequestItem)
}

/// This reader is used only by the named journal data migration, never for runtime replay.
enum WatchMessageLegacyDefaults {
    private static let queueKey = "watch.chat.command.queue.v1"
    private static let metadataKey = "watch.message.outbox.metadata.v1"

    private struct Queued: Decodable {
        let gatewayStableID: String
        let event: WatchAppCommandEvent
    }

    private struct Metadata: Decodable {
        let recentMessageIDs: [String]
    }

    struct Snapshot {
        let legacyImport: OpenClawWatchMessageLegacyImport
        fileprivate let queueData: Data?
        fileprivate let metadataData: Data?

        var hasSource: Bool {
            self.queueData != nil || self.metadataData != nil
        }
    }

    private static func data(_ key: String, defaults: UserDefaults) throws -> Data? {
        guard let value = defaults.object(forKey: key) else { return nil }
        guard let data = value as? Data else { throw WatchMessagingError.admissionUnavailable }
        return data
    }

    static func prepare(_ defaults: UserDefaults) throws -> Snapshot {
        let queueData = try self.data(self.queueKey, defaults: defaults)
        let metadataData = try self.data(self.metadataKey, defaults: defaults)
        let queued = try queueData.map { try JSONDecoder().decode([Queued].self, from: $0) } ?? []
        let metadata = try metadataData.map { try JSONDecoder().decode(Metadata.self, from: $0) }
        let legacyImport = OpenClawWatchMessageLegacyImport(
            messages: queued.map {
                .init(
                    id: $0.event.commandId,
                    gatewayStableID: GatewayStableIdentifier.exact($0.gatewayStableID),
                    text: $0.event.text ?? "",
                    submittedAtMs: $0.event.sentAtMs)
            },
            recentMessageIDs: metadata?.recentMessageIDs ?? [])
        return Snapshot(legacyImport: legacyImport, queueData: queueData, metadataData: metadataData)
    }

    static func finish(_ snapshot: Snapshot, defaults: UserDefaults) throws -> Bool {
        // Check both keys before removing either. A changed source must remain retryable;
        // a crash between removals is safe because SQLite retained per-ID import receipts.
        let queueData = try self.data(self.queueKey, defaults: defaults)
        let metadataData = try self.data(self.metadataKey, defaults: defaults)
        guard queueData == snapshot.queueData, metadataData == snapshot.metadataData
        else { return false }
        self.removeAll(defaults)
        return true
    }

    static func removeAll(_ defaults: UserDefaults) {
        defaults.removeObject(forKey: self.queueKey)
        defaults.removeObject(forKey: self.metadataKey)
    }
}

@MainActor
final class WatchReplyCoordinator {
    private struct CommandKey: Hashable {
        let context: OpenClawWatchChatDeliveryContext
        let id: Data

        init(context: OpenClawWatchChatDeliveryContext, id: String) {
            self.context = context
            self.id = Data(id.utf8)
        }
    }

    private struct ReceiptKey: Hashable {
        let command: CommandKey
        let receiptID: Data?
    }

    private let journal: OpenClawWatchMessageJournal
    private let gateway: GatewayNodeSession
    private let messaging: any WatchMessagingServicing
    private let reportStorageWarning: @MainActor (String?) -> Void
    private var tasks: [CommandKey: Task<Void, Never>] = [:]
    private var pendingResumes: Set<CommandKey> = []
    private var receiptTasks: [ReceiptKey: Task<Void, Never>] = [:]
    private var pendingReceiptResumes: Set<ReceiptKey> = []
    private var retryAttempts: [CommandKey: Int] = [:]
    private var stopped = false

    init(
        journal: OpenClawWatchMessageJournal,
        gateway: GatewayNodeSession,
        messaging: any WatchMessagingServicing,
        reportStorageWarning: @escaping @MainActor (String?) -> Void)
    {
        self.journal = journal
        self.gateway = gateway
        self.messaging = messaging
        self.reportStorageWarning = reportStorageWarning
    }

    @discardableResult
    func admit(
        _ command: OpenClawWatchChatDeliveryCommand,
        destination: OpenClawWatchMessageReceiptDestination = .watch) async throws -> OpenClawWatchMessageEntry
    {
        guard !self.stopped else { throw WatchMessagingError.admissionUnavailable }
        try await self.journal.recoverInterruptedWork(nowMs: Self.nowMs())
        guard !self.stopped, !Task.isCancelled else { throw CancellationError() }
        let entry = try await self.journal.admit(command, nowMs: Self.nowMs(), destination: destination)
        guard !self.stopped else { throw CancellationError() }
        self.updateStorageWarning(nil)
        // Neither transport nor provider work belongs to the application's admission ACK.
        self.sendReceipt(entry)
        self.start(entry)
        return entry
    }

    func acknowledge(_ acknowledgment: OpenClawWatchChatDeliveryReceiptAck) async throws {
        guard !self.stopped else { throw WatchMessagingError.admissionUnavailable }
        let result = try await self.journal.acknowledge(acknowledgment)
        guard result == .applied else {
            throw OpenClawWatchChatDeliveryError(code: "receipt_mismatch", message: "Watch receipt was not accepted.")
        }
        self.updateStorageWarning(nil)
    }

    func resume(gatewayStableID: String?, resetRetryBudget: Bool = false) async {
        guard !self.stopped else { return }
        if resetRetryBudget { self.retryAttempts.removeAll() }
        do {
            try await self.journal.recoverInterruptedWork(nowMs: Self.nowMs())
            try await self.sendPendingReceipts()
            for entry in try await self.journal.entries() {
                guard let command = entry.command else { continue }
                // Acceptance already completes quick replies; recovery must not wait for a live Gateway.
                let acceptedReply = entry.phase == .accepted && command.kind == .quickReply
                let selectedGateway = gatewayStableID.map {
                    command.context.gatewayStableID.utf8.elementsEqual($0.utf8)
                } ?? false
                if acceptedReply || selectedGateway { self.start(entry) }
            }
        } catch {
            self.storageFailed()
        }
    }

    func stop() {
        self.stopped = true
        self.pendingResumes.removeAll()
        self.pendingReceiptResumes.removeAll()
        for task in self.tasks.values {
            task.cancel()
        }
        for task in self.receiptTasks.values {
            task.cancel()
        }
    }

    func stopAndWait() async {
        self.stop()
        for task in Array(self.tasks.values) + Array(self.receiptTasks.values) {
            await task.value
        }
    }

    func retire(gatewayStableID: String) {
        for (key, task) in self.tasks where key.context.gatewayStableID.utf8.elementsEqual(gatewayStableID.utf8) {
            self.pendingResumes.remove(key)
            task.cancel()
        }
        for (key, task) in self.receiptTasks
            where key.command.context.gatewayStableID.utf8.elementsEqual(gatewayStableID.utf8)
        {
            self.pendingReceiptResumes.remove(key)
            task.cancel()
        }
    }

    private func start(_ entry: OpenClawWatchMessageEntry) {
        guard [.queued, .accepted].contains(entry.phase), let command = entry.command else { return }
        self.start(CommandKey(context: command.context, id: command.commandId))
    }

    private func start(_ key: CommandKey) {
        guard !self.stopped, let commandID = String(bytes: key.id, encoding: .utf8) else { return }
        guard self.tasks[key] == nil else {
            self.pendingResumes.insert(key)
            return
        }
        // Each bounded journal row owns its task; a slow reply must not block a fresh quick reply.
        self.tasks[key] = Task { [weak self] in
            guard let self else { return }
            defer {
                self.tasks[key] = nil
                // A reconnect may arrive before the old route observer unwinds.
                // A fresh task also survives cancellation of a subsequently restored owner.
                if self.pendingResumes.remove(key) != nil { self.start(key) }
            }
            do {
                while !self.stopped, !Task.isCancelled {
                    guard let current = try await self.journal.resumableEntry(
                        id: commandID, context: key.context),
                        !self.stopped, !Task.isCancelled, await self.process(current)
                    else { return }
                    let attempt = (self.retryAttempts[key] ?? 0) + 1
                    self.retryAttempts[key] = attempt
                    guard attempt <= 3 else { return }
                    try? await Task.sleep(for: .milliseconds(500 * (1 << (attempt - 1))))
                }
            } catch {
                if !self.stopped, !Task.isCancelled { self.storageFailed() }
            }
        }
    }

    private func process(_ entry: OpenClawWatchMessageEntry) async -> Bool {
        guard let command = entry.command, let owner = entry.owner, !Task.isCancelled else { return false }
        let transport = IOSGatewayChatTransport(
            gateway: self.gateway,
            globalAgentId: command.context.agentId,
            outboxGatewayID: command.context.gatewayStableID)
        if entry.phase == .accepted {
            await self.observe(entry, transport: transport)
            return false
        }
        guard case let .available(lease) = await transport.acquireOutboxRouteLease() else { return false }
        do {
            guard !Task.isCancelled else { return false }
            guard let claim = try await self.journal.claim(command, nowMs: Self.nowMs())
            else {
                try await self.sendPendingReceipts()
                return false
            }
            guard lease.sessionRoutingContract == command.context.sessionRoutingContract else {
                await self.finish(claim, outcome: .failed(
                    code: "routing_changed",
                    message: String(localized: "The Gateway delivery target changed. Review this message on iPhone.")))
                return false
            }
            let response: OpenClawChatSendResponse
            do {
                response = try await lease.sendMessage(
                    sessionKey: command.context.deliverySessionKey,
                    agentID: command.context.agentId,
                    message: command.text,
                    // The canonical request encoder omits an empty override for free-form chat.
                    thinking: NodeAppModel.watchThinkingOverride(for: command.kind) ?? "",
                    idempotencyKey: command.commandId,
                    attachments: [])
            } catch OpenClawChatTransportSendError.notDispatched {
                return try await self.journal.releaseNotDispatched(claim) == .applied
            } catch {
                // The Gateway's native dedupe is not a durable 48-hour replay contract.
                await self.finish(claim, outcome: .uncertain(
                    message: String(
                        localized: "Delivery could not be confirmed. Check Chat on iPhone before sending again.")))
                return false
            }
            guard response.runId.utf8.elementsEqual(command.commandId.utf8),
                  ["started", "in_flight", "ok"].contains(response.status)
            else {
                await self.finish(claim, outcome: .uncertain(
                    message: String(
                        localized: "The Gateway returned an unexpected delivery result. Check Chat on iPhone.")))
                return false
            }
            guard try await self.journal.recordAccepted(claim, runID: response.runId) == .applied,
                  let accepted = try await self.journal.accepted(owner: owner).first(where: {
                      $0.id == entry.id && $0.attemptVersion == claim.attemptVersion
                  })
            else { return false }
            await self.observe(accepted, transport: transport)
        } catch {
            self.storageFailed()
        }
        return false
    }

    private func observe(_ entry: OpenClawWatchMessageEntry, transport: IOSGatewayChatTransport) async {
        guard let command = entry.command, let runID = entry.acceptedRunID else { return }
        // Persisted acceptance completes quick replies, including recovery without assistant history.
        if command.kind == .quickReply {
            await self.finish(entry, outcome: .forwarded)
            return
        }
        guard let route = await self.gateway.currentRoute(ifGatewayID: command.context.gatewayStableID) else { return }
        let deadline = Date().addingTimeInterval(75)
        let observation = await transport.waitForRunCompletion(runId: runID, timeoutMs: 60000, ifCurrentRoute: route)
        if case let .terminal(.failed(message)) = observation {
            await self.finish(entry, outcome: .failed(
                code: "gateway_run_failed",
                message: OpenClawWatchChatDeliveryCodec.boundedReplyText(message)))
            return
        }
        var inputRunIDs: [String]? = [runID]
        repeat {
            guard !self.stopped, !Task.isCancelled, await self.gateway.currentRoute() == route else { return }
            do {
                let history = try await transport.requestHistory(
                    sessionKey: command.context.deliverySessionKey,
                    agentID: command.context.agentId,
                    inputRunIDs: inputRunIDs,
                    ifCurrentRoute: route)
                if let text = OpenClawChatHistoryPresentation.replyText(
                    from: history.messages ?? [],
                    runID: runID,
                    inputConsumptions: history.inputConsumptions)
                {
                    await self.finish(
                        entry,
                        outcome: .reply(text: OpenClawWatchChatDeliveryCodec.boundedReplyText(text)))
                    return
                }
            } catch {
                if inputRunIDs != nil, IOSGatewayChatTransport.isUnsupportedHistoryInputRunIDsError(error) {
                    inputRunIDs = nil
                    continue
                }
            }
            guard Date() < deadline else { return }
            try? await Task.sleep(for: .seconds(1))
        } while !Task.isCancelled
        // No observed reply is not failure or permission to execute the accepted command again.
    }

    private func finish(_ entry: OpenClawWatchMessageEntry, outcome: OpenClawWatchChatDeliveryOutcome) async {
        do {
            guard try await self.journal.recordTerminal(entry, outcome: outcome, nowMs: Self.nowMs()) == .applied else {
                return
            }
            try await self.sendPendingReceipts()
        } catch {
            self.storageFailed()
        }
    }

    private func sendPendingReceipts() async throws {
        let entries = try await self.journal.pendingReceipts()
        self.updateStorageWarning(nil)
        for entry in entries {
            self.sendReceipt(entry)
        }
    }

    private func sendReceipt(_ entry: OpenClawWatchMessageEntry) {
        guard !self.stopped, entry.destination == .watch, let receipt = entry.receipt else {
            return
        }
        let key = ReceiptKey(
            command: CommandKey(context: receipt.context, id: receipt.commandId),
            receiptID: receipt.terminal.map { Data($0.receiptId.utf8) })
        guard self.receiptTasks[key] == nil else {
            self.pendingReceiptResumes.insert(key)
            return
        }
        self.receiptTasks[key] = Task { [weak self] in
            guard let self else { return }
            defer {
                self.receiptTasks[key] = nil
                // Reachability can recover before a failed or retired transfer unwinds.
                // Only a recorded new wake starts another attempt, with the same journal fences.
                if self.pendingReceiptResumes.remove(key) != nil { self.sendReceipt(entry) }
            }
            guard !self.stopped, !Task.isCancelled else { return }
            do {
                guard let owner = entry.owner,
                      try await self.journal.route(gatewayStableID: owner.gatewayStableID)?.owner == owner,
                      let current = try await self.journal.entries(owner: owner).first(where: {
                          $0.id == entry.id
                      }), current.receipt == receipt,
                      (current.expiresAtMs ?? 0) > Self.nowMs(), !Task.isCancelled, !self.stopped
                else { return }
                self.updateStorageWarning(nil)
            } catch {
                self.storageFailed()
                return
            }
            do {
                // A successful WC transfer does not retire the committed application receipt.
                _ = try await self.messaging.sendChatDeliveryReceipt(receipt)
            } catch {
                GatewayDiagnostics.log("watch chat receipt retained for retry")
            }
        }
    }

    private func storageFailed() {
        GatewayDiagnostics.log("watch chat journal operation failed")
        self.updateStorageWarning(
            String(localized: "Watch delivery could not be saved. Open Apple Watch settings to review it."))
    }

    private func updateStorageWarning(_ message: String?) {
        guard !self.stopped, !Task.isCancelled else { return }
        self.reportStorageWarning(message)
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
