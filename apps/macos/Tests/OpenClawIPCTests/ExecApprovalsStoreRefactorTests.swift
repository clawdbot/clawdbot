import Foundation
import OpenClawKit
import SQLite3
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    private var realTemporaryDirectory: URL {
        let path = FileManager().temporaryDirectory.path
        if path.hasPrefix("/var/") {
            return URL(fileURLWithPath: "/private\(path)", isDirectory: true)
        }
        return FileManager().temporaryDirectory.resolvingSymlinksInPath()
    }

    private func withTempStateDir(
        seedCurrentApprovals: Bool = true,
        _ body: @escaping @Sendable (URL) async throws -> Void) async throws
    {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        if seedCurrentApprovals {
            try Self.seedCurrentApprovalsFile(in: stateDir)
        }

        try await ExecApprovalsStore.withStateDirectory(stateDir) {
            try await body(stateDir)
        }
    }

    @Test
    func `ensure store reuses socket token when unchanged`() async throws {
        try await self.withTempStateDir { _ in
            let first = ExecApprovalsStore.ensureFile()
            let second = ExecApprovalsStore.ensureFile()

            #expect(first.socket?.token == "test-token")
            #expect(second.socket?.token == first.socket?.token)
        }
    }

    @Test
    func `omitted policy fields match TypeScript defaults`() async throws {
        try await self.withTempStateDir { _ in
            let resolved = ExecApprovalsStore.resolve(agentId: "main")

            #expect(resolved.agent.security == .full)
            #expect(resolved.agent.ask == .off)
            #expect(resolved.agent.askFallback == .deny)
            #expect(!resolved.agent.autoAllowSkills)
        }
    }

    @Test
    func `migration cache logs once and recovers after the legacy identity clears`() {
        let stateDirectoryURL = URL(fileURLWithPath: "/tmp/openclaw-migration-cache-test")
        let legacyFileURL = stateDirectoryURL.appendingPathComponent("exec-approvals.json")
        let error = ExecApprovalsLegacyMigrationRequiredError(
            stateDirectoryURL: stateDirectoryURL,
            legacyFileURL: legacyFileURL)
        var identity: ExecApprovalsMigrationRequiredCache.FileIdentity? = .init(
            device: 1,
            inode: 2,
            modificationSeconds: 3,
            modificationNanoseconds: 4)
        var identityReadCount = 0
        var events: [ExecApprovalsMigrationLogEvent] = []
        let cache = ExecApprovalsMigrationRequiredCache(
            identityReader: { _ in
                identityReadCount += 1
                return identity
            },
            onEvent: { events.append($0) })

        cache.record(error)
        #expect(cache.cachedError(stateDirectoryURL: stateDirectoryURL) == error)
        #expect(cache.cachedError(stateDirectoryURL: stateDirectoryURL) == error)
        #expect(identityReadCount == 3)
        #expect(events == [.required(error)])

        identity = nil
        #expect(cache.cachedError(stateDirectoryURL: stateDirectoryURL) == nil)
        cache.markResolved(stateDirectoryURL: stateDirectoryURL)
        #expect(identityReadCount == 4)
        #expect(events == [
            .required(error),
            .recovered(stateDirectoryPath: stateDirectoryURL.path),
        ])
    }

    @Test
    func `legacy migration failure is typed and removal recovers without restart`() async throws {
        try await self.withTempStateDir { stateDirectoryURL in
            let legacyFileURL = stateDirectoryURL.appendingPathComponent("exec-approvals.json")
            try FileManager.default.createDirectory(
                at: stateDirectoryURL,
                withIntermediateDirectories: true)
            try Data(#"{"version":1,"agents":{}}"#.utf8).write(to: legacyFileURL)

            let first = ExecApprovalsStore.resolveResult(agentId: "main")
            guard case .failure(.migrationRequired) = first else {
                Issue.record("expected typed migration-required failure")
                return
            }
            let second = ExecApprovalsStore.resolveResult(agentId: "main")
            guard case .failure(.migrationRequired) = second else {
                Issue.record("expected cached migration-required failure")
                return
            }

            try FileManager.default.removeItem(at: legacyFileURL)
            let recovered = try ExecApprovalsStore.resolveResult(agentId: "main").get()
            #expect(recovered.agent.security == .full)
            #expect(recovered.agent.ask == .off)
        }
    }

    @Test
    func `effective home owns the default approvals database and socket paths`() async throws {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-effective-home-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = home.appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try Self.seedCurrentApprovalsFile(in: stateDir)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": nil,
        ]) {
            #expect(ExecApprovalsStore.databaseURL().path == stateDir
                .appendingPathComponent("state/openclaw.sqlite").path)
            #expect(ExecApprovalsStore.socketPath() == stateDir.appendingPathComponent(
                "exec-approvals.sock").path)
            let resolved = try ExecApprovalsStore.resolveResult(agentId: "main").get()
            #expect(resolved.agent.security == .full)
            #expect(resolved.agent.ask == .off)
        }
    }

    @Test
    func `malformed SQLite document fails closed and rejects mutation`() async throws {
        try await self.withTempStateDir { _ in
            try Self.replaceRawJSON("{")

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.agent.security == .deny)
            #expect(resolved.agent.ask == .off)
            #expect(resolved.agent.askFallback == .deny)

            var snapshot = ExecApprovalsStore.readSnapshot()
            snapshot.file.defaults = ExecApprovalsDefaults(security: .full)
            let result = ExecApprovalsStore.saveFile(snapshot.file, ifBaseHash: snapshot.hash)
            guard case .unavailable = result else {
                Issue.record("expected malformed-file mutation failure")
                return
            }

            let unchanged = ExecApprovalsStore.readSnapshot()
            #expect(unchanged.file.defaults?.security == .deny)
            #expect(unchanged.file.defaults?.ask == .off)
        }
    }

    @Test
    func `explicit null policy structures fail closed and reject mutation`() async throws {
        try await self.withTempStateDir { _ in
            for json in [
                #"{"version":1,"defaults":null}"#,
                #"{"version":1,"defaults":{"security":null}}"#,
                #"{"version":1,"agents":null}"#,
                #"{"version":1,"agents":{"main":{"allowlist":null}}}"#,
                #"{"version":1,"agents":{"main":{"allowlist":[{"pattern":null}]}}}"#,
                #"{"version":1,"agents":{"main":{"allowlist":[{"pattern":""}]}}}"#,
                #"{"version":1,"agents":{"main":{"allowlist":[{"pattern":"   "}]}}}"#,
                #"{"version":1,"agents":{"main":{"allowlist":[{"pattern":"/usr/bin/foo","argPattern":null}]}}}"#,
                #"{"version":1,"agents":{"main":{"allowlist":[{"pattern":"/usr/bin/foo","argPattern":0}]}}}"#,
                #"{"version":1,"agents":{"main":{"allowlist":[{"pattern":"/usr/bin/foo","argPattern":false}]}}}"#,
            ] {
                try Self.replaceRawJSON(json)

                let resolved = ExecApprovalsStore.resolve(agentId: "main")
                #expect(resolved.agent.security == .deny)
                #expect(resolved.agent.ask == .off)

                var snapshot = ExecApprovalsStore.readSnapshot()
                snapshot.file.defaults = ExecApprovalsDefaults(security: .full)
                let result = ExecApprovalsStore.saveFile(snapshot.file, ifBaseHash: snapshot.hash)
                guard case .unavailable = result else {
                    Issue.record("expected invalid-structure mutation failure")
                    return
                }
            }
        }
    }

    @Test
    func `string source and arg pattern bytes remain cross-runtime compatible`() async throws {
        try await self.withTempStateDir { _ in
            try Self.replaceRawJSON(
                """
                {
                  "version": 1,
                  "agents": {
                    "main": {
                      "security": "allowlist",
                      "ask": "off",
                      "allowlist": [{
                        "id": "external-entry",
                        "pattern": "/usr/bin/printf",
                        "source": "external-policy",
                        "argPattern": "  "
                      }]
                    }
                  }
                }
                """)

            let resolved = try ExecApprovalsStore.resolveResult(agentId: "main").get()
            let entry = try #require(resolved.allowlist.first)

            #expect(resolved.agent.security == .allowlist)
            #expect(entry.id == "external-entry")
            #expect(entry.pattern == "/usr/bin/printf")
            #expect(entry.source == "external-policy")
            #expect(entry.argPattern == "  ")

            let persisted = try #require(
                ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(persisted.source == "external-policy")
            #expect(persisted.argPattern == "  ")
        }
    }

    @Test
    func `conditional save preserves arg pattern bytes`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist = [ExecAllowlistEntry(pattern: "/usr/bin/rg", argPattern: " ^safe$ ")]
            }.get()

            let entry = try #require(
                ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(entry.argPattern == " ^safe$ ")
        }
    }

    @Test
    func `missing and present empty snapshots have distinct hashes`() async throws {
        try await self.withTempStateDir(seedCurrentApprovals: false) { _ in
            let missing = ExecApprovalsStore.readSnapshot()
            #expect(!missing.exists)
            #expect(missing.hash.hasPrefix("missing:"))

            _ = ExecApprovalsStore.ensureFile()
            let empty = ExecApprovalsStore.readSnapshot()

            #expect(empty.exists)
            #expect(!empty.hash.hasPrefix("missing:"))
            #expect(empty.hash != missing.hash)
        }
    }

    @Test
    func `native rewrites preserve non-sensitive metadata and arbitrary ids`() async throws {
        try await self.withTempStateDir { _ in
            try Self.replaceRawJSON(
                """
                {
                  "version": 1,
                  "agents": {
                    "main": {
                      "allowlist": [{
                        "id": "ts:approval/id",
                        "pattern": "/usr/bin/python3",
                        "source": "allow-always",
                        "commandText": "python3 safe.py",
                        "argPattern": "^safe\\\\.py$"
                      }]
                    }
                  }
                }
                """)

            _ = ExecApprovalsStore.ensureFile()
            let entry = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(entry.id == "ts:approval/id")
            #expect(entry.pattern == "/usr/bin/python3")
            #expect(entry.source == "allow-always")
            #expect(entry.commandText == nil)
            #expect(entry.argPattern == #"^safe\.py$"#)

            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist?.append(ExecAllowlistEntry(pattern: "/bin/echo", commandText: "echo secret-token"))
            }.get()
            let entries = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist)
            #expect(entries.allSatisfy { $0.commandText == nil })
            let record = try ExecApprovalsSQLiteStore.read(
                stateDirectoryURL: ExecApprovalsStore.databaseURL()
                    .deletingLastPathComponent()
                    .deletingLastPathComponent())
            let persisted = try #require(record)
            #expect(!persisted.rawJSON.contains("commandText"))
        }
    }

    @Test
    func `usage updates preserve metadata and select matching arg pattern`() async throws {
        try await self.withTempStateDir { _ in
            let first = ExecAllowlistEntry(
                id: "first",
                pattern: "/usr/bin/python3",
                source: "allow-always",
                commandText: "python3 a.py",
                argPattern: #"^a\.py$"#)
            let second = ExecAllowlistEntry(
                id: "second",
                pattern: "/usr/bin/python3",
                source: "allow-always",
                commandText: "python3 b.py",
                argPattern: #"^b\.py$"#)
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist = [first, second]
            }.get()

            _ = try ExecApprovalsStore.recordAllowlistUses(
                agentId: "main",
                uses: [ExecAllowlistUse(match: first, resolvedPath: "/usr/bin/python3")],
                command: "python3 a.py").get()

            let entries = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist)
            #expect(entries[0].lastUsedCommand == "python3 a.py")
            #expect(entries[0].source == "allow-always")
            #expect(entries[0].commandText == nil)
            #expect(entries[0].argPattern == #"^a\.py$"#)
            #expect(entries[1].lastUsedCommand == nil)
        }
    }

    @Test
    func `usage updates omit command text for generated hashed arg patterns`() async throws {
        try await self.withTempStateDir { _ in
            let hashed = ExecAllowlistEntry(
                id: "hashed",
                pattern: "/usr/bin/curl",
                source: "allow-always",
                argPattern: "sha256:argv:test-digest")
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist = [hashed]
            }.get()

            _ = try ExecApprovalsStore.recordAllowlistUses(
                agentId: "main",
                uses: [ExecAllowlistUse(match: hashed, resolvedPath: "/usr/bin/curl")],
                command: "curl https://trusted.example/install.sh?token=secret").get()

            let entry = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(entry.pattern == "/usr/bin/curl")
            #expect(entry.argPattern == "sha256:argv:test-digest")
            #expect(entry.lastUsedAt != nil)
            #expect(entry.lastResolvedPath == "/usr/bin/curl")
            #expect(entry.lastUsedCommand == nil)
        }
    }

    @Test
    func `usage checkpoint rejects a revoked reusable approval`() async throws {
        try await self.withTempStateDir { _ in
            let stale = ExecAllowlistEntry(id: "stale", pattern: "/usr/bin/printf")
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.allowlist = [stale]
            }.get()
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist = []
            }.get()

            let result = ExecApprovalsStore.recordAllowlistUses(
                agentId: "main",
                uses: [ExecAllowlistUse(match: stale, resolvedPath: "/usr/bin/printf")],
                command: "printf ok",
                authorization: .currentPolicy(
                    evaluatedSecurity: .allowlist,
                    evaluatedAsk: .off,
                    basis: .allowlistEntries))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected revoked approval checkpoint to fail")
                return
            }
            let allowlist = ExecApprovalsStore.loadFile().agents?["main"]?.allowlist
            #expect(allowlist?.isEmpty ?? true)
        }
    }

    @Test
    func `usage checkpoint rejects changed arg pattern bytes`() async throws {
        try await self.withTempStateDir { _ in
            let stale = ExecAllowlistEntry(
                id: "stale",
                pattern: "/usr/bin/rg",
                argPattern: "^safe$")
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.allowlist = [stale]
            }.get()
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist = [ExecAllowlistEntry(
                    id: "stale",
                    pattern: "/usr/bin/rg",
                    argPattern: " ^safe$ ")]
            }.get()

            let result = ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "rg safe",
                authorization: .currentPolicy(
                    evaluatedSecurity: .allowlist,
                    evaluatedAsk: .off,
                    basis: .allowlistEntries),
                uses: [ExecAllowlistUse(match: stale, resolvedPath: "/usr/bin/rg")]))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected changed arg pattern approval checkpoint to fail")
                return
            }
            let current = try #require(
                ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(current.argPattern == " ^safe$ ")
            #expect(current.lastUsedCommand == nil)
        }
    }

    @Test
    func `usage checkpoint rejects canonically equivalent changed arg pattern bytes`() async throws {
        try await self.withTempStateDir { _ in
            let evaluatedArgPattern = "^caf\u{00E9}$"
            let currentArgPattern = "^cafe\u{0301}$"
            #expect(evaluatedArgPattern == currentArgPattern)
            #expect(Data(evaluatedArgPattern.utf8) != Data(currentArgPattern.utf8))

            let stale = ExecAllowlistEntry(
                id: "stale",
                pattern: "/usr/bin/rg",
                argPattern: evaluatedArgPattern)
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.allowlist = [stale]
            }.get()
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist = [ExecAllowlistEntry(
                    id: "stale",
                    pattern: "/usr/bin/rg",
                    argPattern: currentArgPattern)]
            }.get()

            let result = ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "rg caf\u{00E9}",
                authorization: .currentPolicy(
                    evaluatedSecurity: .allowlist,
                    evaluatedAsk: .off,
                    basis: .allowlistEntries),
                uses: [ExecAllowlistUse(match: stale, resolvedPath: "/usr/bin/rg")]))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected Unicode-normalized approval checkpoint to fail")
                return
            }
            let current = try #require(
                ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(try Data(#require(current.argPattern).utf8) == Data(currentArgPattern.utf8))
            #expect(current.lastUsedCommand == nil)
        }
    }

    @Test
    func `allowlist match key separates embedded nul boundaries`() {
        let nulInPattern = ExecAllowlistEntry(
            pattern: "/usr/bin/rg\0safe",
            argPattern: "value")
        let nulInArgPattern = ExecAllowlistEntry(
            pattern: "/usr/bin/rg",
            argPattern: "safe\0value")

        #expect(
            ExecApprovalsStore.allowlistEntryMatchKey(nulInPattern) !=
                ExecApprovalsStore.allowlistEntryMatchKey(nulInArgPattern))
    }

    @Test
    func `execution commit rejects unprompted full policy after concurrent deny`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .deny
                entry.ask = .off
            }.get()

            let result = ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "printf ok",
                authorization: .currentPolicy(
                    evaluatedSecurity: .full,
                    evaluatedAsk: .off,
                    basis: nil),
                uses: []))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected stale full policy authorization to fail")
                return
            }
        }
    }

    @Test
    func `execution commit rejects ask tightening from off to on miss`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .onMiss
            }.get()

            let result = ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "printf ok",
                authorization: .currentPolicy(
                    evaluatedSecurity: .full,
                    evaluatedAsk: .off,
                    basis: nil),
                uses: []))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected stricter ask policy to reject stale authorization")
                return
            }
        }
    }

    @Test
    func `execution commit rejects explicit approval after concurrent deny`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .off
            }.get()
            let policySnapshot = ExecApprovalPolicySnapshot(
                resolved: ExecApprovalsStore.resolve(agentId: "main"))
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .deny
                entry.ask = .off
            }.get()

            let result = ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "printf ok",
                authorization: .explicitOnce(
                    evaluatedSecurity: .full,
                    policySnapshot: policySnapshot),
                uses: []))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected stale explicit authorization to fail")
                return
            }
        }
    }

    @Test
    func `execution commit rejects auto review after ask changes to always`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .onMiss
            }.get()
            let policySnapshot = ExecApprovalPolicySnapshot(
                resolved: ExecApprovalsStore.resolve(agentId: "main"))
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.ask = .always
            }.get()

            let result = ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "printf ok",
                authorization: .autoReview(
                    evaluatedSecurity: .full,
                    policySnapshot: policySnapshot),
                uses: []))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected stale auto-review authorization to fail")
                return
            }

            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .deny
                entry.ask = .off
            }.get()
            let denied = ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "printf ok",
                authorization: .autoReview(
                    evaluatedSecurity: .full,
                    policySnapshot: policySnapshot),
                uses: []))
            guard case .failure(.unavailable) = denied else {
                Issue.record("expected deny policy to override auto review")
                return
            }
        }
    }

    @Test
    func `forwarded explicit approval cannot restore a rule revoked before Mac evaluation`() async throws {
        try await self.withTempStateDir { _ in
            let stale = ExecAllowlistEntry(
                pattern: "/usr/bin/printf",
                source: "allow-always")
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .always
                entry.allowlist = [stale]
            }.get()
            let forwardedSnapshot = ExecApprovalPolicySnapshot(
                resolved: ExecApprovalsStore.resolve(agentId: "main"))

            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist = []
            }.get()
            let freshContext = await ExecApprovalEvaluator.evaluate(
                command: ["/usr/bin/printf", "ok"],
                rawCommand: nil,
                cwd: nil,
                envOverrides: nil,
                agentId: "main")
            #expect(freshContext.policySnapshot != forwardedSnapshot)

            let commit = ExecApprovalExecutionCommit.build(
                context: freshContext,
                effectiveSecurity: .allowlist,
                approvalSource: nil,
                explicitlyApproved: true,
                persistAllowlist: true,
                delayedPolicySnapshot: forwardedSnapshot)
            if case let .explicitAlways(_, policySnapshot, grants) = commit.authorization {
                #expect(policySnapshot == forwardedSnapshot)
                #expect(grants.map(\.match.pattern) == ["/usr/bin/printf"])
            } else {
                Issue.record("expected forwarded durable approval")
            }

            let result = ExecApprovalsStore.commitExecution(commit)

            guard case .failure(.unavailable) = result else {
                Issue.record("expected revoked forwarded approval to fail")
                return
            }
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.isEmpty)
        }
    }

    @Test
    func `execution commit cannot restore a revoked allow always rule`() async throws {
        try await self.withTempStateDir { _ in
            let stale = ExecAllowlistEntry(pattern: "/usr/bin/printf")
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .always
                entry.allowlist = [stale]
            }.get()
            let evaluated = ExecApprovalsStore.resolve(agentId: "main")
            let policySnapshot = ExecApprovalPolicySnapshot(
                security: evaluated.agent.security,
                ask: evaluated.agent.ask,
                askFallback: evaluated.agent.askFallback,
                autoAllowSkills: evaluated.agent.autoAllowSkills,
                allowlist: evaluated.allowlist)
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.allowlist = []
            }.get()
            let grant = ExecAllowlistUse(
                match: ExecAllowlistEntry(pattern: "/usr/bin/printf", source: "allow-always"),
                resolvedPath: "/usr/bin/printf")

            let result = ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "printf ok",
                authorization: .explicitAlways(
                    evaluatedSecurity: .allowlist,
                    policySnapshot: policySnapshot,
                    grants: [grant]),
                uses: [ExecAllowlistUse(match: stale, resolvedPath: "/usr/bin/printf")]))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected revoked durable grant commit to fail")
                return
            }
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.isEmpty)
        }
    }

    @Test
    func `execution commit atomically persists allow always audit metadata`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
            }.get()
            let evaluated = ExecApprovalsStore.resolve(agentId: "main")
            let policySnapshot = ExecApprovalPolicySnapshot(
                security: evaluated.agent.security,
                ask: evaluated.agent.ask,
                askFallback: evaluated.agent.askFallback,
                autoAllowSkills: evaluated.agent.autoAllowSkills,
                allowlist: evaluated.allowlist)
            let grant = ExecAllowlistUse(
                match: ExecAllowlistEntry(
                    pattern: "/usr/bin/printf",
                    source: "allow-always",
                    argPattern: " ^ok$ "),
                resolvedPath: "/usr/bin/printf")

            _ = try ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                agentId: "main",
                command: "printf ok",
                authorization: .explicitAlways(
                    evaluatedSecurity: .allowlist,
                    policySnapshot: policySnapshot,
                    grants: [grant]),
                uses: [])).get()

            let entry = try #require(ExecApprovalsStore.resolve(agentId: "main").allowlist.first)
            #expect(entry.pattern == "/usr/bin/printf")
            #expect(entry.source == "allow-always")
            #expect(entry.argPattern == " ^ok$ ")
            #expect(entry.lastUsedAt != nil)
            #expect(entry.lastUsedCommand == "printf ok")
            #expect(entry.lastResolvedPath == "/usr/bin/printf")
        }
    }

    @Test
    func `stale concurrent allow always snapshots preserve additive grants and upgrades`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "researcher") { entry in
                entry.security = .allowlist
                entry.ask = .always
                entry.allowlist = [ExecAllowlistEntry(pattern: "/usr/bin/grep")]
            }.get()
            let evaluated = ExecApprovalsStore.resolve(agentId: "researcher")
            let policySnapshot = ExecApprovalPolicySnapshot(
                security: evaluated.agent.security,
                ask: evaluated.agent.ask,
                askFallback: evaluated.agent.askFallback,
                autoAllowSkills: evaluated.agent.autoAllowSkills,
                allowlist: evaluated.allowlist)
            let commitGrant: (String) throws -> Void = { pattern in
                let grant = ExecAllowlistUse(
                    match: ExecAllowlistEntry(pattern: pattern, source: "allow-always"),
                    resolvedPath: pattern)
                _ = try ExecApprovalsStore.commitExecution(ExecApprovalExecutionCommit(
                    agentId: "researcher",
                    command: "\(pattern) --version",
                    authorization: .explicitAlways(
                        evaluatedSecurity: .allowlist,
                        policySnapshot: policySnapshot,
                        grants: [grant]),
                    uses: [])).get()
            }

            try commitGrant("/usr/bin/grep")
            try commitGrant("/usr/bin/cat")

            let allowlist = ExecApprovalsStore.resolve(agentId: "researcher").allowlist
            #expect(Set(allowlist.map(\.pattern)) == ["/usr/bin/grep", "/usr/bin/cat"])
            #expect(allowlist.allSatisfy { $0.source == "allow-always" })
        }
    }

    @Test
    func `usage checkpoint rejects current deny policy`() async throws {
        try await self.withTempStateDir { _ in
            let stale = ExecAllowlistEntry(id: "stale", pattern: "/usr/bin/printf")
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .deny
                entry.ask = .off
                entry.allowlist = [stale]
            }.get()

            let result = ExecApprovalsStore.recordAllowlistUses(
                agentId: "main",
                uses: [ExecAllowlistUse(match: stale, resolvedPath: "/usr/bin/printf")],
                command: "printf ok",
                authorization: .currentPolicy(
                    evaluatedSecurity: .allowlist,
                    evaluatedAsk: .off,
                    basis: .allowlistEntries))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected deny policy checkpoint to fail")
                return
            }
            let entry = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(entry.lastUsedAt == nil)
        }
    }

    @Test
    func `usage checkpoint applies current timeout fallback instead of ask`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
                entry.askFallback = .full
            }.get()

            let result = ExecApprovalsStore.recordAllowlistUses(
                agentId: "main",
                uses: [],
                command: "printf fallback",
                authorization: .askFallback(
                    evaluatedSecurity: .full,
                    basis: nil))

            _ = try result.get()
        }
    }

    @Test
    func `usage checkpoint rejects a revoked timeout fallback`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
                entry.askFallback = .deny
            }.get()

            let result = ExecApprovalsStore.recordAllowlistUses(
                agentId: "main",
                uses: [],
                command: "printf fallback",
                authorization: .askFallback(
                    evaluatedSecurity: .full,
                    basis: nil))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected revoked timeout fallback checkpoint to fail")
                return
            }
        }
    }

    @Test
    func `usage checkpoint rejects fallback mode tightening`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
                entry.askFallback = .allowlist
                entry.allowlist = [ExecAllowlistEntry(pattern: "/usr/bin/printf")]
            }.get()

            let result = ExecApprovalsStore.recordAllowlistUses(
                agentId: "main",
                uses: [],
                command: "printf fallback",
                authorization: .askFallback(
                    evaluatedSecurity: .full,
                    basis: nil))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected tightened timeout fallback checkpoint to fail")
                return
            }
        }
    }
}

