import Foundation
import OpenClawKit
import SQLite3
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalsUIRollbackTests {
    @Test
    func `migration requirement surfaces without automatic retry`() async throws {
        try await self.withTempStateDir { stateDirectoryURL in
            let migrationError = ExecApprovalsLegacyMigrationRequiredError(
                stateDirectoryURL: stateDirectoryURL,
                legacyFileURL: stateDirectoryURL.appendingPathComponent("exec-approvals.json"))
            var quickModeReadCount = 0
            let state = AppState(
                preview: true,
                execApprovalsDefaultsAsyncResolver: {
                    quickModeReadCount += 1
                    return .failure(.migrationRequired(migrationError))
                },
                execApprovalsReadRetryDelay: .zero)

            await state.recoverExecApprovalModeRead(maxAttempts: 5)

            #expect(quickModeReadCount == 1)
            #expect(state.execApprovalLoadError == ExecApprovalsReadError.migrationRequired(migrationError).message)

            var settingsReadCount = 0
            let model = ExecApprovalsSettingsModel(
                resolveApprovalsAsync: { _ in
                    settingsReadCount += 1
                    return .failure(.migrationRequired(migrationError))
                },
                readRetryDelay: .zero,
                automaticReadRetryAttempts: 5)

            await model.loadSettings(for: "main")

            #expect(settingsReadCount == 1)
            #expect(model.readErrorMessage == ExecApprovalsReadError.migrationRequired(migrationError).message)
        }
    }

    @Test
    func `quick mode recovers after initial approvals read is unavailable`() async throws {
        try await self.withTempStateDir { stateDir in
            _ = try ExecApprovalsStore.updateDefaults { defaults in
                defaults.security = .full
                defaults.ask = .off
            }.get()
            let record = try ExecApprovalsSQLiteStore.read(stateDirectoryURL: stateDir)
            let rawJSON = try #require(record?.rawJSON)
            try Self.replaceRawJSON("{", stateDirectoryURL: stateDir)

            let state = AppState(
                preview: true,
                execApprovalsReadRetryDelay: .zero)

            #expect(state.execApprovalPolicyLoadState == .loading)
            await state.recoverExecApprovalModeRead(maxAttempts: 1)

            #expect(!state.execApprovalPolicyAvailable)
            #expect(state.execApprovalLoadError != nil)

            try Self.replaceRawJSON(rawJSON, stateDirectoryURL: stateDir)
            await state.recoverExecApprovalModeRead(maxAttempts: 1)

            #expect(state.execApprovalPolicyAvailable)
            #expect(state.execApprovalMode == .allow)
            #expect(state.execApprovalLoadError == nil)
        }
    }

    @Test
    func `settings recover after initial approvals read is unavailable`() async throws {
        try await self.withTempStateDir { stateDir in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { agent in
                agent.security = .full
                agent.ask = .off
            }.get()
            _ = try ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/usr/bin/printf").get()
            let record = try ExecApprovalsSQLiteStore.read(stateDirectoryURL: stateDir)
            let rawJSON = try #require(record?.rawJSON)
            try Self.replaceRawJSON("{", stateDirectoryURL: stateDir)
            let model = ExecApprovalsSettingsModel(
                readRetryDelay: .zero,
                automaticReadRetryAttempts: 0)
            let previousMode = AppStateStore.shared.execApprovalMode
            defer { AppStateStore.shared.syncExecApprovalMode(previousMode) }
            AppStateStore.shared.syncExecApprovalMode(.ask)

            #expect(model.policyLoadState == .loading)
            #expect(model.readErrorMessage == nil)
            await model.loadSettings(for: "main")

            #expect(!model.policyAvailable)
            #expect(model.readErrorMessage != nil)

            try Self.replaceRawJSON(rawJSON, stateDirectoryURL: stateDir)
            await model.retryUnavailableSettings(maxAttempts: 1)

            #expect(model.policyAvailable)
            #expect(model.security == .full)
            #expect(model.ask == .off)
            #expect(model.entries.map(\.pattern) == ["/usr/bin/printf"])
            #expect(model.readErrorMessage == nil)
            #expect(AppStateStore.shared.execApprovalMode == .ask)
        }
    }

    @Test
    func `defaults mutation refreshes quick mode through app state owner`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateDefaults { defaults in
                defaults.security = .allowlist
                defaults.ask = .onMiss
            }.get()
            var readCount = 0
            let model = ExecApprovalsSettingsModel(
                resolveDefaultsAsync: {
                    readCount += 1
                    if readCount == 2 {
                        return .failure(.unavailable)
                    }
                    return await ExecApprovalsStore.resolveDefaultsAsyncResult()
                },
                readRetryDelay: .zero,
                automaticReadRetryAttempts: 0)
            model.selectAgent("__defaults__")
            await model.waitForPendingSettingsRead()
            let previousMode = AppStateStore.shared.execApprovalMode
            defer { AppStateStore.shared.syncExecApprovalMode(previousMode) }
            AppStateStore.shared.syncExecApprovalMode(.ask)

            model.setSecurity(.full)
            #expect(model.security == .full)
            await model.waitForPendingSettingsRead()
            await AppStateStore.shared.waitForExecApprovalModeRead()

            #expect(!model.policyAvailable)
            #expect(AppStateStore.shared.execApprovalMode == .allow)

            await model.retryUnavailableSettings(maxAttempts: 1)

            #expect(model.policyAvailable)
            #expect(model.security == .full)
            #expect(AppStateStore.shared.execApprovalMode == .allow)
            #expect(readCount == 3)
        }
    }

    @Test
    func `latest overlapping retry owns settings availability`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { agent in
                agent.security = .full
                agent.ask = .off
            }.get()
            var readCount = 0
            let retryGate = ExecApprovalsReadGate()
            let model = ExecApprovalsSettingsModel(
                resolveApprovalsAsync: { agentId in
                    readCount += 1
                    let currentRead = readCount
                    if currentRead == 2 {
                        await retryGate.enterAndWait()
                        return .failure(.unavailable)
                    }
                    if currentRead == 3 {
                        return await ExecApprovalsStore.resolveAsyncResult(agentId: agentId)
                    }
                    return .failure(.unavailable)
                },
                readRetryDelay: .zero,
                automaticReadRetryAttempts: 0)

            await model.loadSettings(for: "main")
            let firstRetry = Task {
                await model.retryUnavailableSettings(maxAttempts: 1)
            }
            await retryGate.waitUntilEntered()
            let latestRetry = Task {
                await model.retryUnavailableSettings(maxAttempts: 1)
            }
            await latestRetry.value
            await retryGate.release()
            await firstRetry.value

            #expect(model.policyAvailable)
            #expect(model.security == .full)
            #expect(model.ask == .off)
            #expect(model.readErrorMessage == nil)
            #expect(readCount == 3)
        }
    }

    @Test
    func `quick mode failure keeps last known value`() async throws {
        try await self.withTempStateDir { _ in
            let state = AppState(preview: true)
            state.syncExecApprovalMode(.ask)

            state.applyExecApprovalModeMutation(.allow, result: .failure(.unavailable))

            #expect(state.execApprovalMode == .ask)
            #expect(state.execApprovalMutationError == ExecApprovalsMutationError.unavailable.message)

            state.applyExecApprovalModeMutation(.allow, result: .success(()))

            #expect(state.execApprovalMode == .allow)
            #expect(state.execApprovalMutationError == nil)
        }
    }

    @Test
    func `settings failure keeps last known policy`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
            }.get()
            let model = ExecApprovalsSettingsModel()
            await model.loadSettings(for: "main")
            try Self.replaceRawJSON(
                "{",
                stateDirectoryURL: ExecApprovalsStore.databaseURL()
                    .deletingLastPathComponent()
                    .deletingLastPathComponent())

            model.setSecurity(.full)

            #expect(model.security == .allowlist)
            #expect(model.ask == .onMiss)
            #expect(model.mutationErrorMessage == ExecApprovalsMutationError.unavailable.message)
        }
    }

    @Test
    func `allowlist edit returns normalized value and rolls back failed draft`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/usr/bin/printf").get()
            let model = ExecApprovalsSettingsModel()
            await model.loadSettings(for: "main")
            let entry = try #require(model.entries.first)

            let normalized = model.updateEntry(pattern: "  /bin/echo  ", id: entry.id)
            await model.waitForPendingSettingsRead()

            #expect(normalized == "/bin/echo")
            #expect(model.entry(for: entry.id)?.pattern == "/bin/echo")

            try Self.replaceRawJSON(
                "{",
                stateDirectoryURL: ExecApprovalsStore.databaseURL()
                    .deletingLastPathComponent()
                    .deletingLastPathComponent())
            let rolledBack = model.updateEntry(pattern: "/bin/cat", id: entry.id)

            #expect(rolledBack == "/bin/echo")
            #expect(model.entry(for: entry.id)?.pattern == "/bin/echo")
            #expect(model.mutationErrorMessage == ExecApprovalsMutationError.unavailable.message)
        }
    }

    @Test
    func `inherited allowlist removal remains visible and reports its owning scope`() async throws {
        try await self.withTempStateDir { _ in
            let inherited = ExecAllowlistEntry(id: "wildcard-entry", pattern: "/usr/bin/printf")
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "*") { entry in
                entry.allowlist = [inherited]
            }.get()
            let model = ExecApprovalsSettingsModel()
            await model.loadSettings(for: "main")
            #expect(model.entries.map(\.id) == [inherited.id])

            model.removeEntry(id: inherited.id)

            #expect(model.entries.map(\.id) == [inherited.id])
            #expect(model.mutationErrorMessage == ExecApprovalsMutationError.entryNotOwned.message)
            #expect(ExecApprovalsStore.loadFile().agents?["*"]?.allowlist?.map(\.id) == [inherited.id])
        }
    }

    private func withTempStateDir<T>(
        _ body: (URL) async throws -> T) async throws -> T
    {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-approvals-ui-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        return try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            try await body(stateDir)
        }
    }

    private static func replaceRawJSON(
        _ rawJSON: String,
        stateDirectoryURL: URL) throws
    {
        let databaseURL = ExecApprovalsSQLiteStore.databaseURL(
            stateDirectoryURL: stateDirectoryURL)
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw SQLiteTestError.open
        }
        defer { sqlite3_close(database) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(
            database,
            "UPDATE exec_approvals_config SET raw_json = ? WHERE config_key = 'current'",
            -1,
            &statement,
            nil) == SQLITE_OK,
            let statement
        else {
            throw SQLiteTestError.prepare
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, 1, rawJSON, -1, transient) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_DONE
        else {
            throw SQLiteTestError.update
        }
    }

    private enum SQLiteTestError: Error {
        case open
        case prepare
        case update
    }
}

private actor ExecApprovalsReadGate {
    private var entered = false
    private var released = false
    private var entryWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func enterAndWait() async {
        self.entered = true
        self.entryWaiter?.resume()
        self.entryWaiter = nil
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            self.releaseWaiter = continuation
        }
    }

    func waitUntilEntered() async {
        guard !self.entered else { return }
        await withCheckedContinuation { continuation in
            self.entryWaiter = continuation
        }
    }

    func release() {
        self.released = true
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}
