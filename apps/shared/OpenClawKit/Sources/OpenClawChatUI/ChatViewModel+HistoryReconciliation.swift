import Foundation
import OpenClawKit

extension OpenClawChatViewModel {
    static func decodeMessages(_ raw: [AnyCodable]) -> [OpenClawChatMessage] {
        let decoded = raw.compactMap { item in
            (try? ChatPayloadDecoding.decode(item, as: OpenClawChatMessage.self))
                .map { Self.stripInboundMetadata(from: $0) }
        }
        return Self.dedupeMessages(decoded)
    }

    static func stripInboundMetadata(from message: OpenClawChatMessage) -> OpenClawChatMessage {
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
                durationSeconds: content.durationSeconds,
                content: content.content,
                id: content.id,
                name: content.name,
                arguments: content.arguments,
                details: content.details,
                isError: content.isError)
        }

        return OpenClawChatMessage(
            id: message.id,
            role: message.role,
            content: sanitizedContent,
            timestamp: message.timestamp,
            idempotencyKey: message.idempotencyKey,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            usage: message.usage,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
            details: message.details,
            isError: message.isError)
    }

    static func messageContentFingerprint(for message: OpenClawChatMessage) -> String {
        message.content.map { item in
            let type = (item.type ?? "text").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let text = (item.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let id = (item.id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let name = (item.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let fileName = (item.fileName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return [type, text, id, name, fileName].joined(separator: "\\u{001F}")
        }.joined(separator: "\\u{001E}")
    }

    static func finalMessageContentFingerprint(for message: OpenClawChatMessage) -> String {
        message.content.map { item in
            let type = (item.type ?? "text").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let text = (item.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return [type, text].joined(separator: "\\u{001F}")
        }.joined(separator: "\\u{001E}")
    }

    static func messageIdentityKey(for message: OpenClawChatMessage) -> String? {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !role.isEmpty else { return nil }

        // The gateway persists this key with the canonical user row. Prefer it
        // so a server timestamp change cannot replace the optimistic row's ID.
        if let idempotencyKey = Self.normalizedIdempotencyKey(message.idempotencyKey) {
            return [role, "idempotency", idempotencyKey].joined(separator: "|")
        }

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

    static func userRefreshIdentityKey(for message: OpenClawChatMessage) -> String? {
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

    static func finalMessageReconciliationKey(for message: OpenClawChatMessage) -> String? {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard role == "assistant" else { return nil }

        // chat.final and session.message can serialize the same final row with
        // different timestamps/content ids. Reconciliation prefers the durable
        // gateway run key, with user-turn scope as a legacy fallback.
        let contentFingerprint = Self.finalMessageContentFingerprint(for: message)
        let toolCallId = (message.toolCallId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let toolName = (message.toolName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if contentFingerprint.isEmpty, toolCallId.isEmpty, toolName.isEmpty {
            return nil
        }
        return [role, toolCallId, toolName, contentFingerprint].joined(separator: "|")
    }

    static func normalizedRunID(_ runId: String?) -> String? {
        let trimmed = runId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func normalizedIdempotencyKey(_ key: String?) -> String? {
        let trimmed = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func adoptingCanonicalMessage(
        _ incoming: OpenClawChatMessage,
        over existing: OpenClawChatMessage) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            id: existing.id,
            role: incoming.role,
            content: self.preservingLocalAudioDurations(
                in: incoming.content,
                from: existing.content),
            timestamp: incoming.timestamp ?? existing.timestamp,
            idempotencyKey: incoming.idempotencyKey,
            toolCallId: incoming.toolCallId,
            toolName: incoming.toolName,
            usage: incoming.usage,
            stopReason: incoming.stopReason,
            errorMessage: incoming.errorMessage,
            details: incoming.details,
            isError: incoming.isError)
    }

    private static func preservingLocalAudioDurations(
        in incoming: [OpenClawChatMessageContent],
        from existing: [OpenClawChatMessageContent]) -> [OpenClawChatMessageContent]
    {
        let localDurations = existing
            .filter { $0.mimeType?.hasPrefix("audio/") == true }
            .map(\.durationSeconds)
        var audioIndex = 0
        return incoming.map { content in
            guard content.mimeType?.hasPrefix("audio/") == true else { return content }
            defer { audioIndex += 1 }
            guard content.durationSeconds == nil,
                  localDurations.indices.contains(audioIndex),
                  let localDuration = localDurations[audioIndex]
            else {
                return content
            }
            return OpenClawChatMessageContent(
                type: content.type,
                text: content.text,
                thinking: content.thinking,
                thinkingSignature: content.thinkingSignature,
                mimeType: content.mimeType,
                fileName: content.fileName,
                durationSeconds: localDuration,
                content: content.content,
                id: content.id,
                name: content.name,
                arguments: content.arguments,
                details: content.details,
                isError: content.isError)
        }
    }

    func currentRunMessageScope() -> RunMessageScope {
        RunMessageScope(
            session: self.currentSessionSnapshot(),
            latestUserTurn: Self.latestUserTurn(in: self.messages))
    }

    func runMessageScope(for runId: String?) -> RunMessageScope {
        guard let runId = Self.normalizedRunID(runId),
              let scope = self.runMessageScopesByRunID[runId],
              self.isCurrentSession(scope.session)
        else {
            return self.currentRunMessageScope()
        }
        return scope
    }

    static func isSameUserTurnBoundary(_ lhs: LatestUserTurn?, _ rhs: LatestUserTurn?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil):
            return true
        case let (lhs?, rhs?):
            if let lhsIdempotencyKey = lhs.idempotencyKey,
               let rhsIdempotencyKey = rhs.idempotencyKey,
               lhsIdempotencyKey == rhsIdempotencyKey
            {
                return true
            }
            if let lhsKey = lhs.refreshKey, let rhsKey = rhs.refreshKey {
                return lhsKey == rhsKey && lhs.occurrence == rhs.occurrence
            }
            if lhs.idempotencyKey != nil || rhs.idempotencyKey != nil {
                return false
            }
            return lhs.refreshKey == nil &&
                rhs.refreshKey == nil &&
                lhs.occurrence == rhs.occurrence &&
                lhs.timestamp == rhs.timestamp
        default:
            return false
        }
    }

    static func containsUserTurn(
        _ latestUserTurn: LatestUserTurn?,
        in messages: [OpenClawChatMessage]) -> Bool
    {
        guard let latestUserTurn else { return false }
        if let idempotencyKey = latestUserTurn.idempotencyKey {
            return messages.contains { message in
                message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                    Self.normalizedIdempotencyKey(message.idempotencyKey) == idempotencyKey
            }
        }
        if let refreshKey = latestUserTurn.refreshKey {
            let occurrenceCount = messages.count { Self.userRefreshIdentityKey(for: $0) == refreshKey }
            return occurrenceCount >= latestUserTurn.occurrence
        }
        guard let timestamp = latestUserTurn.timestamp else { return false }
        return messages.contains { message in
            message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                message.timestamp == timestamp
        }
    }

    static func indexAfterLatestUserTurn(
        _ latestUserTurn: LatestUserTurn?,
        in messages: [OpenClawChatMessage])
        -> [OpenClawChatMessage].Index
    {
        guard let latestUserTurn else { return messages.startIndex }
        if let idempotencyKey = latestUserTurn.idempotencyKey,
           let index = messages.lastIndex(where: { message in
               message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                   Self.normalizedIdempotencyKey(message.idempotencyKey) == idempotencyKey
           })
        {
            return messages.index(after: index)
        } else if let refreshKey = latestUserTurn.refreshKey {
            var occurrence = 0
            for index in messages.indices {
                guard self.userRefreshIdentityKey(for: messages[index]) == refreshKey else { continue }
                occurrence += 1
                if occurrence == latestUserTurn.occurrence {
                    return messages.index(after: index)
                }
            }
        } else if let timestamp = latestUserTurn.timestamp,
                  let index = messages.lastIndex(where: { message in
                      message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                          message.timestamp == timestamp
                  })
        {
            return messages.index(after: index)
        }

        return messages.lastIndex(where: { message in
            message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
        }).map { messages.index(after: $0) } ?? messages.startIndex
    }

    static func messageRange(
        after latestUserTurn: LatestUserTurn?,
        in messages: [OpenClawChatMessage]) -> Range<[OpenClawChatMessage].Index>
    {
        let start = self.indexAfterLatestUserTurn(latestUserTurn, in: messages)
        guard latestUserTurn != nil, start < messages.endIndex else {
            return start..<messages.endIndex
        }
        // Without an exact assistant run key, any user row is a turn boundary.
        // Steering and channel-originated turns are both metadata-free, so
        // widening this range would make distinct replies indistinguishable.
        let end = messages[start...].firstIndex { message in
            message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
        } ?? messages.endIndex
        return start..<end
    }

    func hasCanonicalFinalMessageMatching(
        _ message: OpenClawChatMessage,
        scope: RunMessageScope) -> Bool
    {
        guard let key = Self.finalMessageReconciliationKey(for: message) else { return false }
        guard self.isCurrentSession(scope.session) else { return false }
        if let runId = Self.normalizedIdempotencyKey(message.idempotencyKey) {
            return self.messages.contains { existing in
                self.provisionalFinalMessagesByID[existing.id] == nil &&
                    Self.normalizedIdempotencyKey(existing.idempotencyKey) == runId
            }
        }
        let searchRange = Self.messageRange(after: scope.latestUserTurn, in: self.messages)
        guard !searchRange.isEmpty else { return false }

        return self.messages[searchRange].contains { existing in
            self.provisionalFinalMessagesByID[existing.id] == nil &&
                Self.finalMessageReconciliationKey(for: existing) == key
        }
    }

    func adoptingProvisionalFinalMessageIDs(
        in incoming: [OpenClawChatMessage]) -> [OpenClawChatMessage]
    {
        guard !self.provisionalFinalMessagesByID.isEmpty, !incoming.isEmpty else { return incoming }
        var reconciled = incoming
        var claimedIncomingIndices = Set<Int>()

        // Provider-owned transcripts may replace the gateway run id with their
        // own durable idempotency key. Preserve the provisional row's UI identity
        // by falling back to content within the same user-turn boundary.
        for existing in self.messages {
            guard let provisional = self.provisionalFinalMessagesByID[existing.id] else { continue }
            let exactRunIndex = provisional.runId.flatMap { runId in
                reconciled.indices.last { index in
                    !claimedIncomingIndices.contains(index) &&
                        Self.isAssistantMessage(reconciled[index]) &&
                        Self.normalizedIdempotencyKey(reconciled[index].idempotencyKey) == runId
                }
            }
            let matchingIndex = exactRunIndex ?? {
                guard Self.containsUserTurn(provisional.scope.latestUserTurn, in: reconciled) else {
                    return nil
                }
                let range = Self.messageRange(after: provisional.scope.latestUserTurn, in: reconciled)
                return range.last { index in
                    !claimedIncomingIndices.contains(index) &&
                        Self.finalMessageReconciliationKey(for: reconciled[index]) == provisional.reconciliationKey
                }
            }()
            guard let matchingIndex else { continue }
            claimedIncomingIndices.insert(matchingIndex)
            reconciled[matchingIndex] = Self.adoptingCanonicalMessage(
                reconciled[matchingIndex],
                over: existing)
        }
        return reconciled
    }

    func prunePendingLocalUserEchoMessageIDs() {
        guard !self.pendingLocalUserEchoMessageIDsByRunID.isEmpty else { return }
        let visibleMessageIDs = Set(messages.map(\.id))
        self.pendingLocalUserEchoMessageIDsByRunID = self.pendingLocalUserEchoMessageIDsByRunID.filter {
            self.pendingRuns.contains($0.key) && visibleMessageIDs.contains($0.value)
        }
    }

    func pruneProvisionalFinalMessages() {
        guard !self.provisionalFinalMessagesByID.isEmpty else { return }
        let visibleMessageIDs = Set(messages.map(\.id))
        self.provisionalFinalMessagesByID = self.provisionalFinalMessagesByID.filter { entry in
            visibleMessageIDs.contains(entry.key) && self.isCurrentSession(entry.value.scope.session)
        }
    }

    func clearProvisionalFinalMarkersAdoptedByHistory(_ incoming: [OpenClawChatMessage]) {
        let adoptedMessageIDs = Set(incoming.map(\.id))
        self.provisionalFinalMessagesByID = self.provisionalFinalMessagesByID.filter {
            !adoptedMessageIDs.contains($0.key)
        }
    }

    func pruneRunMessageScopes() {
        self.runMessageScopesByRunID = self.runMessageScopesByRunID.filter { entry in
            self.isCurrentSession(entry.value.session)
        }
        guard self.runMessageScopesByRunID.count > 64 else { return }
        let referencedRunIDs = Set(self.pendingRuns)
            .union(self.provisionalFinalMessagesByID.values.compactMap(\.runId))
        self.runMessageScopesByRunID = self.runMessageScopesByRunID.filter { entry in
            referencedRunIDs.contains(entry.key)
        }
    }

    func adoptCorrelatedUserMessage(incoming: OpenClawChatMessage) -> Bool {
        guard incoming.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" else {
            return false
        }
        // The final event can clear pending bookkeeping before session.message
        // arrives. The persisted key still identifies the exact user turn, so
        // adopt the durable row without losing the optimistic row's UI identity.
        guard let incomingKey = Self.normalizedIdempotencyKey(incoming.idempotencyKey) else { return false }
        let matchIndex = self.messages.lastIndex { existing in
            existing.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                Self.normalizedIdempotencyKey(existing.idempotencyKey) == incomingKey
        }
        guard let matchIndex else {
            return false
        }

        let existing = self.messages[matchIndex]
        self.pendingLocalUserEchoMessageIDsByRunID = self.pendingLocalUserEchoMessageIDsByRunID.filter {
            $0.value != existing.id
        }
        var updated = self.messages
        updated[matchIndex] = Self.adoptingCanonicalMessage(incoming, over: existing)
        self.replaceMessages(Self.dedupeMessages(updated))
        self.prunePendingLocalUserEchoMessageIDs()
        return true
    }

    func rekeyLocalUserEcho(
        messageID: UUID?,
        runId: String) -> (pendingMessageID: UUID?, scope: RunMessageScope)?
    {
        guard let messageID, let matchIndex = self.messages.firstIndex(where: { $0.id == messageID }) else {
            return nil
        }
        let existing = self.messages[matchIndex]
        let remoteKey = "\(runId):user"
        let canonical = self.messages.last { message in
            message.id != messageID &&
                message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                Self.normalizedIdempotencyKey(message.idempotencyKey) == remoteKey
        }
        var updated = self.messages
        updated[matchIndex] = if let canonical {
            Self.adoptingCanonicalMessage(canonical, over: existing)
        } else {
            OpenClawChatMessage(
                id: existing.id,
                role: existing.role,
                content: existing.content,
                timestamp: existing.timestamp,
                idempotencyKey: remoteKey,
                toolCallId: existing.toolCallId,
                toolName: existing.toolName,
                usage: existing.usage,
                stopReason: existing.stopReason,
                errorMessage: existing.errorMessage,
                details: existing.details,
                isError: existing.isError)
        }
        self.replaceMessages(Self.dedupeMessages(updated))
        guard let survivingIndex = self.messages.firstIndex(where: { message in
            message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                Self.normalizedIdempotencyKey(message.idempotencyKey) == remoteKey
        }) else {
            return nil
        }
        let survivingMessage = self.messages[survivingIndex]
        let scope = RunMessageScope(
            session: self.currentSessionSnapshot(),
            latestUserTurn: Self.userTurn(at: survivingIndex, in: self.messages))
        let pendingMessageID = survivingMessage.id == messageID ? messageID : nil
        return (pendingMessageID, scope)
    }

    func rescopeProvisionalFinalMessages(runId: String, scope: RunMessageScope) {
        let matchingMessageIDs = self.provisionalFinalMessagesByID.compactMap { messageID, provisional in
            provisional.runId == runId ? messageID : nil
        }
        for messageID in matchingMessageIDs {
            self.provisionalFinalMessagesByID[messageID]?.scope = scope
        }
    }

    func hasRecordedFinalMessage(runId: String) -> Bool {
        if self.provisionalFinalMessagesByID.values.contains(where: { $0.runId == runId }) {
            return true
        }
        return self.messages.contains { message in
            Self.isAssistantMessage(message) &&
                Self.normalizedIdempotencyKey(message.idempotencyKey) == runId
        }
    }

    func adoptProvisionalFinalMessage(incoming: OpenClawChatMessage) -> Bool {
        let incomingRunId = Self.normalizedIdempotencyKey(incoming.idempotencyKey)
        let incomingKey = Self.finalMessageReconciliationKey(for: incoming)
        guard incomingRunId != nil || incomingKey != nil else { return false }
        let canonicalUserTurn = self.currentRunMessageScope().latestUserTurn
        guard let matchIndex = messages.indices.last(where: { index in
            let existing = self.messages[index]
            guard let provisional = self.provisionalFinalMessagesByID[existing.id] else { return false }
            if let incomingRunId, provisional.runId == incomingRunId {
                return true
            }
            return provisional.reconciliationKey == incomingKey &&
                Self.isSameUserTurnBoundary(provisional.scope.latestUserTurn, canonicalUserTurn)
        }) else {
            return false
        }

        let existing = self.messages[matchIndex]
        let provisional = self.provisionalFinalMessagesByID[existing.id]
        var updated = self.messages
        updated.remove(at: matchIndex)
        // The durable session.message arrives at its transcript position. A
        // steering row may have been delivered after chat.final, so append the
        // adopted row here while retaining the provisional UUID.
        updated.append(Self.adoptingCanonicalMessage(incoming, over: existing))
        self.provisionalFinalMessagesByID.removeValue(forKey: existing.id)
        if let runId = provisional?.runId {
            self.runMessageScopesByRunID.removeValue(forKey: runId)
        }
        self.replaceMessages(Self.dedupeMessages(updated))
        self.pruneProvisionalFinalMessages()
        self.pruneRunMessageScopes()
        return true
    }

    static func reconcileMessageIDs(
        previous: [OpenClawChatMessage],
        incoming: [OpenClawChatMessage]) -> [OpenClawChatMessage]
    {
        guard !previous.isEmpty, !incoming.isEmpty else { return incoming }

        var previousMessagesByKey: [String: [OpenClawChatMessage]] = [:]
        for message in previous {
            guard let key = Self.messageIdentityKey(for: message) else { continue }
            previousMessagesByKey[key, default: []].append(message)
        }

        return incoming.map { message in
            guard let key = Self.messageIdentityKey(for: message),
                  var matches = previousMessagesByKey[key],
                  let existing = matches.first
            else {
                return message
            }
            matches.removeFirst()
            if matches.isEmpty {
                previousMessagesByKey.removeValue(forKey: key)
            } else {
                previousMessagesByKey[key] = matches
            }
            guard existing.id != message.id else { return message }
            return Self.adoptingCanonicalMessage(message, over: existing)
        }
    }

    static func reconcileRunRefreshMessages(
        previous: [OpenClawChatMessage],
        incoming: [OpenClawChatMessage],
        pendingLocalUserEchoIDs: Set<UUID>) -> [OpenClawChatMessage]
    {
        guard !previous.isEmpty else { return incoming }
        guard !incoming.isEmpty else { return previous }

        func countKeys(_ keys: [String]) -> [String: Int] {
            keys.reduce(into: [:]) { counts, key in
                counts[key, default: 0] += 1
            }
        }

        var reconciled = Self.reconcileMessageIDs(previous: previous, incoming: incoming)
        let incomingIdempotencyKeys = Set(reconciled.compactMap { message in
            Self.normalizedIdempotencyKey(message.idempotencyKey)
        })
        let incomingIdentityKeys = Set(reconciled.compactMap(Self.messageIdentityKey(for:)))
        var remainingIncomingUserRefreshCounts = countKeys(
            reconciled.compactMap(Self.userRefreshIdentityKey(for:)))

        // Exact history rows own their incoming user count before local echo matching.
        // Otherwise repeated same-text sends can consume the canonical row twice.
        for message in previous {
            guard let identityKey = Self.messageIdentityKey(for: message),
                  incomingIdentityKeys.contains(identityKey),
                  let userKey = Self.userRefreshIdentityKey(for: message),
                  let remaining = remainingIncomingUserRefreshCounts[userKey],
                  remaining > 0
            else {
                continue
            }
            remainingIncomingUserRefreshCounts[userKey] = remaining - 1
        }

        // Exact client correlation owns pending-send adoption. A metadata-free
        // row is ambiguous across clients, so retain both rather than lose a turn.
        let pendingLocalUsers = previous.filter { message in
            guard message.role.lowercased() == "user", pendingLocalUserEchoIDs.contains(message.id) else {
                return false
            }
            let matched = Self.normalizedIdempotencyKey(message.idempotencyKey)
                .map(incomingIdempotencyKeys.contains) ?? false
            guard matched else { return true }
            if let userKey = Self.userRefreshIdentityKey(for: message),
               let remaining = remainingIncomingUserRefreshCounts[userKey],
               remaining > 0
            {
                remainingIncomingUserRefreshCounts[userKey] = remaining - 1
            }
            return false
        }

        let lastCanonicalPreviousIndex = previous.lastIndex { message in
            guard let identityKey = Self.messageIdentityKey(for: message) else { return false }
            return incomingIdentityKeys.contains(identityKey)
        }
        let trailingLocalCandidates = lastCanonicalPreviousIndex.map { index in
            previous[previous.index(after: index)...]
        } ?? []

        let trailingLocalUsers = trailingLocalCandidates.filter { message in
            guard message.role.lowercased() == "user" else { return false }
            guard !pendingLocalUserEchoIDs.contains(message.id) else { return false }
            guard let identityKey = Self.messageIdentityKey(for: message) else { return true }
            guard !incomingIdentityKeys.contains(identityKey) else { return false }
            guard let userKey = Self.userRefreshIdentityKey(for: message) else { return true }
            let remaining = remainingIncomingUserRefreshCounts[userKey] ?? 0
            if remaining > 0 {
                remainingIncomingUserRefreshCounts[userKey] = remaining - 1
                return false
            }
            return true
        }
        let optimisticUserMessages = pendingLocalUsers + trailingLocalUsers

        guard !optimisticUserMessages.isEmpty else {
            return reconciled
        }

        for message in optimisticUserMessages {
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

    static func dedupeMessages(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
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

    static func dedupeKey(for message: OpenClawChatMessage) -> String? {
        if let idempotencyKey = normalizedIdempotencyKey(message.idempotencyKey) {
            return "\(message.role)|idempotency|\(idempotencyKey)"
        }
        guard let timestamp = message.timestamp else { return nil }
        let text = message.content.compactMap(\.text).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return "\(message.role)|\(timestamp)|\(text)"
    }
}

extension OpenClawChatViewModel {
    private func canApplyHistory(_ request: HistoryRequest) -> Bool {
        request.id >= self.latestAppliedHistoryRequestID &&
            self.isCurrentSession(request.session)
    }

    func advanceSessionGeneration() {
        self.sessionGeneration &+= 1
    }

    func invalidateRunSnapshots() {
        self.runOwnershipGeneration &+= 1
    }

    func invalidateHistorySnapshots() {
        self.historyMutationGeneration &+= 1
    }

    func beginHistoryRequest(
        for sessionSnapshot: SessionSnapshot? = nil,
        captureLatestUserTurn: Bool = true) -> HistoryRequest
    {
        self.lastIssuedHistoryRequestID &+= 1
        return HistoryRequest(
            id: self.lastIssuedHistoryRequestID,
            session: sessionSnapshot ?? self.currentSessionSnapshot(),
            pendingRunIDs: self.pendingRuns,
            visibleMessagesByID: Dictionary(uniqueKeysWithValues: self.messages.map { ($0.id, $0) }),
            historyMutationGeneration: self.historyMutationGeneration,
            runOwnershipGeneration: self.runOwnershipGeneration,
            latestUserTurn: captureLatestUserTurn ? Self.latestUserTurn(in: self.messages) : nil)
    }

    private func markHistoryRequestApplied(_ request: HistoryRequest) {
        self.latestAppliedHistoryRequestID = max(self.latestAppliedHistoryRequestID, request.id)
    }

    @discardableResult
    func applyHistoryPayload(
        _ payload: OpenClawChatHistoryPayload,
        for request: HistoryRequest,
        preservingOptimisticLocalMessages: Bool,
        syncThinkingOptions: Bool = false) -> Bool
    {
        guard self.canApplyHistory(request) else { return false }
        let incoming = self.adoptingProvisionalFinalMessageIDs(
            in: Self.decodeMessages(payload.messages ?? []))
        let unmatchedProvisionalFinalIDs = Set(provisionalFinalMessagesMissing(from: incoming).map(\.id))
        var retainedMessageIDs = unmatchedProvisionalFinalIDs
        if request.historyMutationGeneration != self.historyMutationGeneration {
            for message in self.messages where request.visibleMessagesByID[message.id] != message {
                let isMatchedProvisional = self.provisionalFinalMessagesByID[message.id] != nil &&
                    !unmatchedProvisionalFinalIDs.contains(message.id)
                if !isMatchedProvisional {
                    retainedMessageIDs.insert(message.id)
                }
            }
        }
        // Durable outbox rows remain authoritative until canonical history
        // confirms their idempotency key. Keep their bubbles through lagging
        // snapshots; a cold open reconstructs them from client state.
        retainedMessageIDs.formUnion(self.outboxCommandIDsByMessageID.keys)
        var nextMessages = if preservingOptimisticLocalMessages {
            Self.reconcileRunRefreshMessages(
                previous: self.messages,
                incoming: incoming,
                pendingLocalUserEchoIDs: Set(self.pendingLocalUserEchoMessageIDsByRunID.values))
        } else {
            Self.reconcileMessageIDs(previous: self.messages, incoming: incoming)
        }
        let reconciledMessageIDs = Set(nextMessages.map(\.id))
        nextMessages.append(contentsOf: self.messages.filter { message in
            retainedMessageIDs.contains(message.id) && !reconciledMessageIDs.contains(message.id)
        })
        nextMessages = Self.dedupeMessages(nextMessages)
        replaceMessages(nextMessages)
        confirmOutboxCommands(in: incoming)
        self.prunePendingLocalUserEchoMessageIDs()
        self.clearProvisionalFinalMarkersAdoptedByHistory(incoming)
        self.pruneProvisionalFinalMessages()
        self.pruneRunMessageScopes()
        self.rescopeRunsAdoptedAfterHistoryRequest(request)
        self.sessionId = payload.sessionId
        self.applyInFlightRunSnapshot(payload, for: request)
        // Incomplete refreshes can arrive before durable assistant history.
        // The latest visible user turn must survive answered before it can reject older replies.
        let canInvalidateOlderHistory = if let latestUserTurn = request.latestUserTurn {
            Self.hasAnsweredUser(latestUserTurn, in: self.messages)
        } else {
            !Self.hasUnansweredLatestUser(in: self.messages)
        }
        if canInvalidateOlderHistory {
            self.markHistoryRequestApplied(request)
        }
        self.clearActiveSessionRunIndicatorIfLatestUserAnswered()
        let appliedThinkingLevel = !self.prefersExplicitThinkingLevel
            ? Self.normalizedThinkingLevel(payload.thinkingLevel)
            : nil
        if let level = appliedThinkingLevel {
            self.preferredThinkingLevel = level
            self.thinkingLevel = level
        }
        if syncThinkingOptions || appliedThinkingLevel != nil {
            syncThinkingLevelOptions()
        }
        // Live history is the source of truth: it clears the cached marker and
        // is written through so the next cold open pre-paints current rows.
        self.hasAppliedLiveHistory = true
        self.isShowingCachedTranscript = false
        // An empty post-send refresh is incomplete by contract: reconciliation
        // preserves the visible transcript, so preserve its last canonical cache too.
        if !preservingOptimisticLocalMessages || !incoming.isEmpty {
            // The cache store writes only gateway-derived rows. It filters
            // locally retained outbox bubbles until history proves their keys.
            persistTranscriptToCache(
                sessionKey: request.session.key,
                agentID: request.session.agentID,
                messages: nextMessages,
                canonicalMessageIdempotencyKeys: Set(incoming.compactMap(\.idempotencyKey)))
        }
        // Wholesale history replacement drops local-only queued bubbles;
        // re-adopt or re-append them from the durable outbox.
        restoreOutboxMessages(session: request.session)
        self.applyDeferredExternalStateIfReady()
        return true
    }

    private func provisionalFinalMessagesMissing(
        from incoming: [OpenClawChatMessage]) -> [OpenClawChatMessage]
    {
        let incomingRunIds = Set(incoming.compactMap { Self.normalizedIdempotencyKey($0.idempotencyKey) })
        return self.messages.filter { message in
            guard let provisional = provisionalFinalMessagesByID[message.id] else { return false }
            if let runId = provisional.runId, incomingRunIds.contains(runId) {
                return false
            }
            guard Self.containsUserTurn(provisional.scope.latestUserTurn, in: incoming) else {
                return true
            }
            let searchRange = Self.messageRange(after: provisional.scope.latestUserTurn, in: incoming)
            return !incoming[searchRange].contains { incomingMessage in
                Self.finalMessageReconciliationKey(for: incomingMessage) == provisional.reconciliationKey
            }
        }
    }

    private func rescopeRunsAdoptedAfterHistoryRequest(_ request: HistoryRequest) {
        for runId in self.pendingRuns {
            let scope = self.runMessageScopesByRunID[runId]
            if !request.pendingRunIDs.contains(runId) || scope?.latestUserTurn == nil {
                self.runMessageScopesByRunID[runId] = self.currentRunMessageScope()
            }
        }
    }
}