extension ExecApprovalsStoreRefactorTests {
    @Test
    func `ensure file migrates legacy pattern from resolved path`() async throws {
        try await self.withTempStateDir { _ in
            try Self.replaceRawJSON(
                #"{"version":1,"agents":{"main":{"allowlist":[{"pattern":"echo","lastResolvedPath":" /usr/bin/echo "}]}}}"#)

            let ensured = ExecApprovalsStore.ensureFile()
            #expect(ensured.agents?["main"]?.allowlist?.map(\.pattern) == ["/usr/bin/echo"])
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.map(\.pattern) == ["/usr/bin/echo"])
        }
    }

    @Test
    func `legacy string entry receives a stable persisted id`() async throws {
        try await self.withTempStateDir { _ in
            try Self.replaceRawJSON(
                #"{"version":1,"agents":{"main":{"allowlist":["/bin/echo"]}}}"#)

            let first = try #require(ExecApprovalsStore.ensureFile().agents?["main"]?.allowlist?.first)
            let second = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)

            #expect(first.id == second.id)
            #expect(first.pattern == "/bin/echo")
            let record = try ExecApprovalsSQLiteStore.read(
                stateDirectoryURL: ExecApprovalsStore.databaseURL()
                    .deletingLastPathComponent()
                    .deletingLastPathComponent())
            let persisted = try #require(record)
            #expect(persisted.rawJSON.contains(first.id))
            #expect(!persisted.rawJSON.contains(#"["/bin/echo"]"#))
        }
    }

