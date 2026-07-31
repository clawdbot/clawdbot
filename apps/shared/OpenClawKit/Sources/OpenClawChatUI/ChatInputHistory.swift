import Foundation

/// One session's in-memory composer recall state. Native history deliberately
/// stays process-local; unlike the web UI, it is not persisted across launches.
struct ChatInputHistory: Equatable, Sendable {
    static let limit = 100

    /// Newest entry first, matching the order traversed by Up.
    private(set) var entries: [String] = []
    private(set) var cursor: Int?
    private(set) var stashedDraft: String?
    private var hasSeededTranscript = false
    private var transcriptSnapshot: [String] = []
    private var pendingTranscriptEchoes: [String] = []

    var isRecalling: Bool {
        self.cursor != nil
    }

    mutating func record(_ input: String, transcriptEcho: String? = nil) {
        let recall = self.recallMarker()
        let text = Self.normalized(input)
        if !text.isEmpty, self.entries.first != text {
            self.entries.insert(text, at: 0)
            self.enforceLimit()
        }
        if let transcriptEcho {
            let echo = Self.normalized(transcriptEcho)
            if !echo.isEmpty, echo != text, self.transcriptSnapshot.contains(echo) {
                if let index = self.entries.firstIndex(of: echo) {
                    self.entries.remove(at: index)
                }
            } else if !echo.isEmpty,
                      !self.transcriptSnapshot.contains(echo),
                      self.pendingTranscriptEchoes.last != echo
            {
                self.pendingTranscriptEchoes.append(echo)
                if self.pendingTranscriptEchoes.count > Self.limit {
                    self.pendingTranscriptEchoes.removeFirst(self.pendingTranscriptEchoes.count - Self.limit)
                }
            }
        }
        if let recall {
            // The accepted send retired this text. If the user recalled during
            // the pending await, the stash holds the already-sent draft;
            // Escape/Down must not resurrect it into a duplicate send.
            if let stash = self.stashedDraft, Self.normalized(stash) == text {
                self.stashedDraft = ""
            }
            self.restoreRecall(recall)
        } else {
            self.resetNavigation()
        }
    }

    /// Reconciles canonical user messages with locally captured inputs. Inputs
    /// absent from the transcript (notably local slash commands) remain recallable.
    /// Fresh launches use visible transcript text by contract; without web-style
    /// persistence, generated quote markup cannot be safely reverse-engineered.
    mutating func seed(transcriptInputs: [String]) {
        var transcript: [String] = []
        for input in transcriptInputs {
            let text = Self.normalized(input)
            guard !text.isEmpty, transcript.last != text else { continue }
            transcript.append(text)
        }

        let recall = self.recallMarker()
        let delta = self.hasSeededTranscript
            ? Self.transcriptDelta(previous: self.transcriptSnapshot, current: transcript)
            : TranscriptDelta(older: transcript, newer: [])
        let olderAdditions = self.removePendingEchoes(from: delta.older)
        let newerAdditions = self.removePendingEchoes(from: delta.newer)
        for entry in olderAdditions.reversed() where self.entries.last != entry {
            self.entries.append(entry)
        }
        for entry in newerAdditions where self.entries.first != entry {
            // A newer transcript addition that already exists in history is a
            // restore after transient rollback (cache vs live pagination) or a
            // resend; move it to the front instead of duplicating the entry.
            if let existing = self.entries.firstIndex(of: entry) {
                self.entries.remove(at: existing)
            }
            self.entries.insert(entry, at: 0)
        }
        self.enforceLimit()
        self.transcriptSnapshot = transcript
        self.hasSeededTranscript = true

        if let recall {
            self.restoreRecall(recall)
        }
    }

    mutating func previous(draft: String) -> String? {
        guard !self.entries.isEmpty else { return nil }
        if self.cursor == nil {
            self.stashedDraft = draft
            self.cursor = 0
            return self.entries[0]
        }
        guard let cursor, cursor + 1 < self.entries.count else { return nil }
        self.cursor = cursor + 1
        return self.entries[cursor + 1]
    }

    mutating func next() -> String? {
        guard let cursor else { return nil }
        if cursor == 0 {
            let draft = self.stashedDraft ?? ""
            self.resetNavigation()
            return draft
        }
        self.cursor = cursor - 1
        return self.entries[cursor - 1]
    }

