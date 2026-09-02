import Foundation
import Testing
@testable import OpenClawWatchApp

@MainActor
struct WatchInboxStoreOperationTests {
    @Test func `reply completion cannot overwrite a replacement prompt`() throws {
        try Self.withStore { store, defaults in
            let originalAction = WatchPromptAction(id: "original-action", label: "Approve original")
            store.consume(
                message: Self.prompt(id: "original-prompt", action: originalAction),
                transport: "sendMessage")
            let originalAttempt = try #require(store.markReplySending(actionLabel: originalAction.label))

            let replacementAction = WatchPromptAction(id: "replacement-action", label: "Approve replacement")
            store.consume(
                message: Self.prompt(id: "replacement-prompt", action: replacementAction),
                transport: "sendMessage")
            let replacementAttempt = try #require(store.markReplySending(actionLabel: replacementAction.label))

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
            let attempt = try #require(store.markReplySending(actionLabel: action.label))

            #expect(store.markReplySending(actionLabel: "Duplicate") == nil)
            #expect(store.isReplySending)
            #expect(store.replyStatus?.actionLabel == action.label)
            #expect(store.markReplyResult(Self.result(.delivered), actionLabel: action.label, attemptID: attempt))
            #expect(store.markReplySending(actionLabel: action.label) != nil)
        }
    }

    @Test func `restored interrupted operations become recoverable before actions reopen`() throws {
        try Self.withStore { store, defaults in
            let action = WatchPromptAction(id: "approve", label: "Approve")
            store.consume(message: Self.prompt(id: "current-prompt", action: action), transport: "sendMessage")
            store.consume(appSnapshot: Self.snapshot(id: "current-snapshot"))
            _ = try #require(store.markReplySending(actionLabel: action.label))
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
            #expect(reopened.markReplySending(actionLabel: action.label) != nil)
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
                let attempt = try #require(store.markReplySending(actionLabel: action.label))

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
            #expect(store.isCurrentAppCommandAttempt(attempt, gatewayStableID: "watch-test-gateway"))
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
            #expect(!store.isCurrentAppCommandAttempt(attempt, gatewayStableID: originalGateway))
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

    @Test func `newer command retires an older delayed refresh owner`() throws {
        try Self.withStore { store, _ in
            store.consume(appSnapshot: Self.snapshot(id: "owner-snapshot"))
            let originalAttempt = store.markAppCommandSending(.sendChat)
            #expect(store.markAppCommandResult(
                Self.result(.delivered),
                command: .sendChat,
                attemptID: originalAttempt))
            #expect(store.isCurrentAppCommandAttempt(originalAttempt, gatewayStableID: "watch-test-gateway"))

            let replacementAttempt = store.markAppCommandSending(.startTalk)
            #expect(!store.isCurrentAppCommandAttempt(originalAttempt, gatewayStableID: "watch-test-gateway"))
            #expect(store.isCurrentAppCommandAttempt(replacementAttempt, gatewayStableID: "watch-test-gateway"))
            #expect(!store.isCurrentAppCommandAttempt(replacementAttempt, gatewayStableID: "different-gateway"))
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