    @Test
    func `conditional save cannot restore revoked approvals`() async throws {
        try await self.withTempStateDir { _ in
            Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .allowlist
                entry.allowlist = [ExecAllowlistEntry(pattern: "/bin/echo")]
            }
            let stale = ExecApprovalsStore.readSnapshot()

            Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .deny
                entry.allowlist = []
            }

            let result = ExecApprovalsStore.saveFile(stale.file, ifBaseHash: stale.hash)
            if case .conflict = result {
                // Expected: the revocation changed the hash before the stale save.
            } else {
                Issue.record("expected stale conditional save to conflict")
            }
            let current = ExecApprovalsStore.resolve(agentId: "main")
            #expect(current.agent.security == .deny)
            #expect(current.allowlist.isEmpty)
        }
    }

    @Test
    func `conditional save does not recreate a deleted approval row`() async throws {
        try await self.withTempStateDir { _ in
            _ = try Self.updateAgentFixture(agentId: "main") { entry in
                entry.security = .allowlist
                entry.allowlist = [ExecAllowlistEntry(pattern: "/bin/echo")]
            }.get()
            let stale = ExecApprovalsStore.readSnapshot()
            let databaseURL = ExecApprovalsStore.databaseURL()
            try FileManager().removeItem(at: databaseURL)

            let result = ExecApprovalsStore.saveFile(stale.file, ifBaseHash: stale.hash)

            switch result {
            case .conflict, .baseHashUnavailable:
                break
            default:
                Issue.record("expected deleted approval state to remain absent")
            }
            let stateDirectoryURL = databaseURL
                .deletingLastPathComponent()
                .deletingLastPathComponent()
            #expect(try ExecApprovalsSQLiteStore.read(
                stateDirectoryURL: stateDirectoryURL) == nil)
        }
    }

    private enum FixtureError: Error { case saveRejected }

    @discardableResult
    private static func updateAgentFixture(
        agentId: String,
        mutate: (inout ExecApprovalsAgent) -> Void) -> Result<Void, FixtureError>
    {
        var snapshot = ExecApprovalsStore.readSnapshot()
        var agents = snapshot.file.agents ?? [:]
        var agent = agents[agentId] ?? ExecApprovalsAgent()
        mutate(&agent)
        agents[agentId] = agent
        snapshot.file.agents = agents
        guard case .saved = ExecApprovalsStore.saveFile(snapshot.file, ifBaseHash: snapshot.hash) else {
            return .failure(.saveRejected)
        }
        return .success(())
    }

    private static func updateDefaultsFixture(
        _ mutate: (inout ExecApprovalsDefaults) -> Void) -> Result<Void, FixtureError>
    {
        var snapshot = ExecApprovalsStore.readSnapshot()
        var defaults = snapshot.file.defaults ?? ExecApprovalsDefaults()
        mutate(&defaults)
        snapshot.file.defaults = defaults
        guard case .saved = ExecApprovalsStore.saveFile(snapshot.file, ifBaseHash: snapshot.hash) else {
            return .failure(.saveRejected)
        }
        return .success(())
    }

    private static func seedCurrentApprovalsFile(in stateDir: URL) throws {
        let file = ExecApprovalsFile(
            version: 1,
            socket: ExecApprovalsSocketConfig(
                path: stateDir.appendingPathComponent("exec-approvals.sock").path,
                token: "test-token"),
            defaults: nil,
            agents: [:])
        try ExecApprovalsSQLiteStore.write(file, stateDirectoryURL: stateDir)
    }

    private static func replaceRawJSON(_ rawJSON: String) throws {
        let databaseURL = ExecApprovalsStore.databaseURL()
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
