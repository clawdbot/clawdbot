import CryptoKit
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    private actor ShellRunProbe {
        private var commands: [[String]] = []

        func run(_ command: [String]) -> ShellExecutor.ShellResult {
            self.commands.append(command)
            return ShellExecutor.ShellResult(
                stdout: "ok",
                stderr: "",
                exitCode: 0,
                timedOut: false,
                success: true,
                errorMessage: nil)
        }

        func capturedCommands() -> [[String]] {
            self.commands
        }
    }

    private static func forwardedApprovalPlan(
        command: [String],
        rawCommand: String? = nil,
        agentId: String? = "main",
        policySnapshot: ExecApprovalPolicySnapshot? = nil,
        mutableFileOperand: OpenClawSystemRunApprovalFileOperand? = nil) -> OpenClawSystemRunApprovalPlan
    {
        let snapshot = policySnapshot ?? ExecApprovalPolicySnapshot(
            resolved: ExecApprovalsStore.resolve(agentId: agentId))
        return OpenClawSystemRunApprovalPlan(
            argv: command,
            cwd: nil,
            commandText: ExecCommandFormatter.displayString(for: command),
            commandPreview: rawCommand,
            agentId: agentId,
            sessionKey: nil,
            policySnapshot: snapshot.portable,
            mutableFileOperand: mutableFileOperand)
    }

    private var realTemporaryDirectory: URL {
        let path = FileManager().temporaryDirectory.path
        if path.hasPrefix("/var/") {
            return URL(fileURLWithPath: "/private\(path)", isDirectory: true)
        }
        return FileManager().temporaryDirectory.resolvingSymlinksInPath()
    }

    private func withLockedEnv(
        _ values: [String: String?],
        _ body: () async throws -> Void) async throws
    {
        func restoreEnv(_ values: [String: String?]) {
            for (key, value) in values {
                if let value {
                    setenv(key, value, 1)
                } else {
                    unsetenv(key)
                }
            }
        }

        await TestIsolationLock.shared.acquire()
        var previousEnv: [String: String?] = [:]
        for (key, value) in values {
            previousEnv[key] = getenv(key).map { String(cString: $0) }
            if let value {
                setenv(key, value, 1)
            } else {
                unsetenv(key)
            }
        }

        do {
            try await body()
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
        } catch {
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
            throw error
        }
    }

    private func withTempStateDir(
        _ body: @escaping @Sendable (URL) async throws -> Void) async throws
    {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try Self.seedCurrentApprovalsFile(in: stateDir)

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            try await body(stateDir)
        }
    }

    private func withTempHomeAndStateDir(
        _ body: @escaping @Sendable (URL, URL) async throws -> Void) async throws
    {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-home-state-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            try await body(home, stateDir)
        }
    }

    @Test
    func `ensure file skips rewrite when unchanged`() async throws {
        try await self.withTempStateDir { _ in
            _ = ExecApprovalsStore.ensureFile()
            let url = ExecApprovalsStore.fileURL()
            let firstIdentity = try Self.fileIdentity(at: url)

            _ = ExecApprovalsStore.ensureFile()
            let secondIdentity = try Self.fileIdentity(at: url)

            #expect(firstIdentity == secondIdentity)
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
    func `effective home owns the default approvals path`() async throws {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-effective-home-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = home.appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try Self.seedCurrentApprovalsFile(in: stateDir)

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": nil,
        ]) {
            #expect(ExecApprovalsStore.fileURL().path == stateDir.appendingPathComponent(
                "exec-approvals.json").path)
            #expect(ExecApprovalsStore.socketPath() == stateDir.appendingPathComponent(
                "exec-approvals.sock").path)
            let resolved = try ExecApprovalsStore.resolveResult(agentId: "main").get()
            #expect(resolved.agent.security == .full)
            #expect(resolved.agent.ask == .off)
        }
    }

    @Test
    func `malformed existing file fails closed and rejects mutation`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            let malformed = Data("{".utf8)
            try malformed.write(to: url, options: [.atomic])

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.agent.security == .deny)
            #expect(resolved.agent.ask == .off)
            #expect(resolved.agent.askFallback == .deny)
            #expect(try Data(contentsOf: url) == malformed)

            let result = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
            }
            guard case .failure(.unavailable) = result else {
                Issue.record("expected malformed-file mutation failure")
                return
            }
            #expect(try Data(contentsOf: url) == malformed)

            let snapshot = ExecApprovalsStore.readSnapshot()
            #expect(snapshot.file.defaults?.security == .deny)
            #expect(snapshot.file.defaults?.ask == .off)
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
                let raw = Data(json.utf8)
                let url = ExecApprovalsStore.fileURL()
                try raw.write(to: url, options: [.atomic])

                let resolved = ExecApprovalsStore.resolve(agentId: "main")
                #expect(resolved.agent.security == .deny)
                #expect(resolved.agent.ask == .off)
                #expect(try Data(contentsOf: url) == raw)

                let result = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.security = .full
                }
                guard case .failure(.unavailable) = result else {
                    Issue.record("expected invalid-structure mutation failure")
                    return
                }
                #expect(try Data(contentsOf: url) == raw)
            }
        }
    }

    @Test
    func `string source and arg pattern bytes remain cross-runtime compatible`() async throws {
        try await self.withTempStateDir { _ in
            let raw = Data(
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
                """.utf8)
            try raw.write(to: ExecApprovalsStore.fileURL(), options: [.atomic])

            let resolved = try ExecApprovalsStore.resolveResult(agentId: "main").get()
            let entry = try #require(resolved.allowlist.first)

            #expect(resolved.agent.security == .allowlist)
            #expect(entry.id == "external-entry")
            #expect(entry.pattern == "/usr/bin/printf")
            #expect(entry.source == "external-policy")
            #expect(entry.argPattern == "  ")

            let persisted = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(persisted.source == "external-policy")
            #expect(persisted.argPattern == "  ")
        }
    }

    @Test
    func `native add preserves arg pattern bytes`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/usr/bin/rg",
                argPattern: " ^safe$ ").get()

            let entry = try #require(
                ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(entry.argPattern == " ^safe$ ")
        }
    }

    @Test
    func `blocked legacy migration cannot create or mutate current policy`() async throws {
        try await self.withTempHomeAndStateDir { home, _ in
            let legacyDir = home.appendingPathComponent(".openclaw", isDirectory: true)
            try FileManager().createDirectory(at: legacyDir, withIntermediateDirectories: true)
            let legacyURL = legacyDir.appendingPathComponent("exec-approvals.json")
            let malformed = Data(#"{"version":1,"agents":null}"#.utf8)
            try malformed.write(to: legacyURL)

            let readOnly = ExecApprovalsStore.resolveReadOnly(agentId: "main")
            #expect(readOnly.agent.security == .deny)
            #expect(readOnly.agent.ask == .always)

            let ensured = ExecApprovalsStore.ensureFile()
            #expect(ensured.defaults?.security == .deny)
            #expect(ensured.defaults?.ask == .off)
            #expect(!FileManager().fileExists(atPath: ExecApprovalsStore.fileURL().path))

            let mutation = ExecApprovalsStore.updateDefaults { $0.security = .full }
            guard case .failure(.unavailable) = mutation else {
                Issue.record("expected blocked migration mutation failure")
                return
            }
            #expect(!FileManager().fileExists(atPath: ExecApprovalsStore.fileURL().path))
            #expect(try Data(contentsOf: legacyURL) == malformed)
        }
    }

    @Test
    func `symlinked legacy policy cannot seed the current store`() async throws {
        try await self.withTempHomeAndStateDir { home, _ in
            let legacyDir = home.appendingPathComponent(".openclaw", isDirectory: true)
            try FileManager().createDirectory(at: legacyDir, withIntermediateDirectories: true)
            let linkedTarget = home.appendingPathComponent("linked-policy.json")
            let permissive = Data(#"{"version":1,"defaults":{"security":"full","ask":"off"}}"#.utf8)
            try permissive.write(to: linkedTarget)
            let legacyURL = legacyDir.appendingPathComponent("exec-approvals.json")
            try FileManager().createSymbolicLink(at: legacyURL, withDestinationURL: linkedTarget)

            let ensured = ExecApprovalsStore.ensureFile()

            #expect(ensured.defaults?.security == .deny)
            #expect(ensured.defaults?.ask == .off)
            #expect(!FileManager().fileExists(atPath: ExecApprovalsStore.fileURL().path))
            #expect(try Data(contentsOf: linkedTarget) == permissive)
        }
    }

    @Test
    func `symlinked current policy fails closed without altering its target`() async throws {
        try await self.withTempStateDir { stateDir in
            let url = ExecApprovalsStore.fileURL()
            let target = stateDir.appendingPathComponent("linked-policy.json")
            let permissive = Data(#"{"version":1,"defaults":{"security":"full","ask":"off"}}"#.utf8)
            try permissive.write(to: target)
            try FileManager().removeItem(at: url)
            try FileManager().createSymbolicLink(at: url, withDestinationURL: target)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.agent.security == .deny)
            #expect(resolved.agent.ask == .off)

            let mutation = ExecApprovalsStore.updateDefaults { $0.security = .allowlist }
            guard case .failure(.unavailable) = mutation else {
                Issue.record("expected symlink mutation failure")
                return
            }
            #expect(try Data(contentsOf: target) == permissive)
            #expect(try FileManager().destinationOfSymbolicLink(atPath: url.path) == target.path)
        }
    }

    @Test
    func `symlinked approvals directory fails closed before load or update`() async throws {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-symlink-parent-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let redirected = root.appendingPathComponent("redirected", isDirectory: true)
        let linkedState = home.appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: redirected, withIntermediateDirectories: true)
        try FileManager().createSymbolicLink(at: linkedState, withDestinationURL: redirected)
        let target = redirected.appendingPathComponent("exec-approvals.json")
        let permissive = Data(#"{"version":1,"defaults":{"security":"full","ask":"off"}}"#.utf8)
        try permissive.write(to: target)

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": linkedState.path,
        ]) {
            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.agent.security == .deny)
            #expect(resolved.agent.ask == .off)
            guard case .failure(.unavailable) = ExecApprovalsStore.updateDefaults({
                $0.security = .allowlist
            }) else {
                Issue.record("expected symlink-parent mutation failure")
                return
            }
            let persisted = try Data(contentsOf: target)
            #expect(persisted == permissive)
            #expect(!FileManager().fileExists(atPath: redirected.appendingPathComponent(
                "exec-approvals.json.lock").path))
        }
    }

    @Test
    func `symlinked configured state directory outside home fails closed`() async throws {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-symlink-external-state-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let redirected = root.appendingPathComponent("redirected", isDirectory: true)
        let linkedState = root.appendingPathComponent("linked-state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: redirected, withIntermediateDirectories: true)
        try FileManager().createSymbolicLink(at: linkedState, withDestinationURL: redirected)
        let target = redirected.appendingPathComponent("exec-approvals.json")
        let permissive = Data(#"{"version":1,"defaults":{"security":"full","ask":"off"}}"#.utf8)
        try permissive.write(to: target)

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": linkedState.path,
        ]) {
            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.agent.security == .deny)
            #expect(resolved.agent.ask == .off)
            guard case .failure(.unavailable) = ExecApprovalsStore.resolveResult(agentId: "main") else {
                Issue.record("expected configured symlink state directory read failure")
                return
            }
            guard case .failure(.unavailable) = ExecApprovalsStore.updateDefaults({
                $0.security = .allowlist
            }) else {
                Issue.record("expected configured symlink state directory mutation failure")
                return
            }
            let persisted = try Data(contentsOf: target)
            #expect(persisted == permissive)
            #expect(!FileManager().fileExists(atPath: redirected.appendingPathComponent(
                "exec-approvals.json.lock").path))
        }
    }

    @Test
    func `symlinked trusted home root remains supported`() async throws {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-symlink-root-\(UUID().uuidString)", isDirectory: true)
        let realHome = root.appendingPathComponent("real-home", isDirectory: true)
        let linkedHome = root.appendingPathComponent("linked-home", isDirectory: true)
        let stateDir = linkedHome.appendingPathComponent(".openclaw", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: realHome, withIntermediateDirectories: true)
        try Self.seedCurrentApprovalsFile(in: realHome.appendingPathComponent(".openclaw"))
        try FileManager().createSymbolicLink(at: linkedHome, withDestinationURL: realHome)

        try await self.withLockedEnv([
            "OPENCLAW_HOME": linkedHome.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            let resolved = try ExecApprovalsStore.resolveResult(agentId: "main").get()
            #expect(resolved.agent.security == .full)
            #expect(resolved.agent.ask == .off)
            #expect(FileManager().fileExists(atPath: realHome.appendingPathComponent(
                ".openclaw/exec-approvals.json").path))
        }
    }

    @Test
    func `non-file current policy fails closed and rejects mutation`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            try FileManager().removeItem(at: url)
            try FileManager().createDirectory(at: url, withIntermediateDirectories: false)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.agent.security == .deny)
            #expect(resolved.agent.ask == .off)
            guard case .failure(.unavailable) = ExecApprovalsStore.updateDefaults({
                $0.security = .full
            }) else {
                Issue.record("expected non-file mutation failure")
                return
            }
            var isDirectory = ObjCBool(false)
            #expect(FileManager().fileExists(atPath: url.path, isDirectory: &isDirectory))
            #expect(isDirectory.boolValue)
        }
    }

    @Test
    func `ensure breaks a shared hard link without altering its peer`() async throws {
        try await self.withTempStateDir { stateDir in
            let url = ExecApprovalsStore.fileURL()
            let peer = stateDir.appendingPathComponent("linked-peer.json")
            try FileManager().linkItem(at: url, to: peer)
            let peerBefore = try Data(contentsOf: peer)

            _ = ExecApprovalsStore.ensureFile()

            #expect(try Data(contentsOf: peer) == peerBefore)
            let targetLinks = try FileManager().attributesOfItem(atPath: url.path)[.referenceCount] as? NSNumber
            let peerLinks = try FileManager().attributesOfItem(atPath: peer.path)[.referenceCount] as? NSNumber
            #expect(targetLinks?.intValue == 1)
            #expect(peerLinks?.intValue == 1)
        }
    }

    @Test
    func `missing and present empty snapshots have distinct hashes`() async throws {
        try await self.withTempHomeAndStateDir { _, stateDir in
            let missing = ExecApprovalsStore.readSnapshot()
            #expect(!missing.exists)
            #expect(missing.hash.hasPrefix("missing:"))

            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            try Data().write(to: ExecApprovalsStore.fileURL())
            let empty = ExecApprovalsStore.readSnapshot()

            #expect(empty.exists)
            #expect(!empty.hash.hasPrefix("missing:"))
            #expect(empty.hash != missing.hash)
        }
    }

    @Test
    func `missing file with held sidecar lock fails closed`() async throws {
        try await self.withTempHomeAndStateDir { _, stateDir in
            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            let lockURL = stateDir.appendingPathComponent("exec-approvals.json.lock")
            try Data("held".utf8).write(to: lockURL)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")

            #expect(resolved.agent.security == .deny)
            #expect(resolved.agent.ask == .off)
            #expect(!FileManager().fileExists(atPath: ExecApprovalsStore.fileURL().path))
            #expect(FileManager().fileExists(atPath: lockURL.path))
        }
    }

    @Test
    func `valid permissive file with held sidecar lock fails closed`() async throws {
        try await self.withTempStateDir { stateDir in
            _ = try ExecApprovalsStore.updateDefaults { defaults in
                defaults.security = .full
                defaults.ask = .off
            }.get()
            let lockURL = stateDir.appendingPathComponent("exec-approvals.json.lock")
            try Data("held".utf8).write(to: lockURL)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")

            #expect(resolved.agent.security == .deny)
            #expect(resolved.agent.ask == .off)
        }
    }

    @Test
    func `native approvals get reports held sidecar lock as unavailable`() async throws {
        try await self.withTempStateDir { stateDir in
            let lockURL = stateDir.appendingPathComponent("exec-approvals.json.lock")
            try Data("held".utf8).write(to: lockURL)

            let response = await MacNodeRuntime().handleInvoke(BridgeInvokeRequest(
                id: "approvals-get-held-lock",
                command: OpenClawSystemCommand.execApprovalsGet.rawValue))

            #expect(!response.ok)
            #expect(response.error?.code == .unavailable)
            #expect(response.error?.message == "UNAVAILABLE: exec approvals store unavailable; retry")
            #expect(FileManager().fileExists(atPath: lockURL.path))
        }
    }

    @Test
    func `native approvals get reports malformed store as unavailable`() async throws {
        try await self.withTempStateDir { _ in
            let url = ExecApprovalsStore.fileURL()
            let malformed = Data("{".utf8)
            try malformed.write(to: url, options: [.atomic])

            let response = await MacNodeRuntime().handleInvoke(BridgeInvokeRequest(
                id: "approvals-get-malformed",
                command: OpenClawSystemCommand.execApprovalsGet.rawValue))

            #expect(!response.ok)
            #expect(response.error?.code == .unavailable)
            #expect(response.error?.message == "UNAVAILABLE: exec approvals store unavailable; retry")
            #expect(try Data(contentsOf: url) == malformed)
        }
    }

    @Test
    func `allow always atomic commit failure denies without persisting or executing`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(
                commitExecution: { _ in .failure(.unavailable) })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalDecision: "allow-always")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "persist-failure",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.isEmpty)
        }
    }

    @Test
    func `allowlist usage failure denies before shell execution`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.allowlist = [ExecAllowlistEntry(pattern: "/usr/bin/printf")]
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(
                commitExecution: { _ in .failure(.unavailable) })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(command: ["/usr/bin/printf", "ok"], agentId: "main")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "usage-failure",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `native runtime revalidates unprompted full policy before shell execution`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .off
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.security = .deny
                }
                return ExecApprovalsStore.commitExecution(commit)
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "full-policy-race",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `native runtime rejects ask tightening before shell execution`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .off
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.ask = .onMiss
                }
                return ExecApprovalsStore.commitExecution(commit)
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "ask-policy-race",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `native runtime rejects explicit once when security tightens to allowlist`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.security = .allowlist
                }
                return ExecApprovalsStore.commitExecution(commit)
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalDecision: "allow-once")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "explicit-once-security-race",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `native runtime rejects explicit once after allowlist revocation`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
                entry.allowlist = [ExecAllowlistEntry(pattern: "/usr/bin/echo")]
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.allowlist = []
                }
                return ExecApprovalsStore.commitExecution(commit)
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalDecision: "allow-once")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "explicit-once-allowlist-race",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `native runtime rejects auto review when security tightens to allowlist`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .onMiss
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.security = .allowlist
                }
                return ExecApprovalsStore.commitExecution(commit)
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalSource: "auto-review")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "auto-review-security-race",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `native runtime rejects auto review when ask tightens from off to on miss`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .off
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.ask = .onMiss
                }
                return ExecApprovalsStore.commitExecution(commit)
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalSource: "auto-review")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "auto-review-ask-tightening",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `native runtime treats a successful commit as the authorization linearization point`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .off
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                let result = ExecApprovalsStore.commitExecution(commit)
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.security = .deny
                }
                return result
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let command = ["/usr/bin/printf", "ok"]
            let params = OpenClawSystemRunParams(command: command, agentId: "main")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "authorization-linearization",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(response.ok)
            #expect(await probe.capturedCommands() == [command])
            #expect(ExecApprovalsStore.resolve(agentId: "main").agent.security == .deny)
        }
    }

    @Test
    func `native runtime requires the prepared snapshot for forwarded delayed authority`() async throws {
        try await self.withTempStateDir { _ in
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let command = ["/usr/bin/printf", "ok"]
            let planWithoutSnapshot = OpenClawSystemRunApprovalPlan(
                argv: command,
                cwd: nil,
                commandText: ExecCommandFormatter.displayString(for: command),
                agentId: "main",
                sessionKey: nil)
            let cases = [
                OpenClawSystemRunParams(
                    command: command,
                    agentId: "main",
                    systemRunPlan: planWithoutSnapshot,
                    approvalDecision: "allow-once"),
                OpenClawSystemRunParams(
                    command: command,
                    agentId: "main",
                    systemRunPlan: planWithoutSnapshot,
                    approvalSource: "auto-review"),
                OpenClawSystemRunParams(
                    command: command,
                    agentId: "main",
                    systemRunPlan: planWithoutSnapshot,
                    approved: true),
            ]

            for (index, params) in cases.enumerated() {
                let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
                let response = await runtime.handleInvoke(BridgeInvokeRequest(
                    id: "missing-delayed-snapshot-\(index)",
                    command: OpenClawSystemCommand.run.rawValue,
                    paramsJSON: json))

                #expect(!response.ok)
                #expect(response.error?.code == .invalidRequest)
                #expect(response.error?.message.contains("prepared policy snapshot") == true)
            }
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `native runtime rejects forwarded delayed authority for a mismatched plan`() async throws {
        try await self.withTempStateDir { _ in
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let command = ["/usr/bin/printf", "ok"]
            let params = OpenClawSystemRunParams(
                command: command,
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "different"]),
                approvalDecision: "allow-once")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "mismatched-forwarded-plan",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.code == .invalidRequest)
            #expect(response.error?.message.contains("matching systemRunPlan") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `forwarded node session approval cannot restore a rule revoked before Mac evaluation`() async throws {
        try await self.withTempStateDir { _ in
            let stale = ExecAllowlistEntry(
                pattern: "/usr/bin/echo",
                source: "allow-always")
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
                entry.allowlist = [stale]
            }.get()
            let forwardedSnapshot = ExecApprovalPolicySnapshot(
                resolved: ExecApprovalsStore.resolve(agentId: "main"))
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.allowlist = []
            }.get()

            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let command = ["/usr/bin/printf", "ok"]
            let params = OpenClawSystemRunParams(
                command: command,
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(
                    command: command,
                    policySnapshot: forwardedSnapshot),
                approvalDecision: "allow-always")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "revoked-node-session-approval",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.isEmpty)
        }
    }

    @Test
    func `forwarded node session approval rejects a changed mutable script operand`() async throws {
        try await self.withTempStateDir { stateDir in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .off
            }.get()
            let scriptURL = stateDir.appendingPathComponent("script.py")
            let approvedData = Data("print('approved')\n".utf8)
            try approvedData.write(to: scriptURL)
            let approvedHash = SHA256.hash(data: approvedData)
                .map { String(format: "%02x", $0) }
                .joined()
            let command = ["/usr/bin/python3", scriptURL.path]
            let operand = OpenClawSystemRunApprovalFileOperand(
                argvIndex: 1,
                path: scriptURL.resolvingSymlinksInPath().path,
                sha256: approvedHash)
            try Data("print('changed')\n".utf8).write(to: scriptURL)

            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: command,
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(
                    command: command,
                    mutableFileOperand: operand),
                approvalDecision: "allow-once")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "changed-script-operand",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("script operand changed") == true)
            #expect(await probe.capturedCommands().isEmpty)

            try approvedData.write(to: scriptURL)
            let restoredResponse = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "restored-script-operand",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))
            #expect(restoredResponse.ok)
            #expect(await probe.capturedCommands() == [command])
        }
    }

    @Test
    func `native runtime cannot persist allow always after concurrent policy revocation`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.security = .deny
                }
                return ExecApprovalsStore.commitExecution(commit)
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalDecision: "allow-always")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "allow-always-policy-race",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(await probe.capturedCommands().isEmpty)
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.isEmpty)
        }
    }

    @Test
    func `revoked gateway timeout fallback denies before native shell execution`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
                entry.askFallback = .deny
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalSource: "ask-fallback")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "revoked-timeout-fallback",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message == "SYSTEM_RUN_DISABLED: security=deny")
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `marker only full timeout fallback executes without a second prompt`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
                entry.askFallback = .full
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let command = ["/usr/bin/printf", "ok"]
            let params = OpenClawSystemRunParams(
                command: command,
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: command),
                approvalSource: "ask-fallback")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "full-timeout-fallback",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(response.ok)
            #expect(await probe.capturedCommands() == [command])
        }
    }

    @Test
    func `timeout fallback rejects explicit approval fields`() async throws {
        try await self.withTempStateDir { _ in
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                approvalDecision: "allow-once",
                approvalSource: "ask-fallback")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "mixed-timeout-fallback",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("cannot be combined") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `auto review marker executes one shot allowlist miss`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let command = ["/usr/bin/printf", "ok"]
            let params = OpenClawSystemRunParams(
                command: command,
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: command),
                approvalSource: "auto-review")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "auto-review-once",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(response.ok)
            #expect(await probe.capturedCommands() == [command])
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.isEmpty)
        }
    }

    @Test
    func `auto review marker cannot bypass ask always`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalSource: "auto-review")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "auto-review-ask-always",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("ask=always") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `auto review revalidates concurrent ask always before shell execution`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
            }.get()
            let probe = ShellRunProbe()
            let mutations = ExecApprovalStoreMutations(commitExecution: { commit in
                _ = ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                    entry.ask = .always
                }
                return ExecApprovalsStore.commitExecution(commit)
            })
            let runtime = MacNodeRuntime(
                execApprovalStoreMutations: mutations,
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/usr/bin/printf", "ok"]),
                approvalSource: "auto-review")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "auto-review-ask-race",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("exec approvals update unavailable") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `auto review marker preserves reviewed strict inline execution`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let payload = "/usr/bin/printf reviewed"
            let command = ["/bin/sh", "-c", payload]
            let params = OpenClawSystemRunParams(
                command: command,
                rawCommand: payload,
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: command, rawCommand: payload),
                approvalSource: "auto-review")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "auto-review-inline",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(response.ok)
            #expect(await probe.capturedCommands() == [command])
        }
    }

    @Test
    func `auto review marker rejects legacy approval fields`() async throws {
        try await self.withTempStateDir { _ in
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/usr/bin/printf", "ok"],
                agentId: "main",
                approved: true,
                approvalSource: "auto-review")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "mixed-auto-review",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("cannot be combined") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `allowlist timeout fallback executes the canonical bound command`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
                entry.askFallback = .allowlist
                entry.allowlist = [ExecAllowlistEntry(pattern: "/usr/bin/printf")]
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["printf", "ok"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["printf", "ok"]),
                approvalSource: "ask-fallback")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "allowlist-timeout-fallback",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(response.ok)
            #expect(await probe.capturedCommands() == [["/usr/bin/printf", "ok"]])
        }
    }

    @Test
    func `allowlist timeout fallback miss denies without shell execution`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .always
                entry.askFallback = .allowlist
                entry.allowlist = [ExecAllowlistEntry(pattern: "/usr/bin/printf")]
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let params = OpenClawSystemRunParams(
                command: ["/bin/echo", "miss"],
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: ["/bin/echo", "miss"]),
                approvalSource: "ask-fallback")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "allowlist-timeout-fallback-miss",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(!response.ok)
            #expect(response.error?.message.contains("allowlist miss") == true)
            #expect(await probe.capturedCommands().isEmpty)
        }
    }

    @Test
    func `explicit allow once executes original unbound shell command`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
                entry.allowlist = [ExecAllowlistEntry(pattern: "/usr/bin/printf")]
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let payload = "/usr/bin/printf one && /usr/bin/printf two"
            let original = ["/bin/sh", "-c", payload]
            let params = OpenClawSystemRunParams(
                command: original,
                rawCommand: payload,
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: original, rawCommand: payload),
                approvalDecision: "allow-once")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "allow-once",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(response.ok)
            #expect(await probe.capturedCommands() == [original])
        }
    }

    @Test
    func `allow always executes unbound shell command once without persisting inner grants`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .onMiss
            }.get()
            let probe = ShellRunProbe()
            let runtime = MacNodeRuntime(
                shellRunner: { command, _, _, _ in await probe.run(command) })
            let payload = "/usr/bin/printf one && /usr/bin/printf two"
            let original = ["/bin/sh", "-c", payload]
            let params = OpenClawSystemRunParams(
                command: original,
                rawCommand: payload,
                agentId: "main",
                systemRunPlan: Self.forwardedApprovalPlan(command: original, rawCommand: payload),
                approvalDecision: "allow-always")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "allow-always-unbound",
                command: OpenClawSystemCommand.run.rawValue,
                paramsJSON: json))

            #expect(response.ok)
            #expect(await probe.capturedCommands() == [original])
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.isEmpty)
        }
    }

    @Test
    func `native rewrites preserve non-sensitive metadata and arbitrary ids`() async throws {
        try await self.withTempStateDir { _ in
            let raw = Data(
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
                """.utf8)
            try raw.write(to: ExecApprovalsStore.fileURL(), options: [.atomic])

            _ = ExecApprovalsStore.ensureFile()
            let entry = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)
            #expect(entry.id == "ts:approval/id")
            #expect(entry.pattern == "/usr/bin/python3")
            #expect(entry.source == "allow-always")
            #expect(entry.commandText == nil)
            #expect(entry.argPattern == #"^safe\.py$"#)

            _ = try ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/bin/echo",
                commandText: "echo secret-token").get()
            let entries = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist)
            #expect(entries.allSatisfy { $0.commandText == nil })
            let persisted = try String(contentsOf: ExecApprovalsStore.fileURL(), encoding: .utf8)
            #expect(!persisted.contains("commandText"))
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
            _ = try ExecApprovalsStore.addAllowlistEntries(
                agentId: "main",
                entries: [first, second]).get()

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
    func `usage checkpoint rejects a revoked reusable approval`() async throws {
        try await self.withTempStateDir { _ in
            let stale = ExecAllowlistEntry(id: "stale", pattern: "/usr/bin/printf")
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.allowlist = [stale]
            }.get()
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.allowlist = [stale]
            }.get()
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.allowlist = [stale]
            }.get()
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .off
            }.get()
            let policySnapshot = ExecApprovalPolicySnapshot(
                resolved: ExecApprovalsStore.resolve(agentId: "main"))
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .full
                entry.ask = .onMiss
            }.get()
            let policySnapshot = ExecApprovalPolicySnapshot(
                resolved: ExecApprovalsStore.resolve(agentId: "main"))
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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

            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .always
                entry.allowlist = [stale]
            }.get()
            let forwardedSnapshot = ExecApprovalPolicySnapshot(
                resolved: ExecApprovalsStore.resolve(agentId: "main"))

            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "researcher") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
    func `usage checkpoint rejects skill trust after auto allow is removed`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.autoAllowSkills = true
            }.get()
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.autoAllowSkills = nil
            }.get()

            let result = ExecApprovalsStore.recordAllowlistUses(
                agentId: "main",
                uses: [],
                command: "skill-tool",
                authorization: .currentPolicy(
                    evaluatedSecurity: .allowlist,
                    evaluatedAsk: .off,
                    basis: .autoAllowedSkill))

            guard case .failure(.unavailable) = result else {
                Issue.record("expected revoked skill trust checkpoint to fail")
                return
            }
        }
    }

    @Test
    func `usage checkpoint applies current timeout fallback instead of ask`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
    func `ensure file migrates default approvals into custom state dir`() async throws {
        try await self.withTempHomeAndStateDir { home, stateDir in
            let legacyDir = home.appendingPathComponent(".openclaw", isDirectory: true)
            try FileManager().createDirectory(
                at: legacyDir,
                withIntermediateDirectories: true)
            let legacySocket = legacyDir.appendingPathComponent("exec-approvals.sock").path
            let legacyFile = legacyDir.appendingPathComponent("exec-approvals.json")
            let legacyJson = """
            {
              "version": 1,
              "socket": {
                "path": "\(legacySocket)",
                "token": "legacy-token"
              },
              "defaults": {
                "security": "deny",
                "ask": "always"
              },
              "agents": {
                "main": {
                  "allowlist": [{ "pattern": "git status" }]
                }
              }
            }
            """
            try Data(legacyJson.utf8).write(to: legacyFile)

            let file = ExecApprovalsStore.ensureFile()
            let targetURL = ExecApprovalsStore.fileURL()

            let expectedFileURL = stateDir
                .appendingPathComponent("exec-approvals.json")
                .standardizedFileURL
            #expect(targetURL.path == expectedFileURL.path)
            #expect(FileManager().fileExists(atPath: targetURL.path))
            #expect(file.socket?.path == ExecApprovalsStore.socketPath())
            #expect(file.socket?.token == "legacy-token")
            #expect(file.defaults?.security == .deny)
            #expect(file.defaults?.ask == .always)
            #expect(file.agents?["main"]?.allowlist?.map(\.pattern) == ["git status"])
            #expect(!FileManager().fileExists(atPath: legacyFile.path))
            #expect(FileManager().fileExists(atPath: "\(legacyFile.path).migrated"))
        }
    }

    @Test
    func `legacy writer revocation wins before migration publishes and archives`() async throws {
        try await self.withTempHomeAndStateDir { home, _ in
            let legacyDir = home.appendingPathComponent(".openclaw", isDirectory: true)
            try FileManager().createDirectory(
                at: legacyDir,
                withIntermediateDirectories: true)
            let legacyFile = legacyDir.appendingPathComponent("exec-approvals.json")
            let legacyLock = legacyDir.appendingPathComponent("exec-approvals.json.lock")
            let initial = Data(
                #"{"version":1,"agents":{"main":{"allowlist":[{"id":"revoked-entry","pattern":"/usr/bin/echo"}]}}}"#
                    .utf8)
            let revoked = Data(
                #"{"version":1,"agents":{"main":{"allowlist":[]}}}"#.utf8)
            try initial.write(to: legacyFile)
            try Data("legacy writer owns lock".utf8).write(to: legacyLock)

            // An older writer revokes under its sidecar lock. Migration must
            // wait, then read and archive only the post-revocation policy.
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(100)) {
                try? revoked.write(to: legacyFile, options: [.atomic])
                try? FileManager().removeItem(at: legacyLock)
            }

            let migrated = ExecApprovalsStore.ensureFile()

            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.isEmpty)
            #expect(migrated.agents?["main"]?.allowlist?.isEmpty != false)
            #expect(!FileManager().fileExists(atPath: legacyFile.path))
            let archived = URL(fileURLWithPath: "\(legacyFile.path).migrated")
            #expect(FileManager().fileExists(atPath: archived.path))
            let archivedFile = try JSONDecoder().decode(
                ExecApprovalsFile.self,
                from: Data(contentsOf: archived))
            #expect(archivedFile.agents?["main"]?.allowlist?.isEmpty == true)
        }
    }

    @Test
    func `legacy migration fails closed while legacy writer lock is held`() async throws {
        try await self.withTempHomeAndStateDir { home, _ in
            let legacyDir = home.appendingPathComponent(".openclaw", isDirectory: true)
            try FileManager().createDirectory(
                at: legacyDir,
                withIntermediateDirectories: true)
            let legacyFile = legacyDir.appendingPathComponent("exec-approvals.json")
            let legacyLock = legacyDir.appendingPathComponent("exec-approvals.json.lock")
            let permissive = Data(
                #"{"version":1,"defaults":{"security":"full","ask":"off"}}"#.utf8)
            try permissive.write(to: legacyFile)
            try Data("legacy writer owns lock".utf8).write(to: legacyLock)

            let ensured = ExecApprovalsStore.ensureFile()

            #expect(ensured.defaults?.security == .deny)
            #expect(ensured.defaults?.ask == .off)
            #expect(!FileManager().fileExists(atPath: ExecApprovalsStore.fileURL().path))
            #expect(try Data(contentsOf: legacyFile) == permissive)
            #expect(FileManager().fileExists(atPath: legacyLock.path))
        }
    }

    @Test
    func `add allowlist entries accepts basename pattern`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.addAllowlistEntries(
                agentId: "main",
                entries: [
                    ExecAllowlistEntry(pattern: "echo"),
                    ExecAllowlistEntry(pattern: "/bin/echo"),
                ]).get()

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["echo", "/bin/echo"])
        }
    }

    @Test
    func `ensure file migrates legacy pattern from resolved path`() async throws {
        try await self.withTempStateDir { _ in
            let raw = Data(
                #"{"version":1,"agents":{"main":{"allowlist":[{"pattern":"echo","lastResolvedPath":" /usr/bin/echo "}]}}}"#
                    .utf8)
            try raw.write(to: ExecApprovalsStore.fileURL(), options: [.atomic])

            let ensured = ExecApprovalsStore.ensureFile()
            #expect(ensured.agents?["main"]?.allowlist?.map(\.pattern) == ["/usr/bin/echo"])
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.map(\.pattern) == ["/usr/bin/echo"])
        }
    }

    @Test
    func `native writes wait for the shared sidecar lock`() async throws {
        try await self.withTempStateDir { stateDir in
            let lockURL = stateDir.appendingPathComponent("exec-approvals.json.lock")
            let payload = try JSONSerialization.data(withJSONObject: [
                "pid": Int(getpid()),
                "createdAt": ISO8601DateFormatter().string(from: Date()),
            ])
            try payload.write(to: lockURL)
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(100)) {
                try? FileManager().removeItem(at: lockURL)
            }

            let startedAt = Date()
            _ = try ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/bin/echo").get()

            #expect(Date().timeIntervalSince(startedAt) >= 0.075)
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.map(\.pattern) == ["/bin/echo"])
        }
    }

    @Test
    func `native writer keeps lock from reused pid`() async throws {
        try await self.withTempStateDir { stateDir in
            let lockURL = stateDir.appendingPathComponent("exec-approvals.json.lock")
            let payload = try JSONSerialization.data(withJSONObject: [
                "pid": Int(getpid()),
                "createdAt": ISO8601DateFormatter().string(from: Date()),
                "starttime": 0,
            ])
            try payload.write(to: lockURL)

            _ = ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/bin/echo")

            #expect(FileManager().fileExists(atPath: lockURL.path))
            #expect(try Data(contentsOf: lockURL) == payload)
            #expect(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.isEmpty != false)
        }
    }

    @Test
    func `native writer keeps expired malformed lock`() async throws {
        try await self.withTempStateDir { stateDir in
            let lockURL = stateDir.appendingPathComponent("exec-approvals.json.lock")
            try Data("{".utf8).write(to: lockURL)
            try FileManager().setAttributes(
                [.modificationDate: Date().addingTimeInterval(-31)],
                ofItemAtPath: lockURL.path)

            let startedAt = Date()
            let result = ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/bin/echo")
            let elapsed = Date().timeIntervalSince(startedAt)

            guard case .failure(.unavailable) = result else {
                Issue.record("expected lock contention failure")
                return
            }
            #expect(FileManager().fileExists(atPath: lockURL.path))
            #expect(try Data(contentsOf: lockURL) == Data("{".utf8))
            #expect(elapsed < 0.5)
            #expect(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.isEmpty != false)
        }
    }

    @Test
    func `entry scoped update persists a legacy missing id before editing`() async throws {
        try await self.withTempStateDir { _ in
            let raw = Data(
                """
                {"version":1,"agents":{"main":{"allowlist":[{"pattern":"/bin/echo"}]}}}
                """.utf8)
            try raw.write(to: ExecApprovalsStore.fileURL(), options: [.atomic])

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            guard let id = resolved.allowlist.first?.id else {
                Issue.record("expected legacy allowlist entry")
                return
            }
            let result = ExecApprovalsStore.updateAllowlistEntry(
                agentId: "main",
                id: id,
                pattern: "/bin/cat")

            if case let .failure(error) = result {
                Issue.record("unexpected update failure: \(error)")
            }
            let persisted = ExecApprovalsStore.loadFile().agents?["main"]?.allowlist
            #expect(persisted?.map(\.id) == [id])
            #expect(persisted?.map(\.pattern) == ["/bin/cat"])
        }
    }

    @Test
    func `legacy string entry receives a stable persisted id`() async throws {
        try await self.withTempStateDir { _ in
            let raw = Data(#"{"version":1,"agents":{"main":{"allowlist":["/bin/echo"]}}}"#.utf8)
            try raw.write(to: ExecApprovalsStore.fileURL(), options: [.atomic])

            let first = try #require(ExecApprovalsStore.ensureFile().agents?["main"]?.allowlist?.first)
            let second = try #require(ExecApprovalsStore.loadFile().agents?["main"]?.allowlist?.first)

            #expect(first.id == second.id)
            #expect(first.pattern == "/bin/echo")
            let persisted = try String(contentsOf: ExecApprovalsStore.fileURL(), encoding: .utf8)
            #expect(persisted.contains(first.id))
            #expect(!persisted.contains(#"["/bin/echo"]"#))
        }
    }

    @Test
    func `entry scoped update cannot restore a revoked allowlist snapshot`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/bin/echo").get()
            let revokedID = try #require(ExecApprovalsStore.resolve(agentId: "main").allowlist.first?.id)

            _ = try ExecApprovalsStore.removeAllowlistEntry(
                agentId: "main",
                id: revokedID).get()
            _ = try ExecApprovalsStore.addAllowlistEntry(
                agentId: "main",
                pattern: "/usr/bin/date").get()
            let result = ExecApprovalsStore.updateAllowlistEntry(
                agentId: "main",
                id: revokedID,
                pattern: "/bin/cat")

            if case let .failure(error) = result {
                Issue.record("unexpected update failure: \(error)")
            }
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.map(\.pattern) == ["/usr/bin/date"])
        }
    }

    @Test
    func `entry scoped mutations reject inherited wildcard entries`() async throws {
        try await self.withTempStateDir { _ in
            let inherited = ExecAllowlistEntry(id: "wildcard-entry", pattern: "/bin/echo")
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "*") { entry in
                entry.allowlist = [inherited]
            }.get()
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.map(\.id) == [inherited.id])

            let update = ExecApprovalsStore.updateAllowlistEntry(
                agentId: "main",
                id: inherited.id,
                pattern: "/bin/cat")
            let removal = ExecApprovalsStore.removeAllowlistEntry(
                agentId: "main",
                id: inherited.id)

            if case .failure(.entryNotOwned) = update {} else {
                Issue.record("expected inherited update to report entryNotOwned")
            }
            if case .failure(.entryNotOwned) = removal {} else {
                Issue.record("expected inherited removal to report entryNotOwned")
            }
            let persisted = ExecApprovalsStore.loadFile().agents?["*"]?.allowlist
            #expect(persisted?.map(\.id) == [inherited.id])
            #expect(persisted?.map(\.pattern) == [inherited.pattern])
        }
    }

    @Test
    func `conditional save cannot restore revoked approvals`() async throws {
        try await self.withTempStateDir { _ in
            ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.allowlist = [ExecAllowlistEntry(pattern: "/bin/echo")]
            }
            let stale = ExecApprovalsStore.readSnapshot()

            ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
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
    func `conditional save does not recreate deleted approval state`() async throws {
        try await self.withTempStateDir { _ in
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.allowlist = [ExecAllowlistEntry(pattern: "/bin/echo")]
            }.get()
            let stale = ExecApprovalsStore.readSnapshot()
            try FileManager().removeItem(at: ExecApprovalsStore.fileURL())

            let result = ExecApprovalsStore.saveFile(stale.file, ifBaseHash: stale.hash)

            switch result {
            case .conflict, .baseHashUnavailable:
                break
            default:
                Issue.record("expected deleted approval state to remain absent")
            }
            #expect(!FileManager().fileExists(atPath: ExecApprovalsStore.fileURL().path))
        }
    }

    @Test
    func `ensure file hardens state directory permissions`() async throws {
        try await self.withTempStateDir { stateDir in
            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: stateDir.path)

            _ = ExecApprovalsStore.ensureFile()
            let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o700)
        }
    }

    private static func fileIdentity(at url: URL) throws -> Int {
        let attributes = try FileManager().attributesOfItem(atPath: url.path)
        guard let identifier = (attributes[.systemFileNumber] as? NSNumber)?.intValue else {
            struct MissingIdentifierError: Error {}
            throw MissingIdentifierError()
        }
        return identifier
    }

    private static func seedCurrentApprovalsFile(in stateDir: URL) throws {
        try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
        let file = ExecApprovalsFile(
            version: 1,
            socket: ExecApprovalsSocketConfig(
                path: stateDir.appendingPathComponent("exec-approvals.sock").path,
                token: "test-token"),
            defaults: nil,
            agents: [:])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(file)
            .write(to: stateDir.appendingPathComponent("exec-approvals.json"))
    }
}
