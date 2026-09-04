import Foundation
import OpenClawKit
import OSLog

extension WatchInboxStore {
    var chatDeliveryContext: OpenClawWatchChatDeliveryContext? {
        self.appSnapshot?.validatedChatDeliveryContext
    }

    var savedChatDeliveryReceipt: OpenClawWatchChatDeliveryReceipt? {
        self.chatDeliveryEntries.last(where: { $0.receipt?.isFinal == true })?.receipt
    }

    var savedPromptDeliveryReceipt: OpenClawWatchChatDeliveryReceipt? {
        self.promptChatDeliveryEntries.last(where: { $0.receipt?.isFinal == true })?.receipt
    }

    /// Capture the prompt owner at the button tap, before any asynchronous admission work.
    func makeQuickReplyCommand(action: WatchPromptAction) -> OpenClawWatchChatDeliveryCommand? {
        guard let context = self.promptChatDeliveryContext,
              (try? OpenClawWatchChatDeliveryCodec.validateContext(context)) != nil,
              self.gatewayStableID?.utf8.elementsEqual(context.gatewayStableID.utf8) == true,
              self.sessionKey?.utf8.elementsEqual(context.sessionKey.utf8) == true,
              let promptId = self.promptId,
              self.actions.contains(where: { $0.id.utf8.elementsEqual(action.id.utf8) })
        else {
            self.replyStatus = WatchReplyStatus(
                code: .failed,
                actionLabel: action.label,
                detail: String(localized: "Refresh this prompt from an updated iPhone before replying."))
            self.replyStatusAt = Date()
            self.persistState()
            return nil
        }
        return OpenClawWatchChatDeliveryCommand(
            context: context,
            commandId: UUID().uuidString,
            submittedAtMs: WatchVoiceTurnState.nowMs(),
            body: .quickReply(promptId: promptId, actionId: action.id, actionLabel: action.label, note: nil))
    }

    func enqueueChat(text: String, spokenReply: Bool = false) async -> String? {
        guard let context = self.chatDeliveryContext else {
            self.markAppCommandBlocked(
                .sendChat, reason: String(localized: "Refresh from an updated iPhone before sending a Watch message."))
            return nil
        }
        let attempt = self.markAppCommandSending(.sendChat)
        let command = OpenClawWatchChatDeliveryCommand(
            context: context,
            commandId: attempt.uuidString,
            submittedAtMs: WatchVoiceTurnState.nowMs(),
            body: .chat(text: text.trimmingCharacters(in: .whitespacesAndNewlines)))
        self.chatDeliveryReloadID = nil
        var accepted = false
        do {
            try await self.maintainChatDeliveryJournal()
            try await self.chatDeliveryJournal.enqueue(command, nowMs: WatchVoiceTurnState.nowMs())
            if self.chatDeliveryContext == context {
                let isCurrent = self.markAppCommandResult(
                    Self.persistedDeliveryResult, command: .sendChat, attemptID: attempt)
                if isCurrent, spokenReply { self.beginVoiceTurn(commandId: command.commandId) }
            }
            accepted = true
        } catch {
            if self.chatDeliveryContext == context {
                self.markAppCommandResult(Self.failedDeliveryResult(error), command: .sendChat, attemptID: attempt)
            }
        }
        await self.refreshChatDeliveryAfterAttempt()
        return accepted ? command.commandId : nil
    }

    func enqueueQuickReply(_ command: OpenClawWatchChatDeliveryCommand) async -> Bool {
        guard case let .quickReply(promptId, actionId, actionLabel, _) = command.body else { return false }
        let isCurrent = command.context == self.promptChatDeliveryContext
            && promptId.utf8.elementsEqual((self.promptId ?? "").utf8)
        let attempt = isCurrent ? self.markReplySending(
            actionLabel: actionLabel ?? actionId, commandId: command.commandId) : nil
        if isCurrent, attempt == nil { return false }
        self.chatDeliveryReloadID = nil
        var accepted = false
        do {
            try await self.maintainChatDeliveryJournal()
            try await self.chatDeliveryJournal.enqueue(command, nowMs: WatchVoiceTurnState.nowMs())
            if let attempt {
                self.markReplyResult(
                    Self.persistedDeliveryResult,
                    actionLabel: actionLabel ?? actionId,
                    attemptID: attempt)
            }
            accepted = true
        } catch {
            if let attempt {
                self.markReplyResult(
                    Self.failedDeliveryResult(error),
                    actionLabel: actionLabel ?? actionId,
                    attemptID: attempt)
            }
        }
        await self.refreshChatDeliveryAfterAttempt()
        return accepted
    }

