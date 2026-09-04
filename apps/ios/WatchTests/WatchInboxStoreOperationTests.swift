import Foundation
import Observation
import OpenClawKit
import OpenClawNativeState
import Testing
import WatchConnectivity
@testable import OpenClawWatchApp

@MainActor
struct WatchInboxStoreOperationTests {
    @Test func `reply completion cannot overwrite a replacement prompt`() throws {
        try Self.withStore { store, defaults in
            let originalAction = WatchPromptAction(id: "original-action", label: "Approve original")
            store.consume(
                message: Self.prompt(id: "original-prompt", action: originalAction),
                transport: "sendMessage")
            let originalAttempt = try #require(store.markReplySending(
                actionLabel: originalAction.label,
                commandId: "opaque-reply-command"))

            let replacementAction = WatchPromptAction(id: "replacement-action", label: "Approve replacement")
            store.consume(
                message: Self.prompt(id: "replacement-prompt", action: replacementAction),
                transport: "sendMessage")
            let replacementAttempt = try #require(store.markReplySending(
                actionLabel: replacementAction.label,
                commandId: "opaque-reply-command"))

            #expect(!store.markReplyResult(
                Self.result(.delivered),
                actionLabel: originalAction.label,
                attemptID: originalAttempt))
            #expect(store.promptId == "replacement-prompt")
            #expect(store.isReplySending)
            #expect(store.replyStatus?.code == .sending)
            #expect(store.replyStatus?.actionLabel == replacementAction.label)

            let restoredStore = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(restoredStore.promptId == "replacement-prompt")
            #expect(restoredStore.replyStatus?.code == .failed)
            #expect(restoredStore.replyStatus?.actionLabel == replacementAction.label)
            #expect(!restoredStore.isReplySending)

            #expect(store.markReplyResult(
                Self.result(.delivered),
                actionLabel: replacementAction.label,
                attemptID: replacementAttempt))
            #expect(store.replyStatus?.code == .sent)
            #expect(!store.isReplySending)
        }
    }

    @Test func `current prompt rejects duplicate reply submissions`() throws {
        try Self.withStore { store, _ in
            let action = WatchPromptAction(id: "approve", label: "Approve")
            store.consume(message: Self.prompt(id: "current-prompt", action: action), transport: "sendMessage")
            let attempt = try #require(store.markReplySending(
                actionLabel: action.label,
                commandId: "opaque-reply-command"))

            #expect(store.markReplySending(actionLabel: "Duplicate", commandId: "opaque-reply-command") == nil)
            #expect(store.isReplySending)
            #expect(store.replyStatus?.actionLabel == action.label)
            #expect(store.markReplyResult(Self.result(.delivered), actionLabel: action.label, attemptID: attempt))
            #expect(!store.markReplyResult(Self.result(.notSent), actionLabel: action.label, attemptID: attempt))
            #expect(store.replyStatus?.code == .sent)
            #expect(store.markReplySending(actionLabel: action.label, commandId: "opaque-reply-command") != nil)
            #expect(!store.markReplyResult(Self.result(.delivered), actionLabel: action.label, attemptID: attempt))
        }
    }

    @Test func `restored interrupted operations become recoverable before actions reopen`() throws {
        try Self.withStore { store, defaults in
            let action = WatchPromptAction(id: "approve", label: "Approve")
            store.consume(message: Self.prompt(id: "current-prompt", action: action), transport: "sendMessage")
            store.consume(appSnapshot: Self.snapshot(id: "current-snapshot"))
            _ = try #require(store.markReplySending(actionLabel: action.label, commandId: "opaque-reply-command"))
            _ = store.markAppSnapshotRequestStarted()
            _ = store.markAppCommandSending(.sendChat)

            let restored = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(restored.replyStatus?.code == .failed)
            #expect(restored.appSnapshotStatus?.code == .failed)
            #expect(restored.appCommandStatus?.code == .failed)
            #expect(!restored.isReplySending)

            let reopened = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(reopened.replyStatus?.code == .failed)
            #expect(reopened.appSnapshotStatus?.code == .failed)
            #expect(reopened.appCommandStatus?.code == .failed)
            #expect(reopened.markReplySending(actionLabel: action.label, commandId: "opaque-reply-command") != nil)
        }
    }

    @Test func `reply accepts current delivered queued and failed outcomes`() throws {
        try Self.withStore { store, _ in
            let outcomes: [(WatchReplySendResult, WatchDeliveryStatusCode)] = [
                (Self.result(.delivered), .sent),
                (Self.result(.queued), .queued),
                (Self.result(.notSent, errorMessage: "Offline"), .failed),
            ]

            for (index, outcome) in outcomes.enumerated() {
                let action = WatchPromptAction(id: "reply-\(index)", label: "Reply \(index)")
                store.consume(
                    message: Self.prompt(id: "reply-prompt-\(index)", action: action),
                    transport: "sendMessage")
                let attempt = try #require(store.markReplySending(
                    actionLabel: action.label,
                    commandId: "opaque-reply-command"))

                #expect(store.markReplyResult(outcome.0, actionLabel: action.label, attemptID: attempt))
                #expect(store.replyStatus?.code == outcome.1)
                #expect(!store.isReplySending)
            }
        }
    }

    @Test func `older snapshot request cannot overwrite the current request`() throws {
        try Self.withStore { store, defaults in
            let originalAttempt = store.markAppSnapshotRequestStarted()
            let replacementAttempt = store.markAppSnapshotRequestStarted()

            #expect(!store.markAppSnapshotRequestResult(
                Self.result(.notSent, errorMessage: "Old request failed"),
                attemptID: originalAttempt))
            #expect(store.appSnapshotStatus?.code == .sending)
            #expect(store.markAppSnapshotRequestResult(Self.result(.queued), attemptID: replacementAttempt))
            #expect(store.appSnapshotStatus?.code == .queued)

            let restoredStore = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(restoredStore.appSnapshotStatus?.code == .queued)
        }
    }

    @Test func `accepted snapshot retires its pending request`() throws {
        try Self.withStore { store, defaults in
            let attempt = store.markAppSnapshotRequestStarted()
            store.consume(appSnapshot: Self.snapshot(id: "received-snapshot"))

            #expect(store.appSnapshotStatus == nil)
            #expect(!store.markAppSnapshotRequestResult(Self.result(.delivered), attemptID: attempt))
            #expect(store.appSnapshotStatus == nil)

            let restoredStore = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(restoredStore.appSnapshotStatus == nil)
        }
    }

    @Test func `rejected older snapshot does not retire the current request`() throws {
        try Self.withStore { store, _ in
            store.consume(appSnapshot: Self.snapshot(id: "current-snapshot", sentAtMs: 200))
            let attempt = store.markAppSnapshotRequestStarted()
            store.consume(appSnapshot: Self.snapshot(id: "old-snapshot", sentAtMs: 100))

            #expect(store.appSnapshot?.snapshotId == "current-snapshot")
            #expect(store.appSnapshotStatus?.code == .sending)
            #expect(store.markAppSnapshotRequestResult(Self.result(.delivered), attemptID: attempt))
            #expect(store.appSnapshotStatus?.code == .sent)
        }
    }

    @Test func `older command completion cannot overwrite the current command`() throws {
        try Self.withStore { store, defaults in
            store.consume(appSnapshot: Self.snapshot(id: "owner-snapshot"))
            let originalAttempt = store.markAppCommandSending(.startTalk)
            let replacementAttempt = store.markAppCommandSending(.stopTalk)

            #expect(!store.markAppCommandResult(
                Self.result(.notSent, errorMessage: "Old command failed"),
                command: .startTalk,
                attemptID: originalAttempt))
            #expect(store.appCommandStatus?.command == .stopTalk)
            #expect(store.appCommandStatus?.code == .sending)
            #expect(store.markAppCommandResult(
                Self.result(.queued),
                command: .stopTalk,
                attemptID: replacementAttempt))
            #expect(store.appCommandStatus?.code == .queued)

            let restoredStore = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(restoredStore.appCommandStatus?.command == .stopTalk)
            #expect(restoredStore.appCommandStatus?.code == .queued)
        }
    }

    @Test func `same gateway snapshots preserve an in-flight command`() throws {
        try Self.withStore { store, _ in
            store.consume(appSnapshot: Self.snapshot(id: "initial-snapshot", sentAtMs: 100))
            let attempt = store.markAppCommandSending(.sendChat)
            store.beginVoiceTurn(commandId: "voice-command")
            store.consume(appSnapshot: Self.snapshot(id: "refreshed-snapshot", sentAtMs: 200))

            #expect(store.appCommandStatus?.code == .sending)
            #expect(store.isAwaitingVoiceReply)
            #expect(store.markAppCommandResult(Self.result(.delivered), command: .sendChat, attemptID: attempt))
            #expect(store.appCommandStatus?.code == .sent)
        }
    }

    @Test func `exact Unicode gateway replacement retires and clears the old command`() throws {
        try Self.withStore { store, defaults in
            let originalGateway = "gateway-caf\u{00E9}"
            let replacementGateway = "gateway-cafe\u{0301}"
            #expect(originalGateway == replacementGateway)

            store.consume(appSnapshot: Self.snapshot(id: "original-owner", gatewayStableID: originalGateway))
            let attempt = store.markAppCommandSending(.sendChat)
            store.beginVoiceTurn(commandId: "original-voice-command")
            store.consume(appSnapshot: Self.snapshot(id: "replacement-owner", gatewayStableID: replacementGateway))

            #expect(store.appCommandStatus == nil)
            #expect(!store.isAwaitingVoiceReply)
            #expect(!store.markAppCommandResult(Self.result(.delivered), command: .sendChat, attemptID: attempt))
            store.consume(chatCompletion: WatchChatCompletionMessage(
                commandId: "original-voice-command",
                replyText: "Reply from the previous gateway"))
            #expect(store.takeVoiceReply() == nil)

            let restoredStore = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(restoredStore.appCommandStatus == nil)
            #expect(!restoredStore.isAwaitingVoiceReply)
            #expect(restoredStore.appSnapshot?.gatewayStableID?.utf8.elementsEqual(replacementGateway.utf8) == true)
        }
    }

    @Test func `switching chat sessions retires voice replies and the previous preview`() throws {
        try Self.withStore { store, defaults in
            var original = Self.snapshot(id: "original-session")
            original.chatItems = [WatchChatItem(id: "old-message", role: "assistant", text: "Previous chat")]
            store.consume(appSnapshot: original)
            store.beginVoiceTurn(commandId: "original-voice-command")

            var replacement = Self.snapshot(id: "replacement-session")
            replacement.sessionKey = "another-session"
            store.consume(appSnapshot: replacement)

            #expect(!store.isAwaitingVoiceReply)
            #expect(store.appSnapshot?.chatItems == nil)
            store.consume(chatCompletion: WatchChatCompletionMessage(
                commandId: "original-voice-command",
                replyText: "Reply from the previous session"))
            #expect(store.takeVoiceReply() == nil)

            let restored = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(!restored.isAwaitingVoiceReply)
            #expect(restored.appSnapshot?.chatItems == nil)
        }
    }

    @Test func `failed voice command stops waiting but queued delivery does not`() throws {
        try Self.withStore { store, _ in
            store.consume(appSnapshot: Self.snapshot(id: "owner-snapshot"))
            let attempt = store.markAppCommandSending(.sendChat)
            store.beginVoiceTurn(commandId: "voice-command")

            #expect(store.markAppCommandResult(Self.result(.queued), command: .sendChat, attemptID: attempt))
            #expect(store.isAwaitingVoiceReply)
            #expect(store.markAppCommandResult(
                Self.result(.notSent, errorMessage: "iPhone unavailable"), command: .sendChat, attemptID: attempt))
            #expect(!store.isAwaitingVoiceReply)
            #expect(store.appCommandStatus?.detail == "iPhone unavailable")
            store.consume(chatCompletion: WatchChatCompletionMessage(commandId: "voice-command", replyText: "Late"))
            #expect(store.takeVoiceReply() == nil)
        }
    }

    @Test(arguments: ["timer", "readback", "completion", "relaunch"])
    func `expired spoken replies leave a visible readback timeout without failing delivery`(
        observation: String) throws
    {
        try Self.withStore { store, defaults in
            store.consume(appSnapshot: Self.snapshot(id: "voice-owner"))
            let attempt = store.markAppCommandSending(.sendChat)
            #expect(store.markAppCommandResult(Self.result(.delivered), command: .sendChat, attemptID: attempt))
            store.voiceTurnState.begin(
                commandId: attempt.uuidString,
                nowMs: WatchVoiceTurnState.nowMs() - WatchVoiceTurnState.timeoutMs - 1)
            store.persistVoiceTurnState()

            let observed: WatchInboxStore
            switch observation {
            case "timer":
                #expect(store.voiceReplyTimeoutNanoseconds() == nil)
                observed = store
            case "readback":
                #expect(store.takeVoiceReply() == nil)
                observed = store
            case "completion":
                store.consume(chatCompletion: WatchChatCompletionMessage(
                    commandId: attempt.uuidString, replyText: "Late reply"))
                observed = store
            default:
                observed = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            }

            #expect(!observed.isAwaitingVoiceReply)
            #expect(observed.appCommandStatus?.code != .failed)
            #expect(observed.appCommandStatusText == String(localized:
                "Spoken reply timed out. Check Chat on iPhone."))
            observed.consume(chatCompletion: WatchChatCompletionMessage(
                commandId: attempt.uuidString, replyText: "Late reply"))
            #expect(observed.takeVoiceReply() == nil)

            let restored = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(restored.appCommandStatusText == observed.appCommandStatusText)
            var replacement = Self.snapshot(id: "replacement-session")
            replacement.sessionKey = "another-session"
            restored.consume(appSnapshot: replacement)
            #expect(restored.appCommandStatus == nil)
        }
    }

    @Test(arguments: ["timer", "readback", "completion"])
    func `old spoken reply timeout preserves a newer command admission`(observation: String) throws {
        try Self.withStore { store, _ in
            store.consume(appSnapshot: Self.snapshot(id: "voice-timeout-owner"))
            let original = store.markAppCommandSending(.sendChat)
            #expect(store.markAppCommandResult(Self.result(.delivered), command: .sendChat, attemptID: original))
            store.voiceTurnState.begin(
                commandId: original.uuidString,
                nowMs: WatchVoiceTurnState.nowMs() - WatchVoiceTurnState.timeoutMs - 1)
            let newer = store.markAppCommandSending(.sendChat)
            let sending = store.appCommandStatus
            switch observation {
            case "timer":
                #expect(store.voiceReplyTimeoutNanoseconds() == nil)
            case "readback":
                #expect(store.takeVoiceReply() == nil)
            default:
                store.consume(chatCompletion: WatchChatCompletionMessage(
                    commandId: original.uuidString, replyText: "Old late reply"))
            }
            #expect(!store.isAwaitingVoiceReply)
            #expect(store.appCommandStatus == sending)
            #expect(store.markAppCommandResult(Self.result(.queued), command: .sendChat, attemptID: newer))
            #expect(store.appCommandStatus?.code == .queued)
        }
    }

    @Test func `canceling a spoken reply keeps successful delivery and does not report a timeout`() throws {
        try Self.withStore { store, _ in
            store.consume(appSnapshot: Self.snapshot(id: "voice-owner"))
            let attempt = store.markAppCommandSending(.sendChat)
            #expect(store.markAppCommandResult(Self.result(.delivered), command: .sendChat, attemptID: attempt))
            let sentStatus = store.appCommandStatusText
            store.beginVoiceTurn(commandId: "canceled-voice-command")

            store.cancelVoiceTurn()
            #expect(store.voiceReplyTimeoutNanoseconds() == nil)
            #expect(store.appCommandStatusText == sentStatus)
            #expect(store.appCommandStatus?.code == .sent)
            store.consume(chatCompletion: WatchChatCompletionMessage(
                commandId: "canceled-voice-command", replyText: "Late reply"))
            #expect(store.takeVoiceReply() == nil)
        }
    }

    @Test func `blocked command retires older completions and persists its reason`() throws {
        try Self.withStore { store, defaults in
            store.consume(appSnapshot: Self.snapshot(id: "owner-snapshot"))
            let attempt = store.markAppCommandSending(.sendChat)
            store.markAppCommandBlocked(.sendChat, reason: "Refreshing iPhone state")

            #expect(!store.markAppCommandResult(Self.result(.delivered), command: .sendChat, attemptID: attempt))
            #expect(store.appCommandStatus?.code == .blocked)
            #expect(store.appCommandStatus?.detail == "Refreshing iPhone state")

            let restoredStore = WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false)
            #expect(restoredStore.appCommandStatus?.code == .blocked)
            #expect(restoredStore.appCommandStatus?.detail == "Refreshing iPhone state")
        }
    }

    @Test func `current command accepts delivered queued and failed outcomes`() throws {
        try Self.withStore { store, _ in
            store.consume(appSnapshot: Self.snapshot(id: "owner-snapshot"))
            let outcomes: [(WatchReplySendResult, WatchDeliveryStatusCode)] = [
                (Self.result(.delivered), .sent),
                (Self.result(.queued), .queued),
                (Self.result(.notSent, errorMessage: "Offline"), .failed),
            ]

            for outcome in outcomes {
                let attempt = store.markAppCommandSending(.startTalk)
                #expect(store.markAppCommandResult(outcome.0, command: .startTalk, attemptID: attempt))
                #expect(store.appCommandStatus?.code == outcome.1)
            }
        }
    }

    private static func withStore(
        _ body: (WatchInboxStore, UserDefaults) throws -> Void) throws
    {
        let suiteName = "WatchInboxStoreOperationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        try body(WatchInboxStore(defaults: defaults, requestNotificationAuthorization: false), defaults)
    }

    @Test(arguments: ["reply", "failed", "newMessage"])
    func `saved chat survives voice timeout and app reopening without speaking a late receipt`(
        supersedingEvent: String) async throws
    {
        try await Self.withJournalStore { store, defaults, url in
            let context = Self.deliveryContext()
            var snapshot = Self.snapshot(id: "journal-owner")
            snapshot.chatDeliveryContext = context
            store.consume(appSnapshot: snapshot)
            let commandId = try #require(await store.enqueueChat(text: "Remember this", spokenReply: true))
            let now = WatchVoiceTurnState.nowMs()
            let pending = try await store.chatDeliveryJournal.pendingCommands(nowMs: now)
            #expect(pending.map(\.commandId) == [commandId])
            #expect(store.appCommandStatus?.code == .queued)
            store.expireVoiceTurnIfNeeded(nowMs: now + WatchVoiceTurnState.timeoutMs + 1)
            let timeout = try #require(store.appCommandStatus)
            #expect(timeout.code == .blocked)
            #expect(!store.isAwaitingVoiceReply)
            try await store.reloadChatDeliveryEntries()
            #expect(store.appCommandStatus == timeout)
            let admitted = OpenClawWatchChatDeliveryReceipt(
                context: context, commandId: commandId, state: .admitted(atMs: now))
            #expect(try await store.recordChatDeliveryReceipt(admitted) == nil)
            #expect(store.appCommandStatus == timeout)
            // The existing persisted presentation survives both queued and admission-only readback.
            let restored = WatchInboxStore(
                defaults: defaults,
                requestNotificationAuthorization: false,
                chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
            try await restored.reloadChatDeliveryEntries()
            #expect(restored.appCommandStatus == timeout)
            #expect(try await restored.recordChatDeliveryReceipt(admitted) == nil)
            #expect(restored.appCommandStatus == timeout)
            #expect(!restored.isAwaitingVoiceReply)
            if supersedingEvent == "newMessage" {
                let newer = try #require(await restored.enqueueChat(text: "A new user action"))
                #expect(newer != commandId)
                #expect(restored.appCommandStatus?.code == .queued)
                #expect(try await restored.recordChatDeliveryReceipt(admitted) == nil)
                #expect(restored.appCommandStatus?.code == .queued)
                return
            }
            let outcome: OpenClawWatchChatDeliveryOutcome = supersedingEvent == "reply"
                ? .reply(text: "Kept on Watch") : .failed(code: "gateway_run_failed", message: "The run failed.")
            let receipt = OpenClawWatchChatDeliveryReceipt(
                context: context,
                commandId: commandId,
                state: .terminal(.init(
                    receiptId: "late-result",
                    outcome: outcome,
                    runId: commandId,
                    completedAtMs: WatchVoiceTurnState.nowMs())))
            #expect(try await restored.recordChatDeliveryReceipt(receipt)?.receiptId == "late-result")
            #expect(restored.takeVoiceReply() == nil)
            #expect(restored.savedChatDeliveryReceipt == receipt)
            #expect(restored.appCommandStatus?.code == (supersedingEvent == "reply" ? .sent : .failed))
            let reopened = WatchInboxStore(
                defaults: defaults,
                requestNotificationAuthorization: false,
                chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
            try await reopened.reloadChatDeliveryEntries()
            #expect(reopened.savedChatDeliveryReceipt == receipt)
            #expect(reopened.appCommandStatus == restored.appCommandStatus)
            #expect(!reopened.isAwaitingVoiceReply)
        }
    }

    @Test func `agent change retires speech without retargeting saved input`() async throws {
        try await Self.withJournalStore { store, _, _ in
            let original = Self.deliveryContext(agent: "original")
            var snapshot = Self.snapshot(id: "original-agent")
            snapshot.chatDeliveryContext = original
            store.consume(appSnapshot: snapshot)
            let commandId = try #require(await store.enqueueChat(text: "For the original agent", spokenReply: true))
            snapshot.snapshotId = "replacement-agent"
            snapshot.chatDeliveryContext = Self.deliveryContext(agent: "replacement")
            store.consume(appSnapshot: snapshot)
            #expect(!store.isAwaitingVoiceReply)
            let pending = try await store.chatDeliveryJournal.pendingCommands(nowMs: WatchVoiceTurnState.nowMs())
            #expect(pending.first?.commandId == commandId)
            #expect(pending.first?.context == original)
            try await store.reloadChatDeliveryEntries()
            #expect(store.chatDeliveryEntries.isEmpty)
        }
    }

    @Test func `quick reply captures its prompt context before a replacement prompt`() async throws {
        try await Self.withJournalStore { store, _, _ in
            let action = WatchPromptAction(id: "yes", label: "Yes")
            var prompt = Self.prompt(id: "original", action: action)
            prompt.chatDeliveryContext = Self.deliveryContext(agent: "original")
            store.consume(message: prompt, transport: "test")
            let captured = try #require(store.makeQuickReplyCommand(action: action))
            prompt.id = "replacement"
            prompt.promptId = "replacement"
            prompt.chatDeliveryContext = Self.deliveryContext(agent: "replacement")
            store.consume(message: prompt, transport: "test")
            #expect(await store.enqueueQuickReply(captured))
            let pending = try await store.chatDeliveryJournal.pendingCommands(nowMs: WatchVoiceTurnState.nowMs())
            #expect(pending == [captured])
            #expect(store.replyStatus == nil)
        }
    }

    @Test(arguments: [false, true])
    func `journal expiry records a visible intentional outcome before deleting saved input`(
        newerFinalizedEntry: Bool) async throws
    {
        try await Self.withJournalStore { store, defaults, url in
            var snapshot = Self.snapshot(id: "selected-expiry-owner")
            snapshot.chatDeliveryContext = Self.deliveryContext()
            store.consume(appSnapshot: snapshot)
            let command = OpenClawWatchChatDeliveryCommand(
                context: Self.deliveryContext(),
                commandId: "expired",
                submittedAtMs: 1000,
                body: .chat(text: "An offline message"))
            try await store.chatDeliveryJournal.enqueue(command, nowMs: 1000)
            var cutoff = command.expiresAtMs
            if newerFinalizedEntry {
                let attempt = store.markAppCommandSending(.sendChat)
                let completed = OpenClawWatchChatDeliveryCommand(
                    context: command.context,
                    commandId: attempt.uuidString,
                    submittedAtMs: 1001,
                    body: .chat(text: "A completed message"))
                try await store.chatDeliveryJournal.enqueue(completed, nowMs: 1001)
                #expect(store.markAppCommandResult(Self.result(.queued), command: .sendChat, attemptID: attempt))
                let receipt = OpenClawWatchChatDeliveryReceipt(
                    context: completed.context,
                    commandId: completed.commandId,
                    state: .terminal(.init(
                        receiptId: "completed-before-expiry",
                        outcome: .reply(text: "A saved result"),
                        runId: completed.commandId,
                        completedAtMs: 1002)))
                #expect(try await store.recordChatDeliveryReceipt(receipt, nowMs: 1002)?.receiptId ==
                    "completed-before-expiry")
                #expect(store.savedChatDeliveryReceipt == receipt)
                #expect(store.appCommandStatus?.code == .sent)
                cutoff = completed.expiresAtMs
            }
            try await store.maintainChatDeliveryJournal(nowMs: cutoff)
            if newerFinalizedEntry {
                #expect(store.appCommandStatus?.code == .sent)
                #expect(store.appCommandStatus?.detail == nil)
            } else {
                #expect(store.appCommandStatus?.code == .blocked)
                #expect(store.appCommandStatus?.detail ==
                    String(localized: "A saved Watch message expired after 48 hours. Check Chat on iPhone."))
            }
            let restored = WatchInboxStore(
                defaults: defaults,
                requestNotificationAuthorization: false,
                chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
            #expect(restored.appCommandStatus == store.appCommandStatus)
            #expect(try await restored.chatDeliveryJournal.expiredEntries(nowMs: cutoff).isEmpty)
            #expect(try await restored.chatDeliveryJournal.entries(context: command.context, nowMs: 1000).isEmpty)
        }
    }

    @Test func `interactive receipt acknowledgment observes the committed SQLite admission`() async throws {
        try await Self.withJournalStore { store, _, url in
            let now = WatchVoiceTurnState.nowMs()
            let command = OpenClawWatchChatDeliveryCommand(
                context: Self.deliveryContext(),
                commandId: "ack-order",
                submittedAtMs: now,
                body: .chat(text: "Test admission"))
            try await store.chatDeliveryJournal.enqueue(command, nowMs: now)
            let database = try OpenClawNativeStateSQLite(databaseURL: url, createIfMissing: false)
            let receiver = WatchConnectivityReceiver(store: store, directNodeSetupHandler: { _, _ in })
            let receipt = OpenClawWatchChatDeliveryReceipt(
                context: command.context,
                commandId: command.commandId,
                state: .admitted(atMs: now))
            let payload = try OpenClawWatchChatDeliveryCodec.encode(receipt)
            let committed: Bool = try await withCheckedThrowingContinuation { continuation in
                receiver.session(WCSession.default, didReceiveMessage: payload) { reply in
                    do {
                        let query = try database.prepare("SELECT receipt_json FROM watch_chat_delivery")
                        let observed = try query.step() == .row && query.valueType(at: 0) == .text
                        continuation.resume(returning: observed && reply["ok"] as? Bool == true)
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
            #expect(committed)
            #expect(try await store.chatDeliveryJournal.pendingCommands(nowMs: now).isEmpty)
        }
    }

    @Test func `replay retains an overlapping wake when its current storage attempt fails`() async throws {
        try await Self.withJournalStore { store, _, url in
            let now = WatchVoiceTurnState.nowMs()
            let context = Self.deliveryContext()
            let command = OpenClawWatchChatDeliveryCommand(
                context: context,
                commandId: "replay-recovery",
                submittedAtMs: now,
                body: .chat(text: "Keep the saved reply"))
            let receipt = OpenClawWatchChatDeliveryReceipt(
                context: context,
                commandId: command.commandId,
                state: .terminal(.init(
                    receiptId: "replay-recovery-receipt",
                    outcome: .reply(text: "A committed reply"),
                    runId: command.commandId,
                    completedAtMs: now)))
            let readyURL = url.appendingPathExtension("ready")
            let readyJournal = OpenClawWatchChatDeliveryStore(databaseURL: readyURL)
            try await readyJournal.enqueue(command, nowMs: now)
            _ = try await readyJournal.record(receipt, nowMs: now)
            let readyDatabase = try OpenClawNativeStateSQLite(databaseURL: readyURL, createIfMissing: false)
            try readyDatabase.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            let committedDatabase = try Data(contentsOf: readyURL)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            var snapshot = Self.snapshot(id: "replay-recovery-owner")
            snapshot.chatDeliveryContext = context
            store.consume(appSnapshot: snapshot)
            let receiver = WatchConnectivityReceiver(store: store, directNodeSetupHandler: { _, _ in })

            // Observe actual maintenance entry, before its awaited SQLite read. The first
            // attempt still fails; only a retained overlapping wake reaches the repair below.
            withObservationTracking {
                _ = store.chatDeliveryMaintenanceID
            } onChange: {
                MainActor.assumeIsolated {
                    withObservationTracking {
                        _ = store.chatDeliveryMaintenanceID
                    } onChange: {
                        MainActor.assumeIsolated {
                            do {
                                try FileManager.default.removeItem(at: url)
                                try committedDatabase.write(to: url, options: .atomic)
                            } catch {
                                Issue.record(error, "Could not restore the task-owned journal fixture")
                            }
                        }
                    }
                    receiver.replayChatDelivery()
                }
            }
            receiver.replayChatDelivery()
            let deadline = ContinuousClock.now + .seconds(5)
            while store.savedChatDeliveryReceipt != receipt, ContinuousClock.now < deadline {
                await Task.yield()
            }
            #expect(store.savedChatDeliveryReceipt == receipt)
            // A terminal receipt has no outbound command: this proof never activates WCSession.
            #expect(try await readyJournal.pendingCommands(nowMs: now).isEmpty)
        }
    }

    @Test func `storage open failure never reports a saved command`() async throws {
        try await Self.withJournalStore { store, _, url in
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            var snapshot = Self.snapshot(id: "blocked-storage")
            snapshot.chatDeliveryContext = Self.deliveryContext()
            store.consume(appSnapshot: snapshot)
            #expect(await store.enqueueChat(text: "Cannot save") == nil)
            #expect(store.appCommandStatus?.code == .failed)
            #expect(store.appCommandStatus?.detail ==
                String(localized: "Couldn't save this Watch message. Try again when storage is available."))
        }
    }

    @Test func `permanent denial is a saved outcome but cannot undo a known admission`() async throws {
        try await Self.withJournalStore { store, defaults, url in
            let context = Self.deliveryContext()
            var snapshot = Self.snapshot(id: "rejection-owner")
            snapshot.chatDeliveryContext = context
            store.consume(appSnapshot: snapshot)
            let commandId = try #require(await store.enqueueChat(text: "Keep the result", spokenReply: true))
            let rejection = OpenClawWatchChatDeliveryReceipt(
                context: context,
                commandId: commandId,
                state: .rejected(code: "routing_changed", message: "Refresh the delivery target on iPhone."))
            #expect(try await store.recordChatDeliveryReceipt(rejection) == nil)
            #expect(store.savedChatDeliveryReceipt == rejection)
            #expect(!store.isAwaitingVoiceReply)

            let restored = WatchInboxStore(
                defaults: defaults,
                requestNotificationAuthorization: false,
                chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
            try await restored.reloadChatDeliveryEntries()
            #expect(restored.savedChatDeliveryReceipt == rejection)
            let admitted = OpenClawWatchChatDeliveryReceipt(
                context: context, commandId: commandId, state: .admitted(atMs: WatchVoiceTurnState.nowMs()))
            #expect(try await restored.recordChatDeliveryReceipt(admitted) == nil)
            restored.beginVoiceTurn(commandId: commandId)
            #expect(try await restored.recordChatDeliveryReceipt(rejection) == nil)
            #expect(restored.chatDeliveryEntries.first?.receipt == admitted)
            #expect(restored.savedChatDeliveryReceipt == nil)
            #expect(restored.isAwaitingVoiceReply)
        }
    }

    @Test func `typed expiry projects the known denial before removing the expired row`() async throws {
        try await Self.withJournalStore { store, defaults, url in
            var snapshot = Self.snapshot(id: "selected-expiry-owner")
            snapshot.chatDeliveryContext = Self.deliveryContext()
            store.consume(appSnapshot: snapshot)
            let command = OpenClawWatchChatDeliveryCommand(
                context: Self.deliveryContext(),
                commandId: "typed-expiry",
                submittedAtMs: 1000,
                body: .chat(text: "A queued message"))
            try await store.chatDeliveryJournal.enqueue(command, nowMs: 1000)
            let receipt = OpenClawWatchChatDeliveryReceipt(
                context: command.context,
                commandId: command.commandId,
                state: .rejected(code: "expired", message: "This Watch message expired. Check Chat on iPhone."))
            #expect(try await store.recordChatDeliveryReceipt(receipt, nowMs: command.expiresAtMs) == nil)
            #expect(store.appCommandStatus?.detail == "This Watch message expired. Check Chat on iPhone.")
            #expect(try await store.chatDeliveryJournal.receipt(
                context: command.context, commandId: command.commandId) == nil)
            let restored = WatchInboxStore(
                defaults: defaults,
                requestNotificationAuthorization: false,
                chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
            #expect(restored.appCommandStatus == store.appCommandStatus)
        }
    }

    @Test(arguments: ["chat", "quickReply", "previousPrompt", "otherChatContext", "otherReplyContext"])
    func `expiry keeps chat prompt and exact route outcomes separate`(scenario: String) async throws {
        for typedReceipt in [false, true] {
            try await Self.withJournalStore { store, defaults, url in
                let context = Self.deliveryContext()
                var snapshot = Self.snapshot(id: "expiry-owner")
                snapshot.chatDeliveryContext = context
                store.consume(appSnapshot: snapshot)
                let action = WatchPromptAction(id: "approve", label: "Current action")
                let currentPromptID = "caf\u{00E9}"
                var prompt = Self.prompt(id: currentPromptID, action: action)
                prompt.chatDeliveryContext = context
                store.consume(message: prompt, transport: "test")
                let affectsChat = scenario == "chat"
                let affectsPrompt = scenario == "quickReply"
                let isChat = affectsChat || scenario == "otherChatContext"
                let commandContext = scenario.hasPrefix("other") ? Self.deliveryContext(agent: "other") : context
                // These IDs are canonically equal Strings but distinct opaque prompt identities.
                let commandPromptID = scenario == "previousPrompt" ? "cafe\u{0301}" : currentPromptID
                let body: OpenClawWatchChatDeliveryBody = isChat ? .chat(text: "Old saved chat") : .quickReply(
                    promptId: commandPromptID, actionId: action.id, actionLabel: "Saved action", note: nil)
                let chatAttempt = store.markAppCommandSending(.sendChat)
                let promptAttempt = try #require(store.markReplySending(
                    actionLabel: action.label,
                    commandId: "opaque-reply-command"))
                let command = OpenClawWatchChatDeliveryCommand(
                    context: commandContext,
                    commandId: affectsChat ? chatAttempt.uuidString :
                        "opaque-reply-command",
                    submittedAtMs: 1000,
                    body: body)
                try await store.chatDeliveryJournal.enqueue(command, nowMs: 1000)
                #expect(store.markAppCommandResult(Self.result(.queued), command: .sendChat, attemptID: chatAttempt))
                if affectsPrompt {
                    #expect(store.markReplyResult(
                        Self.result(.queued),
                        actionLabel: action.label,
                        attemptID: promptAttempt))
                }
                let chatBefore = store.appCommandStatus
                let replyBefore = store.replyStatus

                let message: String
                if typedReceipt {
                    message = "The saved command expired on iPhone."
                    let receipt = OpenClawWatchChatDeliveryReceipt(
                        context: command.context,
                        commandId: command.commandId,
                        state: .rejected(code: "expired", message: message))
                    #expect(try await store.recordChatDeliveryReceipt(receipt, nowMs: command.expiresAtMs) == nil)
                } else {
                    message = String(localized: "A saved Watch message expired after 48 hours. Check Chat on iPhone.")
                    try await store.maintainChatDeliveryJournal(nowMs: command.expiresAtMs)
                }

                if affectsChat {
                    #expect(store.appCommandStatus?.code == .blocked)
                    #expect(store.appCommandStatus?.detail == message)
                } else {
                    #expect(store.appCommandStatus == chatBefore)
                    // Blocking a different kind must not silently retire this command's completion owner.
                    #expect(store.markAppCommandResult(
                        Self.result(.delivered),
                        command: .sendChat,
                        attemptID: chatAttempt))
                }
                if affectsPrompt {
                    #expect(store.replyStatus?.code == .failed)
                    #expect(store.replyStatus?.actionLabel == "Saved action")
                    #expect(store.replyStatus?.detail == message)
                } else {
                    #expect(store.replyStatus == replyBefore)
                    #expect(store.isReplySending)
                    #expect(store.markReplyResult(
                        Self.result(.delivered),
                        actionLabel: action.label,
                        attemptID: promptAttempt))
                }
                // An earlier read cutoff distinguishes actual pruning from mere expiry filtering.
                #expect(try await store.chatDeliveryJournal.entries(context: command.context, nowMs: 1000).isEmpty)
                let restored = WatchInboxStore(
                    defaults: defaults,
                    requestNotificationAuthorization: false,
                    chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
                #expect(restored.appCommandStatus == store.appCommandStatus)
                #expect(restored.replyStatus == store.replyStatus)
                #expect(restored.promptId?.utf8.elementsEqual(currentPromptID.utf8) == true)
            }
        }
    }

    @Test(arguments: [false, true])
    func `chat and quick reply receipts keep their own status and saved result`(
        quickReplyLater: Bool) async throws
    {
        try await Self.withJournalStore { store, defaults, url in
            let context = Self.deliveryContext()
            var snapshot = Self.snapshot(id: "mixed-delivery-owner")
            snapshot.chatDeliveryContext = context
            store.consume(appSnapshot: snapshot)
            let action = WatchPromptAction(id: "approve", label: "Approve")
            var prompt = Self.prompt(id: "mixed-delivery-prompt", action: action)
            prompt.chatDeliveryContext = context
            store.consume(message: prompt, transport: "test")
            let chatID = try #require(await store.enqueueChat(text: "A separate chat message"))
            let pending = try await store.chatDeliveryJournal.pendingCommands(nowMs: WatchVoiceTurnState.nowMs())
            let chat = try #require(pending.first { $0.commandId == chatID })
            let capturedReply = try #require(store.makeQuickReplyCommand(action: action))
            let quickReply = OpenClawWatchChatDeliveryCommand(
                context: capturedReply.context,
                commandId: capturedReply.commandId,
                submittedAtMs: chat.submittedAtMs + (quickReplyLater ? 1 : -1),
                body: capturedReply.body)
            #expect(await store.enqueueQuickReply(quickReply))
            let now = max(chat.submittedAtMs, quickReply.submittedAtMs) + 1
            let admitted = OpenClawWatchChatDeliveryReceipt(
                context: context,
                commandId: quickReply.commandId,
                state: .admitted(atMs: now))
            #expect(try await store.recordChatDeliveryReceipt(admitted, nowMs: now) == nil)
            #expect(store.appCommandStatus?.code == .queued)
            #expect(store.replyStatus?.code == .sent)

            let chatRejection = OpenClawWatchChatDeliveryReceipt(
                context: context,
                commandId: chatID,
                state: .rejected(code: "routing_changed", message: "Refresh the saved chat target on iPhone."))
            #expect(try await store.recordChatDeliveryReceipt(chatRejection, nowMs: now) == nil)
            #expect(store.appCommandStatus?.code == .failed)
            #expect(store.appCommandStatus?.detail == "Refresh the saved chat target on iPhone.")
            #expect(store.replyStatus?.code == .sent)

            let forwarded = OpenClawWatchChatDeliveryReceipt(
                context: context,
                commandId: quickReply.commandId,
                state: .terminal(.init(
                    receiptId: "mixed-quick-reply-result",
                    outcome: .forwarded,
                    runId: "mixed-quick-reply-run",
                    completedAtMs: now)))
            let acknowledgment = try await store.recordChatDeliveryReceipt(forwarded, nowMs: now)
            #expect(acknowledgment == OpenClawWatchChatDeliveryReceiptAck(
                context: context,
                commandId: quickReply.commandId,
                receiptId: "mixed-quick-reply-result"))
            #expect(store.appCommandStatus?.code == .failed)
            #expect(store.savedChatDeliveryReceipt == chatRejection)
            #expect(store.replyStatus?.code == .sent)
            #expect(store.savedPromptDeliveryReceipt == forwarded)

            let restored = WatchInboxStore(
                defaults: defaults,
                requestNotificationAuthorization: false,
                chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
            try await restored.reloadChatDeliveryEntries(nowMs: now)
            #expect(restored.appCommandStatus?.code == .failed)
            #expect(restored.savedChatDeliveryReceipt == chatRejection)
            #expect(restored.replyStatus?.code == .sent)
            #expect(restored.savedPromptDeliveryReceipt == forwarded)
            #expect(try await restored.chatDeliveryJournal.receipt(
                context: context, commandId: quickReply.commandId) == forwarded)
        }
    }

    @Test(arguments: [false, true])
    func `older chat expiry preserves a newer durable chat attempt`(expiredBeforeAdmission: Bool) async throws {
        try await Self.withJournalStore { store, defaults, url in
            let context = Self.deliveryContext()
            var snapshot = Self.snapshot(id: "same-kind-expiry")
            snapshot.chatDeliveryContext = context
            store.consume(appSnapshot: snapshot)
            let now = WatchVoiceTurnState.nowMs()
            let oldDeadline = now + (expiredBeforeAdmission ? -1 : 60000)
            let oldCommand = OpenClawWatchChatDeliveryCommand(
                context: context,
                commandId: "older-saved-chat",
                submittedAtMs: oldDeadline - OpenClawWatchChatDeliveryCodec.lifetimeMs,
                body: .chat(text: "Older saved chat"))
            try await store.chatDeliveryJournal.enqueue(oldCommand, nowMs: oldCommand.submittedAtMs)

            // This is the real tap/admission owner: maintenance runs after the new attempt starts.
            let commandID = try #require(await store.enqueueChat(text: "Newer saved chat", spokenReply: true))
            let fresh = try #require(try await store.chatDeliveryJournal.pendingCommands(nowMs: now)
                .first(where: { $0.commandId == commandID }))
            #expect(fresh.context == context)
            #expect(fresh.text == "Newer saved chat")
            #expect(fresh.expiresAtMs > oldDeadline)
            #expect(store.appCommandStatus?.code == .queued)
            #expect(store.isAwaitingVoiceReply)
            #expect(store.voiceTurnState.tracker.commandId == commandID)

            if !expiredBeforeAdmission {
                // Advance only the maintenance cutoff; no sleeps or altered send deadline.
                try await store.maintainChatDeliveryJournal(nowMs: oldDeadline)
            }
            #expect(store.appCommandStatus?.code == .queued)
            #expect(store.isAwaitingVoiceReply)
            #expect(store.voiceTurnState.tracker.commandId == commandID)
            let survivors = try await store.chatDeliveryJournal.entries(context: context, nowMs: now)
            #expect(survivors.map(\.command) == [fresh])
            let restored = WatchInboxStore(
                defaults: defaults,
                requestNotificationAuthorization: false,
                chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
            #expect(restored.appCommandStatus?.code == .queued)
            #expect(try await restored.chatDeliveryJournal.pendingCommands(nowMs: now) == [fresh])
        }
    }

    @Test(arguments: [false, true])
    func `older reply expiry preserves a newer reply to the same prompt`(expiredBeforeAdmission: Bool) async throws {
        try await Self.withJournalStore { store, defaults, url in
            let context = Self.deliveryContext()
            var snapshot = Self.snapshot(id: "same-prompt-expiry")
            snapshot.chatDeliveryContext = context
            store.consume(appSnapshot: snapshot)
            let action = WatchPromptAction(id: "approve", label: "Newer action")
            var prompt = Self.prompt(id: "same-prompt", action: action)
            prompt.chatDeliveryContext = context
            store.consume(message: prompt, transport: "test")
            let now = WatchVoiceTurnState.nowMs()
            let oldDeadline = now + (expiredBeforeAdmission ? -1 : 60000)
            let oldCommand = OpenClawWatchChatDeliveryCommand(
                context: context,
                commandId: "older-saved-reply",
                submittedAtMs: oldDeadline - OpenClawWatchChatDeliveryCodec.lifetimeMs,
                body: .quickReply(
                    promptId: "same-prompt", actionId: action.id, actionLabel: "Older action", note: nil))
            try await store.chatDeliveryJournal.enqueue(oldCommand, nowMs: oldCommand.submittedAtMs)
            let fresh = try #require(store.makeQuickReplyCommand(action: action))
            #expect(await store.enqueueQuickReply(fresh))
            #expect(store.replyStatus?.code == .queued)
            #expect(store.replyStatus?.actionLabel == action.label)
            if !expiredBeforeAdmission {
                try await store.maintainChatDeliveryJournal(nowMs: oldDeadline)
            }
            #expect(store.replyStatus?.code == .queued)
            #expect(store.replyStatus?.actionLabel == action.label)
            #expect(!store.isReplySending)
            #expect(try await store.chatDeliveryJournal.entries(context: context, nowMs: now).map(\.command) == [fresh])
            let restored = WatchInboxStore(
                defaults: defaults,
                requestNotificationAuthorization: false,
                chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
            #expect(restored.replyStatus == store.replyStatus)
            #expect(try await restored.chatDeliveryJournal.pendingCommands(nowMs: now) == [fresh])
        }
    }

    @Test func `old admitted receipt does not hide a newer unsaved chat failure`() async throws {
        try await Self.withJournalStore { store, _, _ in
            let context = Self.deliveryContext()
            var snapshot = Self.snapshot(id: "failed-new-admission")
            snapshot.chatDeliveryContext = context
            store.consume(appSnapshot: snapshot)
            let oldID = try #require(await store.enqueueChat(text: "Saved older message"))
            let receipt = OpenClawWatchChatDeliveryReceipt(
                context: context, commandId: oldID,
                state: .admitted(atMs: WatchVoiceTurnState.nowMs()))
            #expect(try await store.recordChatDeliveryReceipt(receipt) == nil)
            #expect(await store.enqueueChat(text: "") == nil)
            let failure = try #require(store.appCommandStatus)
            #expect(failure.code == .failed)
            #expect(try await store.recordChatDeliveryReceipt(receipt) == nil)
            #expect(store.appCommandStatus == failure)
            #expect(store.chatDeliveryEntries.count == 1)
            #expect(store.chatDeliveryEntries.first?.receipt == receipt)
            #expect(try await store.chatDeliveryJournal.entries(
                context: context, nowMs: WatchVoiceTurnState.nowMs()).count == 1)
        }
    }

    private static func withJournalStore(
        _ body: @MainActor (WatchInboxStore, UserDefaults, URL) async throws -> Void) async throws
    {
        let suiteName = "WatchInboxJournalTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: directory)
        }
        let url = directory.appendingPathComponent("watch.sqlite")
        let store = WatchInboxStore(
            defaults: defaults,
            requestNotificationAuthorization: false,
            chatDeliveryJournal: OpenClawWatchChatDeliveryStore(databaseURL: url))
        try await body(store, defaults, url)
    }

    private static func deliveryContext(agent: String = "main") -> OpenClawWatchChatDeliveryContext {
        OpenClawWatchChatDeliveryContext(
            gatewayStableID: "watch-test-gateway",
            routeGeneration: "generation",
            agentId: agent,
            sessionKey: "main",
            deliverySessionKey: "agent:\(agent):main",
            sessionRoutingContract: "agent-scoped-v1")
    }

    private static func result(
        _ delivery: WatchReplyDeliveryState,
        errorMessage: String? = nil) -> WatchReplySendResult
    {
        WatchReplySendResult(
            delivery: delivery,
            transport: "sendMessage",
            errorMessage: errorMessage,
            requiresCanonicalReadback: false)
    }

    private static func snapshot(
        id: String,
        gatewayStableID: String = "watch-test-gateway",
        sentAtMs: Int64? = nil) -> WatchAppSnapshotMessage
    {
        WatchAppSnapshotMessage(
            gatewayStatus: .init(code: .gatewayConnected),
            gatewayConnected: true,
            agentName: "Test agent",
            agentAvatarURL: nil,
            agentAvatarText: nil,
            sessionKey: "main",
            gatewayStableID: gatewayStableID,
            talkStatus: .init(code: .talkReady),
            talkEnabled: false,
            talkListening: false,
            talkSpeaking: false,
            pendingApprovalCount: 0,
            chatItems: nil,
            chatStatus: nil,
            sentAtMs: sentAtMs,
            snapshotId: id)
    }

    private static func prompt(id: String, action: WatchPromptAction) -> WatchNotifyMessage {
        WatchNotifyMessage(
            id: id,
            title: "Approval requested",
            body: action.label,
            sentAtMs: nil,
            promptId: id,
            sessionKey: "main",
            gatewayStableID: "watch-test-gateway",
            kind: nil,
            details: nil,
            expiresAtMs: nil,
            risk: nil,
            actions: [action])
    }
}