    mutating func cancel() -> String? {
        guard self.cursor != nil else { return nil }
        let draft = self.stashedDraft ?? ""
        self.resetNavigation()
        return draft
    }

    mutating func draftChanged(to draft: String) {
        guard let cursor, self.entries.indices.contains(cursor), self.entries[cursor] != draft else { return }
        self.resetNavigation()
    }

    func draftForSessionSwitch(currentDraft: String) -> String {
        self.cursor == nil ? currentDraft : (self.stashedDraft ?? "")
    }

    mutating func resetNavigation() {
        self.cursor = nil
        self.stashedDraft = nil
    }

    private mutating func enforceLimit() {
        // Accepted tradeoff: if the actively recalled entry is the evicted
        // oldest one, restoreRecall resets navigation and the stashed draft is
        // dropped. Guarding that corner is not worth extra recall state.
        if self.entries.count > Self.limit {
            self.entries.removeLast(self.entries.count - Self.limit)
        }
    }

    private struct RecallMarker {
        let value: String
        let occurrence: Int
    }

    private struct TranscriptDelta {
        let older: [String]
        let newer: [String]
    }

    private func recallMarker() -> RecallMarker? {
        guard let cursor, self.entries.indices.contains(cursor) else { return nil }
        let value = self.entries[cursor]
        // Count occurrences from the oldest end: accepted sends prepend at the
        // newest end, so newest-relative occurrence numbers would silently
        // re-point the cursor at a different duplicate after a late accept.
        let occurrence = self.entries[cursor...].filter { $0 == value }.count
        return RecallMarker(value: value, occurrence: occurrence)
    }

    private mutating func restoreRecall(_ marker: RecallMarker) {
        self.cursor = Self.index(ofOccurrence: marker.occurrence, value: marker.value, in: self.entries)
        if self.cursor == nil {
            self.resetNavigation()
        }
    }

    private mutating func removePendingEchoes(from entries: [String]) -> [String] {
        var visible: [String] = []
        for entry in entries {
            if let index = self.pendingTranscriptEchoes.firstIndex(of: entry) {
                self.pendingTranscriptEchoes.remove(at: index)
            } else {
                visible.append(entry)
            }
        }
        return visible
    }

    private static func transcriptDelta(previous: [String], current: [String]) -> TranscriptDelta {
        if let range = subrange(of: previous, in: current) {
            return TranscriptDelta(
                older: Array(current[..<range.lowerBound]),
                newer: Array(current[range.upperBound...]))
        }
        if Self.subrange(of: current, in: previous) != nil {
            return TranscriptDelta(older: [], newer: [])
        }
        for overlap in stride(from: min(previous.count, current.count), through: 1, by: -1)
            where previous.suffix(overlap).elementsEqual(current.prefix(overlap))
        {
            return TranscriptDelta(older: [], newer: Array(current.dropFirst(overlap)))
        }

        var previousCounts = Dictionary(previous.map { ($0, 1) }, uniquingKeysWith: +)
        let additions = current.filter { entry in
            guard let count = previousCounts[entry], count > 0 else { return true }
            previousCounts[entry] = count - 1
            return false
        }
        return TranscriptDelta(older: [], newer: additions)
    }

    private static func subrange(of needle: [String], in haystack: [String]) -> Range<Int>? {
        guard !needle.isEmpty else { return haystack.startIndex..<haystack.startIndex }
        guard needle.count <= haystack.count else { return nil }
        for start in 0...(haystack.count - needle.count)
            where haystack[start..<(start + needle.count)].elementsEqual(needle)
        {
            return start..<(start + needle.count)
        }
        return nil
    }

    private static func index(ofOccurrence occurrence: Int, value: String, in entries: [String]) -> Int? {
        var seen = 0
        for (index, entry) in entries.enumerated().reversed() where entry == value {
            seen += 1
            if seen == occurrence { return index }
        }
        return nil
    }

