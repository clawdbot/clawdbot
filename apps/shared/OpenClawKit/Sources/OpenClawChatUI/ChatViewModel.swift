import Foundation
import Observation
import OpenClawKit
import OSLog
import UniformTypeIdentifiers

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

private let chatUILogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")

@MainActor
@Observable
// swiftlint:disable:next type_body_length
public final class OpenClawChatViewModel {
    public static let defaultModelSelectionID = "__default__"

    public private(set) var messages: [OpenClawChatMessage] = []
    public var input: String = ""
    public private(set) var thinkingLevel: String
    public private(set) var modelSelectionID: String = "__default__"
    public private(set) var modelChoices: [OpenClawChatModelChoice] = []
    public private(set) var isLoading = false
    public private(set) var isSending = false
    public private(set) var isAborting = false
    public var errorText: String?
    public var attachments: [OpenClawPendingAttachment] = []
    public private(set) var healthOK: Bool = false
    public private(set) var pendingRunCount: Int = 0

    public private(set) var sessionKey: String
    public private(set) var sessionId: String?
    public private(set) var streamingAssistantText: String?
    public private(set) var pendingToolCalls: [OpenClawChatPendingToolCall] = []
    public private(set) var sessions: [OpenClawChatSessionEntry] = []
    private let transport: any OpenClawChatTransport
    private var sessionDefaults: OpenClawChatSessionsDefaults?
    private let prefersExplicitThinkingLevel: Bool
    private let onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)?

    @ObservationIgnored
    private nonisolated(unsafe) var eventTask: Task<Void, Never>?
    private var pendingRuns = Set<String>() {
        didSet { self.pendingRunCount = self.pendingRuns.count }
    }

    @ObservationIgnored
    private nonisolated(unsafe) var pendingRunTimeoutTasks: [String: Task<Void, Never>] = [:]
    private let pendingRunTimeoutMs: UInt64 = 120_000
    // Session switches can overlap in-flight picker patches, so stale completions
    // must compare against the latest request and latest desired value for that session.
    private var nextModelSelectionRequestID: UInt64 = 0
    private var latestModelSelectionRequestIDsBySession: [String: UInt64] = [:]
    private var latestModelSelectionIDsBySession: [String: String] = [:]
    private var lastSuccessfulModelSelectionIDsBySession: [String: String] = [:]
    private var inFlightModelPatchCountsBySession: [String: Int] = [:]
    private var modelPatchWaitersBySession: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var nextThinkingSelectionRequestID: UInt64 = 0
    private var latestThinkingSelectionRequestIDsBySession: [String: UInt64] = [:]
    private var latestThinkingLevelsBySession: [String: String] = [:]
    private var isCompacting = false
    private var lastCompactAt: Date?
    private let compactCooldown: TimeInterval = 60

    private var pendingToolCallsById: [String: OpenClawChatPendingToolCall] = [:] {
        didSet {
            self.pendingToolCalls = self.pendingToolCallsById.values
                .sorted { ($0.startedAt ?? 0) < ($1.startedAt ?? 0) }
        }
    }

    private var lastHealthPollAt: Date?

    public init(
        sessionKey: String,
        transport: any OpenClawChatTransport,
        initialThinkingLevel: String? = nil,
        onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)? = nil)
    {
        self.sessionKey = sessionKey
        self.transport = transport
        let normalizedThinkingLevel = Self.normalizedThinkingLevel(initialThinkingLevel)
        self.thinkingLevel = normalizedThinkingLevel ?? "off"
        self.prefersExplicitThinkingLevel = normalizedThinkingLevel != nil
        self.onThinkingLevelChanged = onThinkingLevelChanged

        self.eventTask = Task { [weak self] in
            guard let self else { return }
            let stream = self.transport.events()
            for await evt in stream {
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    self?.handleTransportEvent(evt)
                }
            }
        }
    }

    deinit {
        self.eventTask?.cancel()
        for (_, task) in self.pendingRunTimeoutTasks {
            task.cancel()
        }
    }

    public func load() {
        Task { await self.bootstrap() }
    }

    public func refresh() {
        Task { await self.bootstrap() }
    }

    public func send() {
        Task { await self.performSend() }
    }

    public func abort() {
        Task { await self.performAbort() }
    }

    public func refreshSessions(limit: Int? = nil) {
        Task { await self.fetchSessions(limit: limit) }
    }

    public func switchSession(to sessionKey: String) {
        Task { await self.performSwitchSession(to: sessionKey) }
    }

    public func selectThinkingLevel(_ level: String) {
        Task { await self.performSelectThinkingLevel(level) }
    }

    public func selectModel(_ selectionID: String) {
        Task { await self.performSelectModel(selectionID) }
    }

    public var sessionChoices: [OpenClawChatSessionEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let cutoff = now - (24 * 60 * 60 * 1000)
        let sorted = self.sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        let mainSessionKey = self.resolvedMainSessionKey

        var result: [OpenClawChatSessionEntry] = []
        var included = Set<String>()

        // Always show the resolved main session first, even if it hasn't been updated recently.
        if let main = sorted.first(where: { $0.key == mainSessionKey }) {
            result.append(main)
            included.insert(main.key)
        } else {
            result.append(self.placeholderSession(key: mainSessionKey))
            included.insert(mainSessionKey)
        }

        for entry in sorted {
            guard !included.contains(entry.key) else { continue }
            guard entry.key == self.sessionKey || !Self.isHiddenInternalSession(entry.key) else { continue }
            guard (entry.updatedAt ?? 0) >= cutoff else { continue }
            result.append(entry)
            included.insert(entry.key)
        }

        if !included.contains(self.sessionKey) {
            if let current = sorted.first(where: { $0.key == self.sessionKey }) {
                result.append(current)
            } else {
                result.append(self.placeholderSession(key: self.sessionKey))
            }
        }

        return result
    }

    private var resolvedMainSessionKey: String {
        let trimmed = self.sessionDefaults?.mainSessionKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false ? trimmed : nil) ?? "main"
    }

    private static func isHiddenInternalSession(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed == "onboarding" || trimmed.hasSuffix(":onboarding")
    }

    public var showsModelPicker: Bool {
        !self.modelChoices.isEmpty
    }

    public var defaultModelLabel: String {
        guard let defaultModelID = self.normalizedModelSelectionID(self.sessionDefaults?.model) else {
            return "Default"
        }
        return "Default: \(self.modelLabel(for: defaultModelID))"
    }

    public func addAttachments(urls: [URL]) {
        Task { await self.loadAttachments(urls: urls) }
    }

    public func addImageAttachment(data: Data, fileName: String, mimeType: String) {
        Task { await self.addImageAttachment(url: nil, data: data, fileName: fileName, mimeType: mimeType) }
    }

    public func removeAttachment(_ id: OpenClawPendingAttachment.ID) {
        self.attachments.removeAll { $0.id == id }
    }

    public var canSend: Bool {
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !self.isSending && self.pendingRunCount == 0 && (!trimmed.isEmpty || !self.attachments.isEmpty)
    }

    // MARK: - Internals

    private func bootstrap() async {
        self.isLoading = true
        self.errorText = nil
        self.healthOK = false
        self.clearPendingRuns(reason: nil)
        self.pendingToolCallsById = [:]
        self.streamingAssistantText = nil
        self.sessionId = nil
        defer { self.isLoading = false }
        do {
            do {
                try await self.transport.setActiveSessionKey(self.sessionKey)
            } catch {
                // Best-effort only; history/send/health still work without push events.
            }

            let payload = try await self.transport.requestHistory(sessionKey: self.sessionKey)
            self.messages = Self.reconcileMessageIDs(
                previous: self.messages,
                incoming: Self.decodeMessages(payload.messages ?? []))
            self.sessionId = payload.sessionId
            if !self.prefersExplicitThinkingLevel,
               let level = Self.normalizedThinkingLevel(payload.thinkingLevel)
            {
                self.thinkingLevel = level
            }
            await self.pollHealthIfNeeded(force: true)
            await self.fetchSessions(limit: 50)
            await self.fetchModels()
            self.errorText = nil
        } catch {
            self.errorText = error.localizedDescription
            chatUILogger.error("bootstrap failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func decodeMessages(_ raw: [AnyCodable]) -> [OpenClawChatMessage] {
        let decoded = raw.compactMap { item in
            (try? ChatPayloadDecoding.decode(item, as: OpenClawChatMessage.self))
                .map { Self.stripInboundMetadata(from: $0) }
        }
        return Self.dedupeMessages(decoded)
    }

    private static func stripInboundMetadata(from message: OpenClawChatMessage) -> OpenClawChatMessage {
        guard message.role.lowercased() == "user" else {
            return message
        }

        let sanitizedContent = message.content.map { content -> OpenClawChatMessageContent in
            guard let text = content.text else { return content }
            let cleaned = ChatMarkdownPreprocessor.preprocess(markdown: text).cleaned
            return OpenClawChatMessageContent(
                type: content.type,
                text: cleaned,
                thinking: content.thinking,
                thinkingSignature: content.thinkingSignature,
                mimeType: content.mimeType,
                fileName: content.fileName,
                content: content.content,
                id: content.id,
                name: content.name,
                arguments: content.arguments)
        }

        return OpenClawChatMessage(
            id: message.id,
            role: message.role,
            content: sanitizedContent,
            timestamp: message.timestamp,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            usage: message.usage,
            stopReason: message.stopReason)
    }

    private static func messageContentFingerprint(for message: OpenClawChatMessage) -> String {
        message.content.map { item in
            let type = (item.type ?? "text").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let text = (item.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let id = (item.id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let name = (item.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let fileName = (item.fileName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return [type, text, id, name, fileName].joined(separator: "\\u{001F}")
        }.joined(separator: "\\u{001E}")
    }

    private static func messageIdentityKey(for message: OpenClawChatMessage) -> String? {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !role.isEmpty else { return nil }

        let timestamp: String = {
            guard let value = message.timestamp, value.isFinite else { return "" }
            return String(format: "%.3f", value)
        }()

        let contentFingerprint = Self.messageContentFingerprint(for: message)
        let toolCallId = (message.toolCallId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let toolName = (message.toolName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if timestamp.isEmpty, contentFingerprint.isEmpty, toolCallId.isEmpty, toolName.isEmpty {
            return nil
        }
        return [role, timestamp, toolCallId, toolName, contentFingerprint].joined(separator: "|")
    }

    private static func userRefreshIdentityKey(for message: OpenClawChatMessage) -> String? {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard role == "user" else { return nil }

        let contentFingerprint = Self.messageContentFingerprint(for: message)
        let toolCallId = (message.toolCallId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let toolName = (message.toolName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if contentFingerprint.isEmpty, toolCallId.isEmpty, toolName.isEmpty {
            return nil
        }
        return [role, toolCallId, toolName, contentFingerprint].joined(separator: "|")
    }

    private static func reconcileMessageIDs(
        previous: [OpenClawChatMessage],
        incoming: [OpenClawChatMessage]) -> [OpenClawChatMessage]
    {
        guard !previous.isEmpty, !incoming.isEmpty else { return incoming }

        var idsByKey: [String: [UUID]] = [:]
        for message in previous {
            guard let key = Self.messageIdentityKey(for: message) else { continue }
            idsByKey[key, default: []].append(message.id)
        }

        return incoming.map { message in
            guard let key = Self.messageIdentityKey(for: message),
                  var ids = idsByKey[key],
                  let reusedId = ids.first
            else {
                return message
            }
            ids.removeFirst()
            if ids.isEmpty {
                idsByKey.removeValue(forKey: key)
            } else {
                idsByKey[key] = ids
            }
            guard reusedId != message.id else { return message }
            return OpenClawChatMessage(
                id: reusedId,
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                usage: message.usage,
                stopReason: message.stopReason)
        }
    }

    private static func reconcileRunRefreshMessages(
        previous: [OpenClawChatMessage],
        incoming: [OpenClawChatMessage]) -> [OpenClawChatMessage]
    {
        guard !previous.isEmpty else { return incoming }
        guard !incoming.isEmpty else { return previous }

        func countKeys(_ keys: [String]) -> [String: Int] {
            keys.reduce(into: [:]) { counts, key in
                counts[key, default: 0] += 1
            }
        }

        var reconciled = Self.reconcileMessageIDs(previous: previous, incoming: incoming)
        let incomingIdentityKeys = Set(reconciled.compactMap(Self.messageIdentityKey(for:)))
        var remainingIncomingUserRefreshCounts = countKeys(
            reconciled.compactMap(Self.userRefreshIdentityKey(for:)))

        var lastMatchedPreviousIndex: Int?
        for (index, message) in previous.enumerated() {
            if let key = Self.messageIdentityKey(for: message),
               incomingIdentityKeys.contains(key)
            {
                lastMatchedPreviousIndex = index
                continue
            }
            if let userKey = Self.userRefreshIdentityKey(for: message),
               let remaining = remainingIncomingUserRefreshCounts[userKey],
               remaining > 0
            {
                remainingIncomingUserRefreshCounts[userKey] = remaining - 1
                lastMatchedPreviousIndex = index
            }
        }

        let trailingUserMessages = (lastMatchedPreviousIndex != nil
            ? previous.suffix(from: previous.index(after: lastMatchedPreviousIndex!))
            : ArraySlice(previous))
            .filter { message in
                guard message.role.lowercased() == "user" else { return false }
                guard let key = Self.userRefreshIdentityKey(for: message) else { return false }
                let remaining = remainingIncomingUserRefreshCounts[key] ?? 0
                if remaining > 0 {
                    remainingIncomingUserRefreshCounts[key] = remaining - 1
                    return false
                }
                return true
            }

        guard !trailingUserMessages.isEmpty else {
            return reconciled
        }

        for message in trailingUserMessages {
            guard let messageTimestamp = message.timestamp else {
                reconciled.append(message)
                continue
            }

            let insertIndex = reconciled.firstIndex { existing in
                guard let existingTimestamp = existing.timestamp else { return false }
                return existingTimestamp > messageTimestamp
            } ?? reconciled.endIndex
            reconciled.insert(message, at: insertIndex)
        }

        return Self.dedupeMessages(reconciled)
    }

    private static func dedupeMessages(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        var result: [OpenClawChatMessage] = []
        result.reserveCapacity(messages.count)
        var seen = Set<String>()

        for message in messages {
            guard let key = Self.dedupeKey(for: message) else {
                result.append(message)
                continue
            }
            if seen.contains(key) { continue }
            seen.insert(key)
            result.append(message)
        }

        return result
    }

    private static func dedupeKey(for message: OpenClawChatMessage) -> String? {
        guard let timestamp = message.timestamp else { return nil }
        let text = message.content.compactMap(\.text).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return "\(message.role)|\(timestamp)|\(text)"
    }

    private static let resetTriggers: Set<String> = ["/new", "/reset", "/clear"]
    private static let compactTriggers: Set<String> = ["/compact"]

    private func performSend() async {
        guard !self.isSending else { return }
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !self.attachments.isEmpty else { return }

        if Self.resetTriggers.contains(trimmed.lowercased()) {
            self.input = ""
            await self.performReset()
            return
        }
        if Self.compactTriggers.contains(trimmed.lowercased()) {
            self.input = ""
            await self.performCompact()
            return
        }

        let sessionKey = self.sessionKey

        guard self.healthOK else {
            self.errorText = "Gateway health not OK; cannot send"
            return
        }

        self.isSending = true
        self.errorText = nil
        let runId = UUID().uuidString
        let messageText = trimmed.isEmpty && !self.attachments.isEmpty ? "See attached." : trimmed
        let thinkingLevel = self.thinkingLevel
        self.pendingRuns.insert(runId)
        self.armPendingRunTimeout(runId: runId)
        self.pendingToolCallsById = [:]
        self.streamingAssistantText = nil

        // Optimistically append user message to UI.
        var userContent: [OpenClawChatMessageContent] = [
            OpenClawChatMessageContent(
                type: "text",
                text: messageText,
                thinking: nil,
                thinkingSignature: nil,
                mimeType: nil,
                fileName: nil,
                content: nil,
                id: nil,
                name: nil,
                arguments: nil),
        ]
        let encodedAttachments = self.attachments.map { att -> OpenClawChatAttachmentPayload in
            OpenClawChatAttachmentPayload(
                type: att.type,
                mimeType: att.mimeType,
                fileName: att.fileName,
                content: att.data.base64EncodedString())
        }
        for att in encodedAttachments {
            userContent.append(
                OpenClawChatMessageContent(
                    type: att.type,
                    text: nil,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: att.mimeType,
                    fileName: att.fileName,
                    content: AnyCodable(att.content),
                    id: nil,
                    name: nil,
                    arguments: nil))
        }
        self.messages.append(
            OpenClawChatMessage(
                id: UUID(),
                role: "user",
                content: userContent,
                timestamp: Date().timeIntervalSince1970 * 1000))

        // Clear input immediately for responsive UX (before network await)
        self.input = ""
        self.attachments = []

        do {
            await self.waitForPendingModelPatches(in: sessionKey)
            let response = try await self.transport.sendMessage(
                sessionKey: sessionKey,
                message: messageText,
                thinking: thinkingLevel,
                idempotencyKey: runId,
                attachments: encodedAttachments)
            if response.runId != runId {
                self.clearPendingRun(runId)
                self.pendingRuns.insert(response.runId)
                self.armPendingRunTimeout(runId: response.runId)
            }
        } catch {
            self.clearPendingRun(runId)
            self.errorText = error.localizedDescription
            chatUILogger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
        }

        self.isSending = false
    }

    private func performAbort() async {
        guard !self.pendingRuns.isEmpty else { return }
        guard !self.isAborting else { return }
        self.isAborting = true
        defer { self.isAborting = false }

        let runIds = Array(self.pendingRuns)
        for runId in runIds {
            do {
                try await self.transport.abortRun(sessionKey: self.sessionKey, runId: runId)
            } catch {
                // Best-effort.
            }
        }
    }

    private func fetchSessions(limit: Int?) async {
        do {
            let res = try await self.transport.listSessions(limit: limit)
            self.sessions = res.sessions
            self.sessionDefaults = res.defaults
            self.syncSelectedModel()
        } catch {
            // Best-effort.
        }
    }

    private func fetchModels() async {
        do {
            self.modelChoices = try await self.transport.listModels()
            self.syncSelectedModel()
        } catch {
            // Best-effort.
        }
    }

    private func performSwitchSession(to sessionKey: String) async {
        let next = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        guard next != self.sessionKey else { return }
        self.sessionKey = next
        self.modelSelectionID = Self.defaultModelSelectionID
        await self.bootstrap()
    }

    private func performReset() async {
        self.isLoading = true
        self.errorText = nil
        defer { self.isLoading = false }

        do {
            try await self.transport.resetSession(sessionKey: self.sessionKey)
        } catch {
            self.errorText = error.localizedDescription
            chatUILogger.error("session reset failed \(error.localizedDescription, privacy: .public)")
            return
        }

        await self.bootstrap()
    }

    private func performCompact() async {
        guard !self.isCompacting else { return }
        guard !self.isSending, self.pendingRuns.isEmpty, !self.isAborting else {
            self.errorText = "Wait for the current response before compacting the session."
            return
        }
        if let lastCompactAt,
           Date().timeIntervalSince(lastCompactAt) < self.compactCooldown
        {
            self.errorText = "Please wait before compacting this session again."
            return
        }

        self.isCompacting = true
        self.isLoading = true
        self.errorText = nil
        defer {
            self.isLoading = false
            self.isCompacting = false
        }

        do {
            try await self.transport.compactSession(sessionKey: self.sessionKey)
        } catch {
            self.errorText = "Unable to compact the session. Please try again."
            let nsError = error as NSError
            chatUILogger.error(
                "compact failed domain=\(nsError.domain, privacy: .public) code=\(nsError.code, privacy: .public)")
            chatUILogger.error("compact details=\(String(describing: error), privacy: .private)")
            return
        }

        self.lastCompactAt = Date()
        await self.bootstrap()
    }

    private func performSelectThinkingLevel(_ level: String) async {
        let next = Self.normalizedThinkingLevel(level) ?? "off"
        guard next != self.thinkingLevel else { return }

        let sessionKey = self.sessionKey
        self.thinkingLevel = next
        self.onThinkingLevelChanged?(next)
        self.nextThinkingSelectionRequestID &+= 1
        let requestID = self.nextThinkingSelectionRequestID
        self.latestThinkingSelectionRequestIDsBySession[sessionKey] = requestID
        self.latestThinkingLevelsBySession[sessionKey] = next

        do {
            try await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: next)
            guard requestID == self.latestThinkingSelectionRequestIDsBySession[sessionKey] else {
                let latest = self.latestThinkingLevelsBySession[sessionKey] ?? next
                guard latest != next else { return }
                try? await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: latest)
                return
            }
        } catch {
            guard sessionKey == self.sessionKey,
                  requestID == self.latestThinkingSelectionRequestIDsBySession[sessionKey]
            else { return }
            // Best-effort. Persisting the user's local preference matters more than a patch error here.
        }
    }

    private func performSelectModel(_ selectionID: String) async {
        let next = self.normalizedSelectionID(selectionID)
        guard next != self.modelSelectionID else { return }

        let sessionKey = self.sessionKey
        let previous = self.modelSelectionID
        let previousRequestID = self.latestModelSelectionRequestIDsBySession[sessionKey]
        self.nextModelSelectionRequestID &+= 1
        let requestID = self.nextModelSelectionRequestID
        let nextModelRef = self.modelRef(forSelectionID: next)
        self.latestModelSelectionRequestIDsBySession[sessionKey] = requestID
        self.latestModelSelectionIDsBySession[sessionKey] = next
        self.beginModelPatch(for: sessionKey)
        self.modelSelectionID = next
        self.errorText = nil
        defer { self.endModelPatch(for: sessionKey) }

        do {
            try await self.transport.setSessionModel(
                sessionKey: sessionKey,
                model: nextModelRef)
            guard requestID == self.latestModelSelectionRequestIDsBySession[sessionKey] else {
                // Keep older successful patches as rollback state, but do not replay
                // stale UI/session state over a newer in-flight or completed selection.
                self.lastSuccessfulModelSelectionIDsBySession[sessionKey] = next
                return
            }
            self.applySuccessfulModelSelection(next, sessionKey: sessionKey, syncSelection: true)
        } catch {
            guard requestID == self.latestModelSelectionRequestIDsBySession[sessionKey] else { return }
            self.latestModelSelectionIDsBySession[sessionKey] = previous
            if let previousRequestID {
                self.latestModelSelectionRequestIDsBySession[sessionKey] = previousRequestID
            } else {
                self.latestModelSelectionRequestIDsBySession.removeValue(forKey: sessionKey)
            }
            if self.lastSuccessfulModelSelectionIDsBySession[sessionKey] == previous {
                self.applySuccessfulModelSelection(
                    previous,
                    sessionKey: sessionKey,
                    syncSelection: sessionKey == self.sessionKey)
            }
            guard sessionKey == self.sessionKey else { return }
            self.modelSelectionID = previous
            self.errorText = error.localizedDescription
            chatUILogger.error("sessions.patch(model) failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func beginModelPatch(for sessionKey: String) {
        self.inFlightModelPatchCountsBySession[sessionKey, default: 0] += 1
    }

    private func endModelPatch(for sessionKey: String) {
        let remaining = max(0, (self.inFlightModelPatchCountsBySession[sessionKey] ?? 0) - 1)
        if remaining == 0 {
            self.inFlightModelPatchCountsBySession.removeValue(forKey: sessionKey)
            let waiters = self.modelPatchWaitersBySession.removeValue(forKey: sessionKey) ?? []
            for waiter in waiters {
                waiter.resume()
            }
            return
        }
        self.inFlightModelPatchCountsBySession[sessionKey] = remaining
    }

    private func waitForPendingModelPatches(in sessionKey: String) async {
        guard (self.inFlightModelPatchCountsBySession[sessionKey] ?? 0) > 0 else { return }
        await withCheckedContinuation { continuation in
            self.modelPatchWaitersBySession[sessionKey, default: []].append(continuation)
        }
    }

    private func placeholderSession(key: String) -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil)
    }

    private func syncSelectedModel() {
        let currentSession = self.sessions.first(where: { $0.key == self.sessionKey })
        let explicitModelID = self.normalizedModelSelectionID(
            currentSession?.model,
            provider: currentSession?.modelProvider)
        if let explicitModelID {
            self.lastSuccessfulModelSelectionIDsBySession[self.sessionKey] = explicitModelID
            self.modelSelectionID = explicitModelID
            return
        }
        self.lastSuccessfulModelSelectionIDsBySession[self.sessionKey] = Self.defaultModelSelectionID
        self.modelSelectionID = Self.defaultModelSelectionID
    }

    private func normalizedSelectionID(_ selectionID: String) -> String {
        let trimmed = selectionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Self.defaultModelSelectionID }
        return trimmed
    }

    private func normalizedModelSelectionID(_ modelID: String?, provider: String? = nil) -> String? {
        guard let modelID else { return nil }
        let trimmed = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let provider = Self.normalizedProvider(provider) {
            let providerQualified = Self.providerQualifiedModelSelectionID(modelID: trimmed, provider: provider)
            if let match = self.modelChoices.first(where: {
                $0.selectionID == providerQualified ||
                    ($0.modelID == trimmed && Self.normalizedProvider($0.provider) == provider)
            }) {
                return match.selectionID
            }
            return providerQualified
        }
        if self.modelChoices.contains(where: { $0.selectionID == trimmed }) {
            return trimmed
        }
        let matches = self.modelChoices.filter { $0.modelID == trimmed || $0.selectionID == trimmed }
        if matches.count == 1 {
            return matches[0].selectionID
        }
        return trimmed
    }

    private func modelRef(forSelectionID selectionID: String) -> String? {
        let normalized = self.normalizedSelectionID(selectionID)
        if normalized == Self.defaultModelSelectionID {
            return nil
        }
        return normalized
    }

    private func modelLabel(for modelID: String) -> String {
        self.modelChoices.first(where: { $0.selectionID == modelID || $0.modelID == modelID })?.displayLabel ??
            modelID
    }

    private func applySuccessfulModelSelection(_ selectionID: String, sessionKey: String, syncSelection: Bool) {
        self.lastSuccessfulModelSelectionIDsBySession[sessionKey] = selectionID
        let resolved = self.resolvedSessionModelIdentity(forSelectionID: selectionID)
        self.updateCurrentSessionModel(
            modelID: resolved.modelID,
            modelProvider: resolved.modelProvider,
            sessionKey: sessionKey,
            syncSelection: syncSelection)
    }

    private func resolvedSessionModelIdentity(forSelectionID selectionID: String)
    -> (modelID: String?, modelProvider: String?) {
        guard let modelRef = self.modelRef(forSelectionID: selectionID) else {
            return (nil, nil)
        }
        if let choice = self.modelChoices.first(where: { $0.selectionID == modelRef }) {
            return (choice.modelID, Self.normalizedProvider(choice.provider))
        }
        return (modelRef, nil)
    }

    private static func normalizedProvider(_ provider: String?) -> String? {
        let trimmed = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func providerQualifiedModelSelectionID(modelID: String, provider: String) -> String {
        let providerPrefix = "\(provider)/"
        if modelID.hasPrefix(providerPrefix) {
            return modelID
        }
        return "\(provider)/\(modelID)"
    }

    private func updateCurrentSessionModel(
        modelID: String?,
        modelProvider: String?,
        sessionKey: String,
        syncSelection: Bool)
    {
        if let index = self.sessions.firstIndex(where: { $0.key == sessionKey }) {
            let current = self.sessions[index]
            self.sessions[index] = OpenClawChatSessionEntry(
                key: current.key,
                kind: current.kind,
                displayName: current.displayName,
                surface: current.surface,
                subject: current.subject,
                room: current.room,
                space: current.space,
                updatedAt: current.updatedAt,
                sessionId: current.sessionId,
                systemSent: current.systemSent,
                abortedLastRun: current.abortedLastRun,
                thinkingLevel: current.thinkingLevel,
                verboseLevel: current.verboseLevel,
                inputTokens: current.inputTokens,
                outputTokens: current.outputTokens,
                totalTokens: current.totalTokens,
                modelProvider: modelProvider,
                model: modelID,
                contextTokens: current.contextTokens)
        } else {
            let placeholder = self.placeholderSession(key: sessionKey)
            self.sessions.append(
                OpenClawChatSessionEntry(
                    key: placeholder.key,
                    kind: placeholder.kind,
                    displayName: placeholder.displayName,
                    surface: placeholder.surface,
                    subject: placeholder.subject,
                    room: placeholder.room,
                    space: placeholder.space,
                    updatedAt: placeholder.updatedAt,
                    sessionId: placeholder.sessionId,
                    systemSent: placeholder.systemSent,
                    abortedLastRun: placeholder.abortedLastRun,
                    thinkingLevel: placeholder.thinkingLevel,
                    verboseLevel: placeholder.verboseLevel,
                    inputTokens: placeholder.inputTokens,
                    outputTokens: placeholder.outputTokens,
                    totalTokens: placeholder.totalTokens,
                    modelProvider: modelProvider,
                    model: modelID,
                    contextTokens: placeholder.contextTokens))
        }
        if syncSelection {
            self.syncSelectedModel()
        }
    }

    private func handleTransportEvent(_ evt: OpenClawChatTransportEvent) {
        switch evt {
        case let .health(ok):
            self.healthOK = ok
        case .tick:
            Task { await self.pollHealthIfNeeded(force: false) }
        case let .chat(chat):
            self.handleChatEvent(chat)
        case let .sessionMessage(message):
            self.handleSessionMessageEvent(message)
        case let .agent(agent):
            self.handleAgentEvent(agent)
        case .seqGap:
            self.errorText = nil
            self.clearPendingRuns(reason: nil)
            Task {
                await self.refreshHistoryAfterRun()
                await self.pollHealthIfNeeded(force: true)
            }
        }
    }

    private func handleSessionMessageEvent(_ payload: OpenClawSessionMessageEventPayload) {
        if let sessionKey = payload.sessionKey,
           !Self.matchesCurrentSessionKey(incoming: sessionKey, current: self.sessionKey)
        {
            return
        }

        guard let message = payload.message else { return }
        guard message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" else {
            return
        }
        if self.pendingRunCount > 0 {
            return
        }

        let sanitized = Self.stripInboundMetadata(from: message)
        let reconciled = Self.reconcileMessageIDs(previous: self.messages, incoming: self.messages + [sanitized])
        self.messages = Self.dedupeMessages(reconciled)
    }

    private func handleChatEvent(_ chat: OpenClawChatEventPayload) {
        let isOurRun = chat.runId.flatMap { self.pendingRuns.contains($0) } ?? false

        // Gateway may publish canonical session keys (for example "agent:main:main")
        // even when this view currently uses an alias key (for example "main").
        // Never drop events for our own pending run on key mismatch, or the UI can stay
        // stuck at "thinking" until the user reopens and forces a history reload.
        if let sessionKey = chat.sessionKey,
           !Self.matchesCurrentSessionKey(incoming: sessionKey, current: self.sessionKey),
           !isOurRun
        {
            return
        }
        if !isOurRun {
            // Keep multiple clients in sync: if another client finishes a run for our session, refresh history.
            switch chat.state {
            case "final", "aborted", "error":
                self.streamingAssistantText = nil
                self.pendingToolCallsById = [:]
                Task { await self.refreshHistoryAfterRun() }
            default:
                break
            }
            return
        }

        switch chat.state {
        case "final", "aborted", "error":
            if chat.state == "error" {
                self.errorText = chat.errorMessage ?? "Chat failed"
            }
            if let runId = chat.runId {
                self.clearPendingRun(runId)
            } else if self.pendingRuns.count <= 1 {
                self.clearPendingRuns(reason: nil)
            }
            self.pendingToolCallsById = [:]
            self.streamingAssistantText = nil
            Task { await self.refreshHistoryAfterRun() }
        default:
            break
        }
    }

    private static func matchesCurrentSessionKey(incoming: String, current: String) -> Bool {
        let incomingNormalized = incoming.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let currentNormalized = current.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if incomingNormalized == currentNormalized {
            return true
        }
        // Common alias pair in operator clients: UI uses "main" while gateway emits canonical.
        if (incomingNormalized == "agent:main:main" && currentNormalized == "main") ||
            (incomingNormalized == "main" && currentNormalized == "agent:main:main")
        {
            return true
        }
        return false
    }

    private func handleAgentEvent(_ evt: OpenClawAgentEventPayload) {
        if let sessionId, evt.runId != sessionId {
            return
        }

        switch evt.stream {
        case "assistant":
            if let text = evt.data["text"]?.value as? String {
                self.streamingAssistantText = text
            }
        case "tool":
            guard let phase = evt.data["phase"]?.value as? String else { return }
            guard let name = evt.data["name"]?.value as? String else { return }
            guard let toolCallId = evt.data["toolCallId"]?.value as? String else { return }
            if phase == "start" {
                let args = evt.data["args"]
                self.pendingToolCallsById[toolCallId] = OpenClawChatPendingToolCall(
                    toolCallId: toolCallId,
                    name: name,
                    args: args,
                    startedAt: evt.ts.map(Double.init) ?? Date().timeIntervalSince1970 * 1000,
                    isError: nil)
            } else if phase == "result" {
                self.pendingToolCallsById[toolCallId] = nil
            }
        default:
            break
        }
    }

    private func refreshHistoryAfterRun() async {
        do {
            let payload = try await self.transport.requestHistory(sessionKey: self.sessionKey)
            self.messages = Self.reconcileRunRefreshMessages(
                previous: self.messages,
                incoming: Self.decodeMessages(payload.messages ?? []))
            self.sessionId = payload.sessionId
            if !self.prefersExplicitThinkingLevel,
               let level = Self.normalizedThinkingLevel(payload.thinkingLevel)
            {
                self.thinkingLevel = level
            }
        } catch {
            chatUILogger.error("refresh history failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func armPendingRunTimeout(runId: String) {
        self.pendingRunTimeoutTasks[runId]?.cancel()
        self.pendingRunTimeoutTasks[runId] = Task { [weak self] in
            let timeoutMs = await MainActor.run { self?.pendingRunTimeoutMs ?? 0 }
            try? await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            await MainActor.run { [weak self] in
                guard let self else { return }
                guard self.pendingRuns.contains(runId) else { return }
                self.clearPendingRun(runId)
                self.errorText = "Timed out waiting for a reply; try again or refresh."
            }
        }
    }

    private func clearPendingRun(_ runId: String) {
        self.pendingRuns.remove(runId)
        self.pendingRunTimeoutTasks[runId]?.cancel()
        self.pendingRunTimeoutTasks[runId] = nil
    }

    private func clearPendingRuns(reason: String?) {
        for runId in self.pendingRuns {
            self.pendingRunTimeoutTasks[runId]?.cancel()
        }
        self.pendingRunTimeoutTasks.removeAll()
        self.pendingRuns.removeAll()
        if let reason, !reason.isEmpty {
            self.errorText = reason
        }
    }

    private func pollHealthIfNeeded(force: Bool) async {
        if !force, let last = self.lastHealthPollAt, Date().timeIntervalSince(last) < 10 {
            return
        }
        self.lastHealthPollAt = Date()
        do {
            let ok = try await self.transport.requestHealth(timeoutMs: 5000)
            self.healthOK = ok
        } catch {
            self.healthOK = false
        }
    }

    private func loadAttachments(urls: [URL]) async {
        for url in urls {
            do {
                let data = try await Task.detached { try Data(contentsOf: url) }.value
                await self.addImageAttachment(
                    url: url,
                    data: data,
                    fileName: url.lastPathComponent,
                    mimeType: Self.mimeType(for: url) ?? "application/octet-stream")
            } catch {
                await MainActor.run { self.errorText = error.localizedDescription }
            }
        }
    }

    private static func mimeType(for url: URL) -> String? {
        let ext = url.pathExtension
        guard !ext.isEmpty else { return nil }
        return (UTType(filenameExtension: ext) ?? .data).preferredMIMEType
    }

    private func addImageAttachment(url: URL?, data: Data, fileName: String, mimeType: String) async {
        if data.count > 5_000_000 {
            self.errorText = "Attachment \(fileName) exceeds 5 MB limit"
            return
        }

        let uti: UTType = {
            if let url {
                return UTType(filenameExtension: url.pathExtension) ?? .data
            }
            return UTType(mimeType: mimeType) ?? .data
        }()
        guard uti.conforms(to: .image) else {
            self.errorText = "Only image attachments are supported right now"
            return
        }

        let preview = Self.previewImage(data: data)
        self.attachments.append(
            OpenClawPendingAttachment(
                url: url,
                data: data,
                fileName: fileName,
                mimeType: mimeType,
                preview: preview))
    }

    private static func previewImage(data: Data) -> OpenClawPlatformImage? {
        #if canImport(AppKit)
        NSImage(data: data)
        #elseif canImport(UIKit)
        UIImage(data: data)
        #else
        nil
        #endif
    }

    private static func normalizedThinkingLevel(_ level: String?) -> String? {
        guard let level else { return nil }
        let trimmed = level.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"].contains(trimmed) else {
            return nil
        }
        return trimmed
    }
}