    func maintainChatDeliveryJournal(nowMs: Int64 = WatchVoiceTurnState.nowMs()) async throws {
        let requestID = UUID()
        self.chatDeliveryMaintenanceID = requestID
        let context = self.chatDeliveryContext
        let promptContext = self.promptChatDeliveryContext
        let promptID = self.promptId
        let chatWasSending = self.appCommandStatus?.code == .sending
        let replyWasSending = self.isReplySending
        let expired = try await self.chatDeliveryJournal.expiredEntries(nowMs: nowMs)
        guard !expired.isEmpty else { return }
        let chatEntries: [OpenClawWatchChatDeliveryStore.Entry] = if let context {
            try await self.chatDeliveryJournal.entries(context: context, nowMs: nowMs)
        } else {
            []
        }
        let promptEntries: [OpenClawWatchChatDeliveryStore.Entry] = if promptContext == context {
            chatEntries
        } else if let promptContext {
            try await self.chatDeliveryJournal.entries(context: promptContext, nowMs: nowMs)
        } else {
            []
        }
        // Every newer admission starts maintenance while Sending. Neither an older read nor
        // expiry inside that admission may retire its completion owner after an awaited read.
        guard self.chatDeliveryMaintenanceID == requestID,
              self.chatDeliveryContext == context, self.promptChatDeliveryContext == promptContext,
              self.promptId?.utf8.elementsEqual((promptID ?? "").utf8) ?? (promptID == nil)
        else { return }
        func matchesPrompt(_ entry: OpenClawWatchChatDeliveryStore.Entry) -> Bool {
            guard case let .quickReply(id, _, _, _) = entry.command.body else { return false }
            return entry.command.context == promptContext && id.utf8.elementsEqual((promptID ?? "").utf8)
        }
        var projections: [OpenClawWatchChatDeliveryStore.Entry] = []
        if !chatWasSending, self.appCommandStatus?.code != .sending,
           self.appCommandStatus == nil || self.appCommandStatus?.command == .sendChat,
           !chatEntries.contains(where: { $0.command.kind == .chat }),
           let entry = self.chatDeliveryPresentationEntry(
               expired.filter { $0.command.context == context }, kind: .chat)
        {
            projections.append(entry)
        }
        if !replyWasSending, !self.isReplySending,
           !promptEntries.contains(where: matchesPrompt),
           let entry = self.chatDeliveryPresentationEntry(expired.filter(matchesPrompt), kind: .quickReply)
        {
            projections.append(entry)
        }
        for entry in projections {
            let message: String
            if let receipt = entry.receipt, case let .rejected(code, detail) = receipt.state, code == "expired" {
                message = detail
            } else {
                guard entry.receipt?.isFinal != true else { continue }
                message = String(localized: "A saved Watch message expired after 48 hours. Check Chat on iPhone.")
            }
            switch entry.command.body {
            case .chat:
                self.markAppCommandBlocked(.sendChat, reason: message)
            case let .quickReply(_, actionId, label, _):
                self.replyStatus = WatchReplyStatus(code: .failed, actionLabel: label ?? actionId, detail: message)
                self.replyStatusAt = Date()
            }
        }
        self.persistState()
        Logger(subsystem: "ai.openclaw.watch", category: "chat-delivery")
            .notice("Expired \(expired.count) saved Watch messages at their original deadline")
        // No receipt or duplicate command extends this deadline. Display state is not replay authority.
        self.chatDeliveryReloadID = nil
        try await self.chatDeliveryJournal.pruneExpired(nowMs: nowMs)
        try await self.reloadChatDeliveryEntries(nowMs: nowMs)
    }

    func reloadChatDeliveryEntries(nowMs: Int64 = WatchVoiceTurnState.nowMs()) async throws {
        let requestID = UUID()
        self.chatDeliveryReloadID = requestID
        let context = self.chatDeliveryContext
        let promptContext = self.promptChatDeliveryContext
        let promptID = self.promptId
        let chatWasSending = self.appCommandStatus?.code == .sending
        let replyWasSending = self.isReplySending
        let entries: [OpenClawWatchChatDeliveryStore.Entry] = if let context {
            try await self.chatDeliveryJournal.entries(context: context, nowMs: nowMs)
        } else {
            []
        }
        let promptEntries: [OpenClawWatchChatDeliveryStore.Entry] = if promptContext == context {
            entries
        } else if let promptContext {
            try await self.chatDeliveryJournal.entries(context: promptContext, nowMs: nowMs)
        } else {
            []
        }
        // A suspended older read must not restore rows after a newer receipt or route projection.
        guard self.chatDeliveryReloadID == requestID,
              self.chatDeliveryContext == context, self.promptChatDeliveryContext == promptContext,
              self.promptId?.utf8.elementsEqual((promptID ?? "").utf8) ?? (promptID == nil)
        else { return }
        self.chatDeliveryEntries = entries.filter { $0.command.kind == .chat }
        self.promptChatDeliveryEntries = promptEntries.filter { entry in
            guard case let .quickReply(id, _, _, _) = entry.command.body else { return false }
            return id.utf8.elementsEqual((promptID ?? "").utf8)
        }
        func status(_ entry: OpenClawWatchChatDeliveryStore.Entry) -> (WatchDeliveryStatusCode, String?) {
            if let outcome = entry.receipt?.outcome {
                switch outcome {
                case let .failed(_, message), let .uncertain(message): return (.failed, message)
                case .reply, .forwarded: return (.sent, nil)
                }
            }
            return (entry.receipt == nil ? .queued : .sent, nil)
        }
        // Rows and status come from this one admitted read, never a caller's retained arrays.
        // Queue/admission readback cannot clear a blocked outcome; a final receipt or new action can.
        if !chatWasSending, let entry = self.chatDeliveryPresentationEntry(self.chatDeliveryEntries, kind: .chat),
           self.appCommandStatus?.code != .blocked || entry.receipt?.isFinal == true
        {
            let (code, detail) = status(entry)
            self.appCommandStatus = WatchAppCommandStatus(command: .sendChat, code: code, detail: detail)
        }
        if !replyWasSending,
           let entry = self.chatDeliveryPresentationEntry(self.promptChatDeliveryEntries, kind: .quickReply),
           case let .quickReply(_, actionId, label, _) = entry.command.body
        {
            let (code, detail) = status(entry)
            self.replyStatus = WatchReplyStatus(code: code, actionLabel: label ?? actionId, detail: detail)
            self.replyStatusAt = Date()
        }
        self.persistState()
    }

