import Foundation
import Testing
@testable import OpenClaw

struct WatchApprovalTransportSourceGuardTests {
    @Test func `watch approval loading and screenshot proof are visible`() throws {
        let appSource = try Self.readWatchSource("OpenClawWatchApp.swift")
        let viewSource = try Self.readWatchSource("WatchInboxView.swift")
        let approvalFace = try Self.extract(
            viewSource,
            from: "private var approvalsFace: some View",
            to: "private var connectionFace: some View")

        #expect(appSource.contains("--openclaw-watch-approval-screenshot-mode"))
        #expect(appSource.contains("includeApproval: WatchScreenshotMode.approvals"))
        #expect(viewSource.contains("selectedFace = WatchScreenshotMode.approvals ? 2 : 0"))
        #expect(appSource.contains("id: \"watch-screenshot-approval\""))
        #expect(appSource.contains("pendingApprovalCount: approvals.count"))
        #expect(approvalFace.contains("self.store.isExecApprovalReviewLoading"))
        #expect(approvalFace.contains("title: .localized(\"Loading approval\")"))
        #expect(approvalFace.contains(
            "self.approvalCount > 0 || self.store.shouldShowExecApprovalReviewStatus"))
        #expect(approvalFace.contains("title: .localized(\"Approval not loaded\")"))
        #expect(approvalFace.contains("Approval details have not loaded"))
        #expect(approvalFace.contains("WatchSecondaryButton(title: \"Review again\")"))
    }

    @Test func `watch distinguishes unsent approval from uncertain delivery`() throws {
        let source = try Self.readWatchSource("OpenClawWatchApp.swift")
        let storeSource = try Self.readWatchSource("WatchInboxStore.swift")
        let resolveFlow = try Self.extract(
            source,
            from: "guard let attemptID = self.inboxStore.beginExecApprovalDecision(",
            to: "onRefreshExecApprovalReview:")

        let admission = try #require(
            resolveFlow.range(of: "guard let attemptID = self.inboxStore.beginExecApprovalDecision("))
        let send = try #require(
            resolveFlow.range(of: "let result = await receiver.sendExecApprovalResolve("))
        let completion = try #require(
            resolveFlow.range(of: "self.inboxStore.completeExecApprovalDecision("))

        #expect(admission.lowerBound < send.lowerBound)
        #expect(send.lowerBound < completion.lowerBound)
        #expect(storeSource.contains("!self.execApprovals[index].isResolving"))
        #expect(storeSource.contains("approval.allowedDecisions.contains(decision)"))
        #expect(storeSource.contains(
            "WatchOpaqueUTF8Key(activeResolutionAttemptID) == WatchOpaqueUTF8Key(attemptID)"))
        #expect(storeSource.contains("pendingDecision == decision"))
        #expect(storeSource.contains("activeResolutionAttemptID = nil"))
        #expect(resolveFlow.contains("attemptID: attemptID"))
        let receiverSource = try Self.readWatchSource("WatchConnectivityReceiver.swift")
        #expect(receiverSource.contains("enum WatchReplyDeliveryState"))
        #expect(receiverSource.contains("delivery: .delivered"))
        #expect(receiverSource.contains("delivery: .queued"))
        #expect(receiverSource.contains("delivery: .notSent"))
        #expect(receiverSource.contains("var requiresCanonicalReadback: Bool"))
        #expect(receiverSource.contains("requiresCanonicalReadback = true"))
        #expect(receiverSource.contains("requiresCanonicalReadback: requiresCanonicalReadback"))
        #expect(receiverSource.contains("replyId: attemptID"))
        #expect(resolveFlow.contains("if result.requiresCanonicalReadback"))
    }

    @Test func `forced watch refresh waits for its exact request and owner snapshot`() throws {
        let appSource = try Self.readWatchSource("OpenClawWatchApp.swift")
        let receiverSource = try Self.readWatchSource("WatchConnectivityReceiver.swift")
        let storeSource = try Self.readWatchSource("WatchInboxStore.swift")
        let refresh = try Self.extract(
            appSource,
            from: "private func refreshExecApprovalReview(force: Bool = false)",
            to: "}\n}\n\n@MainActor")
        let appSnapshotRequestEncoder = try Self.extract(
            receiverSource,
            from: "private static func encodeAppSnapshotRequestPayload(",
            to: "private static func encodeAppCommandPayload(")
        let approvalSnapshotRequestEncoder = try Self.extract(
            receiverSource,
            from: "private static func encodeSnapshotRequestPayload(",
            to: "private static func encodeExecApprovalResolvePayload(")

        #expect(refresh.contains("var requestTokens: [WatchExecApprovalSnapshotRequestToken] = []"))
        #expect(refresh.contains("consumeCurrentOwnerAcknowledgment"))
        #expect(refresh.contains("token.matchesGatewayStableID(currentGatewayStableID)"))
        #expect(refresh.contains("discardExecApprovalSnapshotAcknowledgments("))
        #expect(refresh.contains("requestTokens.append(token)"))
        #expect(refresh.contains("receiver.consumeExecApprovalSnapshotAcknowledgment(for: token)"))
        let checkBeforeSend = try #require(refresh.range(of: "let receivedBeforeRequest"))
        let send = try #require(refresh.range(of: "await receiver.requestExecApprovalSnapshot("))
        #expect(checkBeforeSend.lowerBound < send.lowerBound)
        #expect(!refresh.contains("execApprovalSnapshotRevision"))
        #expect(refresh.contains("let reviewAlreadyAvailable = !force"))
        #expect(refresh.contains("!self.inboxStore.execApprovals.contains(where: \\.isResolving)"))
        #expect(receiverSource.contains("struct WatchExecApprovalSnapshotRequestToken: Hashable"))
        #expect(receiverSource.contains("self.requestKey = WatchOpaqueUTF8Key(requestId)"))
        #expect(receiverSource.contains("self.gatewayKey = WatchOpaqueUTF8Key(gatewayStableID)"))
        #expect(receiverSource.contains("func matchesGatewayStableID("))
        #expect(approvalSnapshotRequestEncoder.contains(
            "WatchGatewayID.exact(request.gatewayStableID)"))
        #expect(approvalSnapshotRequestEncoder.contains("\"heldApprovals\": request.heldApprovals.map"))
        #expect(approvalSnapshotRequestEncoder.contains("\"activeResolutionAttemptId\""))
        #expect(storeSource.contains("func execApprovalSnapshotRequestItems("))
        #expect(storeSource.contains(
            "WatchGatewayID.key(record.approval.gatewayStableID) == gatewayKey"))
        #expect(storeSource.contains("self.hasCompletedExecApprovalSnapshotRefreshInSession = false"))
        #expect(refresh.contains(
            "heldApprovals: self.inboxStore.execApprovalSnapshotRequestItems("))
        #expect(receiverSource.components(
            separatedBy: "discardExecApprovalSnapshotAcknowledgments(").count >= 4)
        #expect(!appSnapshotRequestEncoder.contains("gatewayStableID"))
        #expect(receiverSource.contains(
            "WatchGatewayID.exact(payload[\"requestGatewayStableID\"] as? String)"))
        #expect(receiverSource.contains("recordAcceptedExecApprovalSnapshot"))
        #expect(receiverSource.contains(
            "WatchGatewayID.key(snapshot.gatewayStableID) == WatchGatewayID.key(token.gatewayStableID)"))
    }

    @Test func `watch applies retry reset only to its exact active attempt`() throws {
        let storeSource = try Self.readWatchSource("WatchInboxStore.swift")
        let promptConsume = try Self.extract(
            storeSource,
            from: "func consume(\n        execApprovalPrompt",
            to: "func consume(\n        execApprovalSnapshot")
        let upsert = try Self.extract(
            storeSource,
            from: "private func upsertExecApproval(",
            to: "private static func snapshotCanReplace(")

        let guardedUpsert = try #require(promptConsume.range(of: "guard self.upsertExecApproval("))
        let notificationOwnerCheck = try #require(promptConsume.range(of: "guard let approvalOwnerKey"))
        #expect(guardedUpsert.lowerBound < notificationOwnerCheck.lowerBound)
        let upsertAdmission = promptConsume[guardedUpsert.lowerBound..<notificationOwnerCheck.lowerBound]
        #expect(upsertAdmission.contains("else { return }"))
        #expect(upsert.contains("resetResolutionAttemptID: String? = nil) -> Bool"))
        #expect(upsert.components(separatedBy: "return false").count >= 3)
        #expect(upsert.contains("return true"))
        #expect(promptConsume.contains(
            "resetResolutionAttemptID: message.resetResolutionAttemptId"))
        #expect(upsert.contains("let activeResolutionAttemptID ="))
        #expect(upsert.contains(
            "WatchOpaqueUTF8Key(resetResolutionAttemptID) == WatchOpaqueUTF8Key(activeResolutionAttemptID)"))
        #expect(upsert.contains("activeResolutionAttemptID = resetResolvingState ? nil"))
        #expect(!storeSource.contains("appliedResetDeliveryIDs"))
        #expect(!storeSource.contains("deliveryId"))
        #expect(!storeSource.contains("resetResolvingState: Bool?"))
    }

    @Test func `watch rejects partial or missing approval snapshot arrays`() throws {
        let receiverSource = try Self.readWatchSource("WatchConnectivityReceiver.swift")
        let parser = try Self.extract(
            receiverSource,
            from: "private static func parseExecApprovalSnapshotPayload(",
            to: "private static func parseAppSnapshotPayload(")

        #expect(parser.contains("guard let rawApprovals = payload[\"approvals\"] as? [Any]"))
        #expect(parser.contains("guard let approval = Self.parseExecApprovalItem(item) else { return nil }"))
        #expect(!parser.contains("compactMap"))
        #expect(!parser.contains("?? []"))
    }

    @Test func `watch preserves semantic approval outcomes through receiver parsing`() throws {
        let receiverSource = try Self.readWatchSource("WatchConnectivityReceiver.swift")
        let parser = try Self.extract(
            receiverSource,
            from: "private static func parseExecApprovalResolvedPayload(",
            to: "private static func parseExecApprovalExpiredPayload(")

        #expect(parser.contains(
            "WatchExecApprovalResolvedMessage.parseTransportOutcome(payload[\"outcome\"])"))
        #expect(parser.contains("outcome: outcome"))
    }

    @Test func `watch reuses exact compound identifier policy`() throws {
        let receiverSource = try Self.readWatchSource("WatchConnectivityReceiver.swift")
        let storeSource = try Self.readWatchSource("WatchInboxStore.swift")
        let messagesSource = try Self.readWatchSource("WatchInboxMessages.swift")
        let viewSource = try Self.readWatchSource("WatchInboxView.swift")
        let parser = try Self.extract(
            receiverSource,
            from: "private static func parseExecApprovalItem(",
            to: "private static func parseExecApprovalPromptPayload(")
        let ownerKey = try Self.extract(
            storeSource,
            from: "private static func execApprovalOwnerKey(",
            to: "private func isExecApprovalTerminal(")
        let snapshotConsume = try Self.extract(
            storeSource,
            from: "func consume(\n        execApprovalSnapshot",
            to: "func consume(appSnapshot")
        let restore = try Self.extract(
            storeSource,
            from: "private func restorePersistedState()",
            to: "private func persistState()")
        let prefixed = "\u{001C}approval"
        #expect(ExecApprovalIdentifier.exact(prefixed) == prefixed)
        #expect(ExecApprovalIdentifier.exact(" approval ") == " approval ")
        #expect(ExecApprovalIdentifier.exact(".") == nil)
        #expect(GatewayStableIdentifier.exact(" gateway ") == " gateway ")
        #expect(messagesSource.contains("typealias WatchApprovalID = ExecApprovalIdentifier"))
        #expect(messagesSource.contains("typealias WatchGatewayID = GatewayStableIdentifier"))
        #expect(parser.contains("WatchApprovalID.exact(payload[\"id\"] as? String)"))
        #expect(!parser.contains("id = (payload[\"id\"] as? String)?.trimmingCharacters"))
        #expect(ownerKey.contains("WatchApprovalID.key(approvalId)"))
        #expect(!ownerKey.contains("approvalId.trimmingCharacters"))
        #expect(snapshotConsume.contains("WatchApprovalID.exact(approval.id) != nil"))
        #expect(snapshotConsume.contains("let hasCanonicalRequestCorrelation ="))
        #expect(snapshotConsume.contains("guard hasCanonicalRequestCorrelation else { return true }"))
        #expect(restore.contains("WatchApprovalID.exact(record.approvalID) != nil"))
        let composedID = "approval-\u{00E9}"
        let decomposedID = "approval-e\u{0301}"
        let composedKey = ExactOpaqueIdentifierKey(composedID)
        let decomposedKey = ExactOpaqueIdentifierKey(decomposedID)
        #expect(composedID == decomposedID)
        #expect(composedKey != decomposedKey)

        var pending = [composedKey: composedID, decomposedKey: decomposedID]
        pending.removeValue(forKey: composedKey)
        let remainingID = try #require(pending[decomposedKey])
        #expect(Array(remainingID.utf8) == Array(decomposedID.utf8))

        #expect(messagesSource.contains("typealias WatchOpaqueUTF8Key = ExactOpaqueIdentifierKey"))
        #expect(messagesSource.contains("var id: WatchExecApprovalIdentityKey"))
        #expect(messagesSource.contains("var approvalID: WatchApprovalID.Key"))
        #expect(messagesSource.contains("var gatewayID: WatchGatewayID.Key"))
        #expect(storeSource.contains("WatchApprovalID.key(tombstone.approvalId) == key.approvalID"))
        #expect(storeSource.contains("WatchGatewayID.key(tombstone.gatewayStableID) == key.gatewayID"))
        #expect(storeSource.contains("approvalKey.notificationComponent"))
        #expect(storeSource.contains("gatewayKey.notificationComponent"))
        #expect(!storeSource.contains("record.id == approval.id"))
        #expect(!messagesSource.contains("record.id == approval.id"))
        #expect(!storeSource.contains("tombstone.approvalId == key.approvalId"))
        #expect(receiverSource.contains("WatchGatewayID.exact(payload[\"gatewayStableID\"] as? String)"))
        #expect(!receiverSource.contains("gatewayStableID?.trimmingCharacters"))
        #expect(viewSource.contains("record.approvalID"))
        #expect(viewSource.contains("$0.id == self.record.id"))
    }

    @Test func `watch requires full accessible command review before allow`() throws {
        let viewSource = try Self.readWatchSource("WatchInboxView.swift")
        let detailScrollSource = try Self.readWatchSource("WatchDetailScroll.swift")
        let typographySource = try Self.readWatchSource("WatchClawTypography.swift")
        let approvalFace = try Self.extract(
            viewSource,
            from: "private var approvalsFace: some View",
            to: "private var connectionFace: some View")
        let commandReview = try Self.extract(
            viewSource,
            from: "private struct WatchApprovalCommandReview: View",
            to: "private enum WatchExecApprovalDisplay")
        let approvalDetailStart = try #require(
            viewSource.range(of: "private struct WatchExecApprovalDetailView: View"))
        let approvalDetail = String(viewSource[approvalDetailStart.lowerBound...])
        let decisionButton = try Self.extract(
            viewSource,
            from: "private struct WatchDecisionButton: View",
            to: "private struct WatchTinyStatus")
        let detailScrollStart = try #require(
            detailScrollSource.range(of: "struct WatchDetailScroll<Content: View>: View"))
        let detailScroll = String(detailScrollSource[detailScrollStart.lowerBound...])

        #expect(approvalFace.contains("WatchSecondaryLabel(title: \"Review Command\")"))
        #expect(approvalFace.contains(
            ".accessibilityHint(\"Opens the full command before decisions are available\")"))
        #expect(!approvalFace.contains("WatchDecisionButton("))
        #expect(commandReview.contains("Text(verbatim: self.commandText)"))
        #expect(commandReview.contains(".font(WatchClawType.command)"))
        #expect(commandReview.contains(".fixedSize(horizontal: false, vertical: true)"))
        #expect(!commandReview.contains(".lineLimit("))
        #expect(commandReview.contains(".accessibilityLabel(\"Command to review\")"))
        #expect(commandReview.contains(".accessibilityValue(self.commandText)"))
        #expect(typographySource.contains(
            ".custom(\"JetBrainsMono-Regular\", size: 11, relativeTo: .body)"))
        #expect(approvalDetail.contains("WatchDetailScroll(title: \"Review Command\")"))
        #expect(approvalDetail.contains("WatchApprovalCommandReview(commandText: self.commandText)"))
        #expect(approvalDetail.contains("VStack(spacing: 8)"))
        #expect(approvalDetail.contains("WatchDecisionButton(title: \"Allow Once\""))
        #expect(approvalDetail.contains("WatchDecisionButton(title: \"Deny\""))
        #expect(!approvalDetail.contains("WatchDecisionButton(title: \"Approve\""))
        let fullCommand = try #require(
            approvalDetail.range(of: "WatchApprovalCommandReview(commandText: self.commandText)"))
        let allowAction = try #require(
            approvalDetail.range(of: "WatchDecisionButton(title: \"Allow Once\""))
        let denyAction = try #require(
            approvalDetail.range(of: "WatchDecisionButton(title: \"Deny\""))
        #expect(fullCommand.lowerBound < allowAction.lowerBound)
        #expect(fullCommand.lowerBound < denyAction.lowerBound)
        #expect(decisionButton.contains(".fixedSize(horizontal: false, vertical: true)"))
        #expect(decisionButton.contains(".accessibilityLabel(self.title)"))
        #expect(!decisionButton.contains(".lineLimit("))
        #expect(detailScroll.contains("ScrollView {"))
        #expect(detailScroll.contains("self.content"))
    }

    @Test func `watch notification identity frames dotted components`() throws {
        let storeSource = try Self.readWatchSource("WatchInboxStore.swift")
        let messagesSource = try Self.readWatchSource("WatchInboxMessages.swift")
        let identifierSource = try Self.readIOSServiceSource("ExactOpaqueIdentifier.swift")
        let promptConsume = try Self.extract(
            storeSource,
            from: "func consume(\n        execApprovalPrompt",
            to: "func consume(\n        execApprovalSnapshot")
        let rawLeft = "a.b" + "." + "c"
        let rawRight = "a" + "." + "b.c"
        #expect(rawLeft == rawRight)

        let framedLeft = ExactOpaqueIdentifierKey("a.b").notificationComponent + "."
            + ExactOpaqueIdentifierKey("c").notificationComponent
        let framedRight = ExactOpaqueIdentifierKey("a").notificationComponent + "."
            + ExactOpaqueIdentifierKey("b.c").notificationComponent
        #expect(framedLeft != framedRight)
        #expect(messagesSource.contains("typealias WatchOpaqueUTF8Key = ExactOpaqueIdentifierKey"))
        #expect(identifierSource.contains("0x2D, 0x5F, 0x7E"))
        #expect(!identifierSource.contains("0x2D, 0x2E, 0x5F, 0x7E"))
        #expect(!storeSource.contains("0x2D, 0x2E, 0x5F, 0x7E"))
        #expect(storeSource.contains("gatewayKey.notificationComponent).\\(approvalKey.notificationComponent"))
        #expect(storeSource.contains("legacyExecApprovalNotificationIdentifier"))
        #expect(storeSource.contains("hasLiveLegacyNotificationCollision"))
        #expect(storeSource.contains("recordKey != excludedKey"))
        let legacyCleanup = try #require(
            promptConsume.range(of: "if let legacyNotificationIdentifier"))
        let notificationSchedule = try #require(
            promptConsume.range(of: "await self.postLocalNotification("))
        #expect(legacyCleanup.lowerBound < notificationSchedule.lowerBound)
        #expect(promptConsume.contains("!self.hasLiveLegacyNotificationCollision("))
        #expect(promptConsume.contains(
            "self.removeLocalNotifications(identifiers: [legacyNotificationIdentifier])"))
    }

    @Test func `watch snapshot acknowledgment advances only after store acceptance`() throws {
        let storeSource = try Self.readWatchSource("WatchInboxStore.swift")
        let receiverSource = try Self.readWatchSource("WatchConnectivityReceiver.swift")
        let snapshotConsume = try Self.extract(
            storeSource,
            from: "func consume(\n        execApprovalSnapshot",
            to: "func consume(appSnapshot")
        let replay = try Self.extract(
            storeSource,
            from: "func replayDeferredGatewayPayloads()",
            to: "private func clearMessagePrompt()")
        let correlation = try #require(snapshotConsume.range(of: "let hasCanonicalRequestCorrelation"))
        let ownerValidation = try #require(snapshotConsume.range(of: "let allApprovalOwnersMatch"))
        let existingRecords = try #require(snapshotConsume.range(of: "let existingRecords = self.execApprovals"))

        #expect(snapshotConsume.contains("transport: String) -> Bool"))
        #expect(snapshotConsume.components(separatedBy: "return false").count >= 4)
        #expect(snapshotConsume.contains("self.persistState()\n        return true"))
        #expect(receiverSource.contains(
            "if self.store.consume(execApprovalSnapshot: execApprovalSnapshot, transport: transport)"))
        #expect(receiverSource.contains(
            "if self.store.consume(execApprovalSnapshot: snapshot, transport: transport)"))
        #expect(replay.contains(
            "func replayDeferredGatewayPayloads() -> [WatchExecApprovalSnapshotMessage]"))
        #expect(replay.contains(
            "var appliedExecApprovalSnapshots: [WatchExecApprovalSnapshotMessage] = []"))
        #expect(replay.contains("if self.consume(execApprovalSnapshot: message, transport: transport)"))
        #expect(replay.contains("appliedExecApprovalSnapshots.append(message)"))
        #expect(replay.contains("return appliedExecApprovalSnapshots"))
        #expect(receiverSource.components(
            separatedBy: "for snapshot in self.store.replayDeferredGatewayPayloads()").count == 3)
        #expect(receiverSource.components(
            separatedBy: "self.recordAcceptedExecApprovalSnapshot(snapshot)").count >= 3)
        #expect(!receiverSource.contains("execApprovalSnapshotRevision"))
        #expect(correlation.lowerBound < ownerValidation.lowerBound)
        #expect(ownerValidation.lowerBound < existingRecords.lowerBound)
        #expect(snapshotConsume.contains("guard allApprovalOwnersMatch else { return false }"))
        #expect(snapshotConsume.contains(
            "Self.gatewayIDsMatch(approval.gatewayStableID, snapshotGatewayID)"))
    }

    private static func readWatchSource(_ filename: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WatchApp/Sources")
            .appendingPathComponent(filename)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private static func readIOSServiceSource(_ filename: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Services")
            .appendingPathComponent(filename)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