    private static func normalized(_ input: String) -> String {
        input.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension OpenClawChatViewModel {
    func recallPreviousInput(caretOnFirstLine: Bool) -> Bool {
        var history = self.inputHistoriesBySession[self.sessionKey] ?? ChatInputHistory()
        guard history.isRecalling || caretOnFirstLine || self.input.isEmpty else { return false }
        guard let recalled = history.previous(draft: self.input) else { return false }
        self.inputHistoriesBySession[self.sessionKey] = history
        self.applyRecalledInput(recalled, advancesRevision: true)
        return true
    }

    func recallNextInput() -> Bool {
        var history = self.inputHistoriesBySession[self.sessionKey] ?? ChatInputHistory()
        guard let recalled = history.next() else { return false }
        self.inputHistoriesBySession[self.sessionKey] = history
        self.applyRecalledInput(recalled, advancesRevision: true)
        return true
    }

    func cancelInputRecall() -> Bool {
        var history = self.inputHistoriesBySession[self.sessionKey] ?? ChatInputHistory()
        guard let draft = history.cancel() else { return false }
        self.inputHistoriesBySession[self.sessionKey] = history
        self.applyRecalledInput(draft, advancesRevision: true)
        return true
    }

    func recordSuccessfulInput(
        _ input: String,
        transcriptEcho: String? = nil,
        submittedRevision: UInt64? = nil,
        sessionKey: String)
    {
        var history = self.inputHistoriesBySession[sessionKey] ?? ChatInputHistory()
        history.record(input, transcriptEcho: transcriptEcho)
        self.inputHistoriesBySession[sessionKey] = history
        if let submittedRevision, self.savedDraftRevisionsBySession[sessionKey] == submittedRevision {
            self.draftsBySession.removeValue(forKey: sessionKey)
            self.savedDraftRevisionsBySession.removeValue(forKey: sessionKey)
        }
    }

    func seedInputHistory(from messages: [OpenClawChatMessage]) {
        let transcriptInputs = messages.compactMap { message -> String? in
            guard message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" else {
                return nil
            }
            let text = ChatMessageVisibleText.visibleText(in: message)
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
        }
        var history = self.inputHistoriesBySession[self.sessionKey] ?? ChatInputHistory()
        history.seed(transcriptInputs: transcriptInputs)
        self.inputHistoriesBySession[self.sessionKey] = history
    }

    func noteComposerInputChanged() {
        guard !self.isApplyingRecalledInput else { return }
        self.composerRevisionsBySession[self.sessionKey, default: 0] &+= 1
        var history = self.inputHistoriesBySession[self.sessionKey] ?? ChatInputHistory()
        history.draftChanged(to: self.input)
        self.inputHistoriesBySession[self.sessionKey] = history
    }

    func prepareComposerForSessionSwitch(to nextSessionKey: String) {
        var currentHistory = self.inputHistoriesBySession[self.sessionKey] ?? ChatInputHistory()
        let draft = currentHistory.draftForSessionSwitch(currentDraft: self.input)
        if draft.isEmpty {
            self.draftsBySession.removeValue(forKey: self.sessionKey)
            self.savedDraftRevisionsBySession.removeValue(forKey: self.sessionKey)
        } else {
            self.draftsBySession[self.sessionKey] = draft
            self.savedDraftRevisionsBySession[self.sessionKey] = self.composerRevisionsBySession[
                self.sessionKey,
                default: 0,
            ]
        }
        currentHistory.resetNavigation()
        self.inputHistoriesBySession[self.sessionKey] = currentHistory

        var nextHistory = self.inputHistoriesBySession[nextSessionKey] ?? ChatInputHistory()
        nextHistory.resetNavigation()
        self.inputHistoriesBySession[nextSessionKey] = nextHistory
        self.replyTarget = nil
    }

    func restoreComposerAfterSessionSwitch() {
        self.applyRecalledInput(self.draftsBySession[self.sessionKey] ?? "", advancesRevision: false)
    }

    func composerRevision(for sessionKey: String) -> UInt64 {
        self.composerRevisionsBySession[sessionKey, default: 0]
    }

    private func applyRecalledInput(_ value: String, advancesRevision: Bool) {
        self.isApplyingRecalledInput = true
        self.input = value
        self.isApplyingRecalledInput = false
        if advancesRevision {
            self.composerRevisionsBySession[self.sessionKey, default: 0] &+= 1
        }
    }
}