    func recordChatDeliveryReceipt(
        _ receipt: OpenClawWatchChatDeliveryReceipt,
        nowMs: Int64 = WatchVoiceTurnState.nowMs()) async throws -> OpenClawWatchChatDeliveryReceiptAck?
    {
        self.chatDeliveryReloadID = nil
        let acknowledgment: OpenClawWatchChatDeliveryReceiptAck?
        do {
            acknowledgment = try await self.chatDeliveryJournal.record(receipt, nowMs: nowMs)
        } catch {
            if let deliveryError = error as? OpenClawWatchChatDeliveryError, deliveryError.code == "expired" {
                try await self.maintainChatDeliveryJournal(nowMs: nowMs)
            }
            await self.refreshChatDeliveryAfterAttempt(nowMs: nowMs)
            throw error
        }
        self.chatDeliveryReloadID = nil
        if case let .rejected(code, message) = receipt.state,
           code == OpenClawWatchChatDeliveryCodec.staleRouteCode
        {
            self.chatDeliveryMaintenanceID = nil
            if let current = self.chatDeliveryContext,
               current.gatewayStableID.utf8.elementsEqual(receipt.context.gatewayStableID.utf8),
               current.routeGeneration.utf8.elementsEqual(receipt.context.routeGeneration.utf8)
            {
                self.appSnapshot?.chatDeliveryContext = nil
                self.chatDeliveryEntries = []
                self.voiceTurnState.cancel()
                self.markAppCommandBlocked(.sendChat, reason: message)
            }
            if let current = self.promptChatDeliveryContext,
               current.gatewayStableID.utf8.elementsEqual(receipt.context.gatewayStableID.utf8),
               current.routeGeneration.utf8.elementsEqual(receipt.context.routeGeneration.utf8)
            {
                self.promptChatDeliveryContext = nil
                self.promptChatDeliveryEntries = []
                self.isReplySending = false
                self.replyStatus = WatchReplyStatus(code: .failed, actionLabel: "", detail: message)
            }
        } else if let current = try await self.chatDeliveryJournal.receipt(
            context: receipt.context, commandId: receipt.commandId)
        {
            if self.chatDeliveryContext == current.context,
               let terminal = current.terminal, case let .reply(text) = terminal.outcome
            {
                // Speech remains a separate 90-second projection of the already committed result.
                self.consume(chatCompletion: WatchChatCompletionMessage(
                    commandId: current.commandId, replyText: text, sentAtMs: terminal.completedAtMs))
            }
            if self.chatDeliveryContext == current.context,
               self.voiceTurnState.tracker.commandId?.utf8.elementsEqual(current.commandId.utf8) == true,
               let outcome = current.outcome
            {
                switch outcome {
                case .failed, .uncertain:
                    self.voiceTurnState.cancel()
                case .forwarded:
                    self.voiceTurnState.cancel()
                case .reply:
                    break
                }
            }
        }
        try await self.maintainChatDeliveryJournal(nowMs: nowMs)
        try await self.reloadChatDeliveryEntries(nowMs: nowMs)
        return acknowledgment
    }

    private func refreshChatDeliveryAfterAttempt(nowMs: Int64 = WatchVoiceTurnState.nowMs()) async {
        self.chatDeliveryReloadID = nil
        do {
            try await self.reloadChatDeliveryEntries(nowMs: nowMs)
        } catch {
            // Admission is already settled; a failed read must not relabel saved input as Not sent.
            Logger(subsystem: "ai.openclaw.watch", category: "chat-delivery")
                .notice("Saved Watch message projection will refresh when storage is available")
        }
    }

    private static var persistedDeliveryResult: WatchReplySendResult {
        WatchReplySendResult(
            delivery: .queued,
            transport: "journal",
            errorMessage: nil,
            requiresCanonicalReadback: false)
    }

    private static func failedDeliveryResult(_ error: any Error) -> WatchReplySendResult {
        let message = (error as? OpenClawWatchChatDeliveryError)?.message
            ?? String(localized: "Couldn't save this Watch message. Try again when storage is available.")
        return WatchReplySendResult(
            delivery: .notSent, transport: "none", errorMessage: message, requiresCanonicalReadback: false)
    }
}
