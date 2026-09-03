import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private actor SettingsPatchCounter {
    private var count = 0

    func increment() {
        self.count += 1
    }

    func current() -> Int {
        self.count
    }
}

struct ChatViewModelOutboxSettingsTests {
    @Test func `background replay uses its command owned session settings`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let expectation = OpenClawChatSessionSettingsExpectation(
            permissionMode: .guarded,
            toolOverrides: OpenClawChatSessionToolOverrides(webSearch: false))
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "background-settings",
            text: "use captured authority",
            createdAt: Date().timeIntervalSince1970,
            sessionKey: "background",
            expectedSessionSettings: expectation)))
        let transport = OutboxTestTransport(
            healthy: true,
            sessions: [
                outboxSessionEntry(key: "main", thinkingLevels: ["off"], permissionMode: .full),
                outboxSessionEntry(key: "background", thinkingLevels: ["off"], permissionMode: .guarded),
            ],
            supportsSessionSettingsCAS: true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await waitUntil("background command dispatch") {
            await transport.state.sentMessages == ["use captured authority"]
        }

        #expect(await transport.state.sentSessionKeys == ["agent:main:background"])
        #expect(await transport.state.sentSessionSettings.count == 1)
        #expect(await transport.state.sentSessionSettings[0] == expectation)
    }

    @Test(arguments: [false, true])
    func `settings failures remain retryable before outbox reload`(gatewayRejectsSettings: Bool) async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "legacy-settings",
            text: "review before replay",
            createdAt: Date().timeIntervalSince1970,
            expectedSessionSettings: gatewayRejectsSettings
                ? OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil)
                : nil)))
        let outbox = ScriptedOutbox(base: store)
        let transport = OutboxTestTransport(
            healthy: false,
            sessions: [outboxSessionEntry(key: "main", thinkingLevels: ["off"])],
            supportsSessionSettingsCAS: true)
        await transport.state.update { $0.sendSettingsChanged = gatewayRejectsSettings }
        let vm = await makeOutboxViewModel(transport: transport, outbox: outbox)

        await MainActor.run { vm.load() }
        try await waitUntil("offline bootstrap settled") {
            await MainActor.run { !vm.isLoading && vm.hasRestoredOutboxMessages }
        }
        await outbox.holdLoadAfterFailure()
        await transport.goOnline()
        await outbox.waitUntilSnapshotCaptured()

        do {
            #expect(await transport.state.sentMessages.isEmpty)
            let failed = try #require(await store.loadCommands().first)
            #expect(failed.lastError == (gatewayRejectsSettings
                    ? OpenClawChatSQLiteTranscriptCache.outboxSettingsChangedError
                    : OpenClawChatSQLiteTranscriptCache.outboxSettingsReviewRequiredError))
            if !gatewayRejectsSettings {
                #expect(OpenClawChatSQLiteTranscriptCache.outboxDisplayError(failed.lastError) ==
                    "Session settings were not captured. Review and retry this message.")
            }
            await transport.state.update { $0.sendSettingsChanged = false }

            // A visible failure must authorize retry before any later reload can supply its version.
            let messageID = try #require(await MainActor.run {
                vm.messages.first { vm.outboxState(for: $0.id)?.isFailed == true }?.id
            })
            await MainActor.run { vm.retryOutboxMessage(messageID) }
            try await waitUntil("reviewed settings rebound before reload") {
                await store.loadCommands().first?.status == .queued
            }
        } catch {
            await outbox.releaseSnapshot()
            try? await waitUntil("failed proof flush released") {
                await MainActor.run { !vm.isFlushingOutbox }
            }
            throw error
        }
        await outbox.releaseSnapshot()
        try await waitUntil("reviewed settings rebound and sent") {
            await transport.state.sentMessages == ["review before replay"]
        }
        #expect(await transport.state.sentSessionSettings == [
            OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil),
        ])
    }

    @Test(arguments: [OpenClawChatOutboxUpdateResult.updated, .unavailable, .confirmed, .superseded])
    func `pre CAS parking honors the terminal write result`(
        terminalResult: OpenClawChatOutboxUpdateResult) async throws
    {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let command = outboxTestCommand(
            id: "pre-cas-settings",
            text: "wait for gateway upgrade",
            createdAt: Date().timeIntervalSince1970,
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(
                permissionMode: .guarded,
                toolOverrides: nil))
        #expect(await store.enqueueCommand(command))
        let outbox = ScriptedOutbox(base: store)
        await outbox.setTerminalWriteResult(terminalResult)
        let transport = OutboxTestTransport(healthy: false, supportsSessionSettingsCAS: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: outbox)

        await MainActor.run { vm.load() }
        await transport.goOnline()
        try await waitUntil("pre-CAS terminal result settled") {
            let commands = await store.loadCommands()
            let storedResult = switch terminalResult {
            case .updated: commands.first?.status == .failed
            case .unavailable: commands.first?.status == .sending
            case .confirmed, .missing: commands.isEmpty
            case .superseded: commands.first?.status == .sending && commands.first?.attemptVersion == command
                .attemptVersion + 1
            }
            return await MainActor.run {
                storedResult && !vm.isFlushingOutbox && (terminalResult != .unavailable || !vm.healthOK)
            }
        }
        #expect(await transport.state.sentMessages.isEmpty)
        if terminalResult == .updated {
            #expect(await store.loadCommands().first?.lastError ==
                OpenClawChatSQLiteTranscriptCache.outboxSettingsGatewayUpgradeRequiredError)
        } else {
            #expect(await MainActor.run {
                vm.messages.allSatisfy { vm.outboxState(for: $0.id)?.isFailed != true }
            })
        }
    }

    @Test func `failed restrictive patch cannot release a later automatic flush`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let fullAccess = OpenClawChatSessionSettingsExpectation(permissionMode: .full, toolOverrides: nil)
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "failed-restriction",
            text: "do not auto release",
            createdAt: Date().timeIntervalSince1970,
            expectedSessionSettings: fullAccess)))
        let patchRelease = DeleteGate()
        let patchStarted = DeleteGate()
        let catalog = OpenClawChatComposerCapabilityCatalog(
            sessionSettingsAvailable: true,
            permissionMutationAvailable: true,
            sessionSettingsCASAvailable: true)
        let transport = OutboxTestTransport(
            healthy: false,
            sessions: [
                outboxSessionEntry(
                    key: "main",
                    thinkingLevels: ["off"],
                    sessionID: "session-main",
                    permissionMode: .full),
                outboxSessionEntry(key: "other", thinkingLevels: ["off"]),
            ],
            supportsSessionSettingsCAS: true,
            composerCapabilityCatalog: catalog,
            sessionSettingsPatchHook: {
                await patchStarted.open()
                await patchRelease.wait()
                throw NSError(
                    domain: "ChatViewModelOutboxSettingsTests",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Restriction was not saved."])
            })
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { vm.load() }
        try await waitUntil("outbox restore") {
            await MainActor.run { vm.hasRestoredOutboxMessages }
        }
        await MainActor.run {
            vm.sessions = [outboxSessionEntry(
                key: "main",
                thinkingLevels: ["off"],
                sessionID: "session-main",
                permissionMode: .full)]
            vm.sessionId = "session-main"
        }
        await vm.loadComposerCapabilities()
        await MainActor.run { vm.selectComposerPermissionMode(.guarded) }
        await patchStarted.wait()
        #expect(await transport.state.sentMessages.isEmpty)
        await MainActor.run { vm.switchSession(to: "other") }
        await patchRelease.open()
        try await waitUntil("queued row parked before flush") {
            await store.loadCommands().first?.status == .failed
        }

        let reopened = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run {
            reopened.load()
            reopened.readySessionMetadataGeneration = reopened.sessionMetadataGeneration
            reopened.reconciledOutboxBranchScopes.insert(
                OpenClawChatOutboxScope(sessionKey: "main", agentID: "main"))
            reopened.applyTransportHealth(true)
            reopened.flushOutboxIfNeeded()
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(await transport.state.sentMessages.isEmpty)
        #expect(await store.loadCommands().first?.lastError ==
            OpenClawChatSQLiteTranscriptCache.outboxSettingsChangedError)
    }

    @Test func `bulk settings failure immediately publishes failed bubble state`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "visible-settings-failure",
            text: "show the failure",
            createdAt: Date().timeIntervalSince1970,
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(
                permissionMode: .guarded,
                toolOverrides: nil))))
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { vm.load() }
        try await waitUntil("queued bubble restored") {
            await MainActor.run { vm.messages.contains { vm.outboxState(for: $0.id) == .queued } }
        }

        #expect(await store.parkQueuedCommands(
            in: OpenClawChatOutboxScope(sessionKey: "main", agentID: "main"),
            lastError: "Restriction was not saved."))
        try await waitUntil("failed bubble published") {
            await MainActor.run {
                vm.messages.contains { vm.outboxState(for: $0.id)?.isFailed == true }
            }
        }
    }

    @Test func `settings mutation does not reach gateway when durable parking fails`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "parking-unavailable",
            text: "keep queued safely",
            createdAt: Date().timeIntervalSince1970,
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(
                permissionMode: .full,
                toolOverrides: nil))))
        let scripted = ScriptedOutbox(base: store)
        await scripted.setParkingAvailable(false)
        let patchCalls = SettingsPatchCounter()
        let catalog = OpenClawChatComposerCapabilityCatalog(
            sessionSettingsAvailable: true,
            permissionMutationAvailable: true,
            sessionSettingsCASAvailable: true)
        let transport = OutboxTestTransport(
            healthy: false,
            composerCapabilityCatalog: catalog,
            sessionSettingsPatchHook: { await patchCalls.increment() })
        let vm = await makeOutboxViewModel(transport: transport, outbox: scripted)
        await MainActor.run {
            vm.sessions = [outboxSessionEntry(
                key: "main",
                thinkingLevels: ["off"],
                sessionID: "session-main",
                permissionMode: .full)]
            vm.sessionId = "session-main"
        }
        await vm.loadComposerCapabilities()

        await MainActor.run { vm.selectComposerPermissionMode(.guarded) }
        try await waitUntil("parking failure settles") {
            await MainActor.run {
                !vm.composerCapabilityMutationDisabled &&
                    vm.errorText == "Could not secure queued messages before changing session settings."
            }
        }

        #expect(await patchCalls.current() == 0)
        #expect(await store.loadCommands().first?.status == .queued)
    }
}
