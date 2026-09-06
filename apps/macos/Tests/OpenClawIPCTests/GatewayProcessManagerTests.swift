import Darwin
import Foundation
import Synchronization
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct GatewayProcessManagerTests {
    /// Recovery integration suites exercise the app singleton concurrently. Each
    /// unit test owns its manager so readiness state cannot leak into their requests.
    private let manager = GatewayProcessManager()

    @Test func `colliding profile ports cannot attach another profile gateway`() {
        let first = AppProfile(environment: ["OPENCLAW_PROFILE": "p1402"])
        let second = AppProfile(environment: ["OPENCLAW_PROFILE": "p2380"])
        #expect(first.defaultGatewayPort == 55636)
        #expect(second.defaultGatewayPort == 55636)
        #expect(GatewayProcessManager.profileAllowsExistingGatewayAttachment(
            profile: first,
            listenerPID: 1402,
            managedServicePID: 1402))
        #expect(!GatewayProcessManager.profileAllowsExistingGatewayAttachment(
            profile: second,
            listenerPID: 1402,
            managedServicePID: 2380))
        #expect(!GatewayProcessManager.profileAllowsExistingGatewayAttachment(
            profile: second,
            listenerPID: 1402,
            managedServicePID: nil))
        #expect(GatewayProcessManager.profileAllowsExistingGatewayAttachment(
            profile: AppProfile(environment: [:]),
            listenerPID: 1402,
            managedServicePID: nil))
    }

    private func availableGatewayPort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        defer { _ = Darwin.close(fd) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                Darwin.bind(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }

        var assigned = sockaddr_in()
        var assignedLength = socklen_t(MemoryLayout<sockaddr_in>.size)
        let resolved = withUnsafeMutablePointer(to: &assigned) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                getsockname(fd, socketAddress, &assignedLength)
            }
        }
        guard resolved == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return Int(UInt16(bigEndian: assigned.sin_port))
    }

    private func withGatewayConfig<T>(
        mode: String,
        port: Int? = nil,
        homeDirectory: URL? = nil,
        _ body: () async throws -> T) async throws -> T
    {
        let isolatedHome = try homeDirectory ?? makeTempDirForTests()
        defer {
            if homeDirectory == nil { try? FileManager.default.removeItem(at: isolatedHome) }
        }
        let configPath = TestIsolation.tempConfigPath()
        let portFragment = port.map { ",\"port\":\($0)" } ?? ""
        let config = #"{"gateway":{"mode":"\#(mode)""# + portFragment + "}}"
        try Data(config.utf8)
            .write(to: URL(fileURLWithPath: configPath))
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        let environment: [String: String?] = [
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_PORT": nil,
            "HOME": isolatedHome.path,
            "CFFIXED_USER_HOME": isolatedHome.path,
        ]
        return try await TestIsolation.withEnvValues(environment) {
            // Service ownership reads must stay inside this fixture's home, even without an explicit plist.
            try #require(FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL == isolatedHome
                .standardizedFileURL)
            return try await body()
        }
    }

    private func withLaunchAgentEnvironment<T>(
        mode: String = "local",
        port: Int? = nil,
        homeDirectory: URL? = nil,
        statusPayload: String? = nil,
        statusPayloads: [String]? = nil,
        commandDelayNanoseconds: UInt64 = 0,
        commandHook: (@Sendable ([String]) async -> Void)? = nil,
        _ body: () async throws -> T) async throws -> T
    {
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-launchagent-marker-\(UUID().uuidString)")
        return try await self.withGatewayConfig(mode: mode, port: port, homeDirectory: homeDirectory) {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true) { arguments in
                if commandDelayNanoseconds > 0 {
                    try? await Task.sleep(nanoseconds: commandDelayNanoseconds)
                }
                await commandHook?(arguments)
            }
            if let statusPayloads {
                GatewayLaunchAgentManager.setTestingDaemonStatusPayloads(statusPayloads)
            } else {
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(statusPayload)
            }
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                self.manager.setTestingDesiredActive(false)
                self.manager._testClearLaunchAgentReadinessFailure()
                self.manager._testClearLaunchAgentInstallEvidence()
            }
            return try await body()
        }
    }

    private func makeGatewayReadinessFixture(
        url: URL,
        taskFactory: @escaping GatewayTestWebSocketSession.TaskFactory)
        -> (session: GatewayTestWebSocketSession, connection: GatewayConnection, manager: GatewayProcessManager)
    {
        let session = GatewayTestWebSocketSession(taskFactory: taskFactory)
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        // Keep fixture dependencies private for the manager's whole lifetime;
        // late probe cleanup must not fall back to shared app services.
        let manager = GatewayProcessManager()
        manager.setTestingConnection(connection)
        manager.setTestingSkipControlChannelRefresh(true)
        return (session, connection, manager)
    }

    private func gatewayDescriptor(
        pid: Int32,
        command: String = "openclaw-gateway",
        executablePath: String = "/tmp/openclaw-gateway") -> PortGuardian.Descriptor
    {
        PortGuardian.Descriptor(pid: pid, command: command, executablePath: executablePath)
    }

    private func attachFailureReason(
        errorProvider: @escaping @Sendable () async throws -> GatewayConnection.Config) async throws -> String
    {
        let port = try self.availableGatewayPort()
        let connection = GatewayConnection(configProvider: errorProvider)
        let manager = GatewayProcessManager()
        manager.setTestingConnection(connection)
        manager.setTestingSkipControlChannelRefresh(true)
        let listener = self.gatewayDescriptor(pid: 4242)
        await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)

        let attached = await manager._testAttachExistingGatewayIfAvailable(port: port)
        manager.setTestingDesiredActive(false)
        await connection.shutdown()
        await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)

        #expect(attached)
        guard case let .failed(reason) = manager.status else {
            Issue.record("expected attach failure")
            return ""
        }
        return reason
    }

    private nonisolated func gatewayTask(
        healthSucceedsAfter unavailableResponses: Int?,
        stallsFirstHealthResponse: Bool = false,
        healthResponseGates: [AsyncTestGate] = []) -> GatewayTestWebSocketTask
    {
        let healthRequests = Mutex(0)
        return GatewayTestWebSocketTask(
            sendHook: { task, message, sendIndex in
                guard sendIndex > 0 else { return }
                guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                guard GatewayWebSocketTestSupport.requestMethod(from: message) == "health" else {
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    return
                }
                let healthIndex = healthRequests.withLock {
                    $0 += 1
                    return $0
                }
                if healthResponseGates.indices.contains(healthIndex - 1) {
                    await healthResponseGates[healthIndex - 1].wait()
                }
                if stallsFirstHealthResponse, healthIndex == 1 { return }
                if unavailableResponses.map({ healthIndex <= $0 }) ?? true {
                    let response = Data(
                        """
                        {"type":"res","id":"\(id)","ok":false,
                         "error":{"code":"UNAVAILABLE","message":"gateway awaiting authorization"}}
                        """.utf8)
                    task.emitReceiveSuccess(.data(response))
                    return
                }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
    }

    private func loadedGatewayStatus(
        port: Int,
        pid: Int32 = 4242,
        configAudit: String = #"{"ok":true,"issues":[]}"#) -> String
    {
        """
        {"ok":true,"service":{
          "loaded":true,
          "runtime":{"status":"running","pid":\(pid)},
          "command":{"programArguments":["openclaw","gateway","--port","\(port)"]},
          "configAudit":\(configAudit)
        }}
        """
    }

    private func waitForCondition(
        attempts: Int = 100,
        _ condition: () -> Bool) async
    {
        for _ in 0..<attempts {
            if condition() { break }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    @Test func `coalesces concurrent launch agent enable requests`() async throws {
        let port = 19081
        try await self.withLaunchAgentEnvironment(
            statusPayload: #"{"ok":true,"service":{"loaded":false}}"#)
        {
            let manager = self.manager
            async let first: String? = manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            async let second: String? = manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            _ = await (first, second)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.count == 1)
        }
    }

    @Test func `queues a changed launch agent request behind an in-flight request`() async throws {
        let firstPort = 19091
        let secondPort = 19092
        try await self.withLaunchAgentEnvironment(
            statusPayload: #"{"ok":true,"service":{"loaded":false}}"#,
            commandDelayNanoseconds: 100_000_000)
        {
            let manager = self.manager
            let first = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: firstPort)
            }
            await self.waitForCondition {
                !GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty
            }
            #expect(!GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)

            let second = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: secondPort)
            }
            #expect(await first.value == nil)
            #expect(await second.value == nil)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            let installPorts = calls.compactMap { arguments -> String? in
                guard arguments.first == "install",
                      let portIndex = arguments.firstIndex(of: "--port"),
                      arguments.indices.contains(portIndex + 1)
                else {
                    return nil
                }
                return arguments[portIndex + 1]
            }
            #expect(installPorts == [String(firstPort), String(secondPort)])

            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            let newestPort = 19093
            let stalePort = 19094
            let current = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: newestPort)
            }
            await self.waitForCondition {
                !GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty
            }
            let stale = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeededInstalled(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: stalePort)
            }
            await self.waitForCondition {
                manager._testPendingLaunchAgentPort() == stalePort
            }
            #expect(manager._testPendingLaunchAgentPort() == stalePort)
            let newest = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: newestPort)
            }
            #expect(await current.value == nil)
            #expect(await stale.value == false)
            #expect(await newest.value == nil)

            let finalInstallPorts = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .compactMap { arguments -> String? in
                    guard arguments.first == "install",
                          let portIndex = arguments.firstIndex(of: "--port"),
                          arguments.indices.contains(portIndex + 1)
                    else {
                        return nil
                    }
                    return arguments[portIndex + 1]
                }
            #expect(finalInstallPorts == [String(newestPort)])
        }
    }

    @Test func `coalesced drain returns each request installation result`() async throws {
        let firstPort = 19107
        let secondPort = 19108
        try await self.withLaunchAgentEnvironment(
            statusPayloads: [
                #"{"ok":true,"service":{"loaded":false}}"#,
                self.loadedGatewayStatus(port: secondPort),
            ],
            commandDelayNanoseconds: 100_000_000)
        {
            let manager = self.manager
            let first = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeededInstalled(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: firstPort)
            }
            await self.waitForCondition(attempts: 1000) {
                GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "install" })
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .contains(where: { $0.first == "install" }))

            let second = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeededInstalled(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: secondPort)
            }

            #expect(await first.value)
            #expect(await second.value == false)
            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "install" }.count == 1)
        }
    }

    @Test func `stop discards queued enables and disables after the active request`() async throws {
        let firstPort = 19095
        let secondPort = 19096
        try await self.withLaunchAgentEnvironment(
            statusPayload: #"{"ok":true,"service":{"loaded":false}}"#,
            commandDelayNanoseconds: 100_000_000)
        {
            let manager = self.manager
            manager.setTestingDesiredActive(true)
            let first = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: firstPort)
            }
            await self.waitForCondition {
                !GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty
            }
            let second = Task { @MainActor in
                await manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: secondPort)
            }
            await self.waitForCondition {
                manager._testPendingLaunchAgentPort() == secondPort
            }
            #expect(manager._testPendingLaunchAgentPort() == secondPort)

            manager.stop()
            _ = await (first.value, second.value)
            try? await Task.sleep(nanoseconds: 150_000_000)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            let installPorts = calls.compactMap { arguments -> String? in
                guard arguments.first == "install",
                      let portIndex = arguments.firstIndex(of: "--port"),
                      arguments.indices.contains(portIndex + 1)
                else {
                    return nil
                }
                return arguments[portIndex + 1]
            }
            #expect(installPorts == [String(firstPort)])
            #expect(calls.filter { $0.first == "uninstall" }.count == 1)
            #expect(manager._testPendingLaunchAgentPort() == nil)
            #expect(manager.status == .stopped)
        }
    }

    @Test func `restart waits for an in-progress disable`() async throws {
        let port = 19098
        try await self.withLaunchAgentEnvironment(
            statusPayload: #"{"ok":true,"service":{"loaded":false}}"#,
            commandDelayNanoseconds: 100_000_000)
        {
            let manager = self.manager
            manager.setTestingDesiredActive(true)
            manager.stop()
            await self.waitForCondition {
                GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "uninstall" })
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .contains(where: { $0.first == "uninstall" }))

            manager._testBeginGatewayStartGeneration()
            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.map(\.first) == ["uninstall", "status", "install"])
        }
    }

    @Test func `restart waits for disable before attaching`() async throws {
        let port = 19099
        let url = try #require(URL(string: "ws://example.invalid"))
        let finishDisable = AsyncTestGate()
        let events = AsyncStream<String>.makeStream()
        defer {
            finishDisable.open()
            events.continuation.finish()
        }
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            events.continuation.yield("attach")
            return self.gatewayTask(healthSucceedsAfter: 0)
        }
        let descriptor = self.gatewayDescriptor(pid: 4242)

        try await self.withLaunchAgentEnvironment(commandHook: { arguments in
            guard arguments == ["uninstall"] else { return }
            events.continuation.yield("disable-started")
            await finishDisable.wait()
            events.continuation.yield("disable-finished")
        }) {
            manager.setTestingDesiredActive(true)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            defer {
                manager.setTestingDesiredActive(false)
                manager._testSetLaunchAgentDisableWaitHook(nil)
            }
            manager._testSetLaunchAgentDisableWaitHook {
                events.continuation.yield("disable-wait")
            }

            var iterator = events.stream.makeAsyncIterator()
            manager.stop()
            #expect(await iterator.next() == "disable-started")
            manager._testBeginGatewayStartGeneration()

            let attachment = Task { @MainActor in
                await manager._testAttachExistingGatewayAfterPendingDisable(port: port)
            }
            // Either the owner registers its wait or a broken restart admits a socket first.
            #expect(await iterator.next() == "disable-wait")
            #expect(session.snapshotMakeCount() == 0)
            finishDisable.open()
            let attached = await attachment.value
            manager._testSetLaunchAgentDisableWaitHook(nil)
            events.continuation.finish()
            var order: [String] = []
            while let event = await iterator.next() {
                order.append(event)
            }

            #expect(attached)
            #expect(order == ["disable-finished", "attach"])
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "uninstall" }.count == 1)
            guard case .attachedExisting = manager.status else {
                Issue.record("expected attachedExisting status")
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
                await connection.shutdown()
                return
            }
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            await connection.shutdown()
        }
    }

    @Test func `remote mode still removes the local launch agent`() async throws {
        try await self.withLaunchAgentEnvironment(mode: "remote") {
            let manager = self.manager
            manager.setTestingDesiredActive(true)
            manager.stop()
            await self.waitForCondition {
                GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "uninstall" })
            }

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "uninstall" }.count == 1)
            #expect(manager.status == .stopped)
        }
    }

    @Test func `inactive lifecycle skips persistence ensure`() async throws {
        try await self.withLaunchAgentEnvironment {
            let manager = self.manager
            manager.setTestingDesiredActive(false)
            _ = await manager.ensureLaunchAgentEnabledIfNeeded()

            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
        }
    }

    @Test func `newer inactive lifecycle retains the pending disable`() async throws {
        try await self.withLaunchAgentEnvironment(commandDelayNanoseconds: 100_000_000) {
            let manager = self.manager
            manager.setTestingDesiredActive(true)
            manager.stop()
            manager.stop()
            await self.waitForCondition(attempts: 200) {
                GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "uninstall" })
            }
            try? await Task.sleep(nanoseconds: 150_000_000)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "uninstall" }.count == 1)
            #expect(manager.status == .stopped)
        }
    }

    @Test func `keeps a reusable launch agent running`() async throws {
        let port = 19082
        try await self.withLaunchAgentEnvironment {
            let reusableAudits = [
                #"{"ok":true,"issues":[]}"#,
                #"{"ok":false,"issues":[{"code":"gateway-path-nonminimal","level":"recommended"}]}"#,
            ]
            for configAudit in reusableAudits {
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(
                    self.loadedGatewayStatus(port: port, configAudit: configAudit))
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

                _ = await self.manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: port)

                let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                #expect(calls.filter { $0.first == "status" }.count == 1)
                #expect(calls.allSatisfy { $0.first != "install" })
            }
        }
    }

    @Test func `repairs only a stable launch agent PID after readiness fails`() async throws {
        let port = 19085
        try await self.withLaunchAgentEnvironment(statusPayload: self.loadedGatewayStatus(port: port)) {
            let manager = self.manager
            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            var calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "install" }.isEmpty)

            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            await manager._testRecordLaunchAgentReadinessFailure(port: port, startingPID: 4242)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.count == 1)
            #expect(!manager._testHasLaunchAgentFreshInstallEvidence())
        }
    }

    @Test func `gives a replacement launch agent PID a full readiness cycle`() async throws {
        let port = 19086
        try await self.withLaunchAgentEnvironment(
            statusPayload: self.loadedGatewayStatus(port: port, pid: 4243))
        {
            let manager = self.manager
            await manager._testRecordLaunchAgentReadinessFailure(port: port, startingPID: 4242)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.isEmpty)
        }
    }

    @Test func `stop wins while a readiness failure audit is pending`() async throws {
        let port = 19089
        try await self.withLaunchAgentEnvironment(
            statusPayload: self.loadedGatewayStatus(port: port),
            commandDelayNanoseconds: 100_000_000)
        {
            let manager = self.manager
            manager.setTestingDesiredActive(true)
            let finish = Task { @MainActor in
                await manager._testFinishLaunchAgentReadinessFailure(
                    port: port,
                    startingPID: 4242)
            }
            await self.waitForCondition {
                GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "status" })
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .contains(where: { $0.first == "status" }))

            manager.stop()
            await finish.value
            try? await Task.sleep(nanoseconds: 150_000_000)

            #expect(manager.status == .stopped)
            #expect(!manager._testHasLaunchAgentReadinessFailure())
        }
    }

    @Test func `stale readiness audit cannot clear a restarted generation`() async throws {
        let port = 19090
        try await self.withLaunchAgentEnvironment(
            statusPayload: self.loadedGatewayStatus(port: port),
            commandDelayNanoseconds: 200_000_000)
        {
            let manager = self.manager
            manager.setTestingDesiredActive(true)
            let staleFinish = Task { @MainActor in
                await manager._testFinishLaunchAgentReadinessFailure(
                    port: port,
                    startingPID: 4242)
            }
            await self.waitForCondition {
                GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains(where: { $0.first == "status" })
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .contains(where: { $0.first == "status" }))

            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            manager.stop()
            manager._testBeginGatewayStartGeneration()
            await manager._testFinishLaunchAgentReadinessFailure(
                port: port,
                startingPID: 4242)
            #expect(manager._testHasLaunchAgentReadinessFailure())

            await staleFinish.value

            #expect(manager.status == .failed("Gateway did not start in time"))
            #expect(manager._testHasLaunchAgentReadinessFailure())
        }
    }

    @Test func `repairs a stable launch agent PID with a wedged listener`() async throws {
        let port = 19087
        try await self.withLaunchAgentEnvironment(statusPayload: self.loadedGatewayStatus(port: port)) {
            let manager = self.manager
            let listener = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)
            await manager._testRecordLaunchAgentReadinessFailure(port: port, startingPID: 4242)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.count == 1)
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `protects a foreign listener after launch agent readiness fails`() async throws {
        let port = 19088
        try await self.withLaunchAgentEnvironment(statusPayload: self.loadedGatewayStatus(port: port)) {
            let manager = self.manager
            await manager._testRecordLaunchAgentReadinessFailure(port: port, startingPID: 4242)
            let listener = self.gatewayDescriptor(
                pid: 4243,
                command: "foreign-listener",
                executablePath: "/tmp/foreign-listener")
            await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.isEmpty)
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `protects an unmanaged listener during persistence ensure`() async throws {
        let port = 19100
        try await self.withLaunchAgentEnvironment(
            statusPayload: #"{"ok":true,"service":{"loaded":false}}"#)
        {
            let listener = self.gatewayDescriptor(
                pid: 4243,
                command: "manual-gateway",
                executablePath: "/tmp/manual-gateway")
            await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)

            _ = await self.manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.isEmpty)
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `does not force install when launchd starts during ownership inspection`() async throws {
        let port = 19102
        let statuses = [
            #"{"ok":true,"service":{"loaded":false}}"#,
            self.loadedGatewayStatus(port: port),
        ]
        try await self.withLaunchAgentEnvironment(statusPayloads: statuses) {
            let listener = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)

            _ = await self.manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)

            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            #expect(calls.filter { $0.first == "status" }.count == 1)
            #expect(calls.filter { $0.first == "install" }.isEmpty)
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `repairs loaded launch agents that are not reusable`() async throws {
        let port = 19083
        try await self.withLaunchAgentEnvironment {
            let staleStatuses = [
                """
                {"ok":true,"service":{
                  "loaded":true,
                  "runtime":{"status":"stopped"},
                  "command":{"programArguments":["openclaw","gateway","--port","\(port)"]},
                  "configAudit":{"ok":true,"issues":[]}
                }}
                """,
                """
                {"ok":true,"service":{
                  "loaded":true,
                  "runtime":{"status":"running","pid":4242},
                  "command":{"programArguments":["openclaw","gateway","--port","19084"]},
                  "configAudit":{"ok":true,"issues":[]}
                }}
                """,
                """
                {"ok":true,"service":{
                  "loaded":true,
                  "runtime":{"status":"running","pid":4242},
                  "command":{"programArguments":["openclaw","gateway","--port","\(port)"]},
                  "configAudit":{"ok":false,"issues":[{"code":"gateway-entrypoint-mismatch"}]}
                }}
                """,
            ]

            for status in staleStatuses {
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(status)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()

                _ = await self.manager._testEnableLaunchAgentIfNeeded(
                    bundlePath: "/Applications/OpenClaw.app",
                    port: port)

                let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                #expect(calls.filter { $0.first == "status" }.count == 1)
                #expect(calls.filter { $0.first == "install" }.count == 1)
            }
        }
    }

    @Test func `readiness fixtures preserve other gateway owners`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        try await self.withLaunchAgentEnvironment {
            let port = GatewayEnvironment.gatewayPort()
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(self.loadedGatewayStatus(port: port))
            let shared = GatewayProcessManager.shared
            shared._testResetGatewayStartTask()
            shared.setTestingStatus(.stopped)
            defer {
                shared._testResetGatewayStartTask()
                shared.setTestingStatus(.stopped)
                shared.setTestingConnection(nil)
                shared.setTestingSkipControlChannelRefresh(false)
            }

            let first = self.makeGatewayReadinessFixture(url: url) {
                self.gatewayTask(healthSucceedsAfter: 0)
            }
            first.manager.setTestingDesiredActive(true)
            first.manager.setTestingStatus(.starting)
            #expect(shared.status == .stopped)

            // Another test can construct its fixture before the first readiness probe runs.
            let second = self.makeGatewayReadinessFixture(url: url) {
                self.gatewayTask(healthSucceedsAfter: 0)
            }
            second.manager.setTestingStatus(.stopped)
            await PortGuardian.shared.setTestingDescriptor(self.gatewayDescriptor(pid: 4242), forPort: port)

            #expect(await first.manager.waitForGatewayReady(timeout: 0.5))
            #expect(first.session.snapshotMakeCount() == 1)
            #expect(second.session.snapshotMakeCount() == 0)
            #expect(first.manager.status == .running(details: "pid 4242"))
            #expect(second.manager.status == .stopped)
            #expect(shared.status == .stopped)
            let expectedDaemonCalls = AppProfile.current.isActive ? [["status", "--json", "--no-probe"]] : []
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot() == expectedDaemonCalls)

            await first.connection.shutdown()
            await second.connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `routine readiness preserves an attached gateway and control channel`() async throws {
        try await self.withLaunchAgentEnvironment {
            let url = try #require(URL(string: "ws://127.0.0.1:9"))
            let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
                self.gatewayTask(healthSucceedsAfter: 0)
            }
            manager.setTestingDesiredActive(true)
            manager.setTestingLastFailureReason("health failed")
            manager.setTestingStatus(.attachedExisting(details: "pid 4343"))
            manager._testClearControlChannelRefreshForces()
            manager._testClearLaunchAgentInstallEvidence()
            manager._testSetLastObservedGatewayPID(4343)
            let readinessPort = GatewayEnvironment.gatewayPort()
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(
                self.loadedGatewayStatus(port: readinessPort, pid: 4343))
            manager._testSetLaunchAgentReadinessFailure(port: readinessPort, pid: 4242)
            let descriptor = self.gatewayDescriptor(pid: 4343)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: readinessPort)
            defer {
                manager.setTestingDesiredActive(false)
                manager.setTestingLastFailureReason(nil)
                manager._testClearControlChannelRefreshForces()
                manager._testClearLaunchAgentInstallEvidence()
                manager._testSetLastObservedGatewayPID(nil)
                manager._testClearLaunchAgentReadinessFailure()
            }

            let ready = await manager.waitForGatewayReady(timeout: 0.5)
            #expect(ready)
            #expect(manager.lastFailureReason == nil)
            #expect(!manager._testHasLaunchAgentReadinessFailure())
            #expect(manager.status == .attachedExisting(details: "pid 4343"))
            #expect(manager._testControlChannelRefreshForces().last == false)
            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: readinessPort)
        }
    }

    @Test func `startup install forces the recovered control channel refresh`() async throws {
        let port = try self.availableGatewayPort()
        let url = try #require(URL(string: "ws://example.invalid"))
        let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            self.gatewayTask(healthSucceedsAfter: 0)
        }

        try await self.withLaunchAgentEnvironment(
            port: port,
            statusPayload: #"{"ok":true,"service":{"loaded":false}}"#)
        {
            #expect(GatewayEnvironment.gatewayPort() == port)
            manager.setTestingDesiredActive(true)
            manager.setTestingStatus(.attachedExisting(details: "old pid"))
            manager._testClearControlChannelRefreshForces()
            manager._testClearLaunchAgentReadinessFailure()
            defer {
                manager.setTestingDesiredActive(false)
                manager._testClearControlChannelRefreshForces()
                manager._testClearLaunchAgentReadinessFailure()
            }

            #expect(await manager._testEnableLaunchAgentIfNeededInstalled(
                bundlePath: "/Applications/OpenClaw.app",
                port: port))
            let descriptor = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)

            #expect(await manager.waitForGatewayReady(timeout: 0.5))
            #expect(manager._testControlChannelRefreshForces().last == true)
            #expect(manager.status == .running(details: "pid 4242"))

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `readiness refreshes when the endpoint pid changes during the probe`() async throws {
        try await self.withLaunchAgentEnvironment {
            let port = GatewayEnvironment.gatewayPort()
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(self.loadedGatewayStatus(port: port, pid: 4343))
            let url = try #require(URL(string: "ws://example.invalid"))
            let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        let replacement = PortGuardian.Descriptor(
                            pid: 4343,
                            command: "openclaw-gateway",
                            executablePath: "/tmp/openclaw-gateway")
                        await PortGuardian.shared.setTestingDescriptor(replacement, forPort: port)
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    })
            }
            manager.setTestingDesiredActive(true)
            manager.setTestingStatus(.attachedExisting(details: "pid 4242"))
            manager._testClearControlChannelRefreshForces()
            manager._testClearLaunchAgentReadinessFailure()
            manager._testClearLaunchAgentInstallEvidence()
            manager._testSetLastObservedGatewayPID(4242)
            defer {
                manager.setTestingDesiredActive(false)
                manager._testClearControlChannelRefreshForces()
                manager._testClearLaunchAgentReadinessFailure()
                manager._testClearLaunchAgentInstallEvidence()
                manager._testSetLastObservedGatewayPID(nil)
            }

            let stateDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-gateway-pid-refresh-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: stateDir) }
            let ready = await DeviceIdentityStore.withStateDirectory(stateDir) {
                await manager.waitForGatewayReady(timeout: 0.5)
            }
            #expect(ready)
            #expect(manager._testControlChannelRefreshForces().last == true)
            #expect(manager.status == .running(details: "pid 4343"))

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `readiness retains the endpoint pid from before a launchd candidate`() async throws {
        try await self.withLaunchAgentEnvironment {
            let port = GatewayEnvironment.gatewayPort()
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(self.loadedGatewayStatus(port: port, pid: 4242))
            let url = try #require(URL(string: "ws://127.0.0.1:9"))
            let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
                self.gatewayTask(healthSucceedsAfter: 0)
            }
            let descriptor = self.gatewayDescriptor(pid: 4242)

            manager.setTestingDesiredActive(true)
            manager.setTestingStatus(.running(details: "pid 4141"))
            manager._testClearControlChannelRefreshForces()
            manager._testClearLaunchAgentReadinessFailure()
            manager._testClearLaunchAgentInstallEvidence()
            manager._testSetLastObservedGatewayPID(4141)
            manager._testSetLaunchAgentReadinessCandidate(port: port, pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            defer {
                manager.setTestingDesiredActive(false)
                manager._testClearControlChannelRefreshForces()
                manager._testClearLaunchAgentReadinessFailure()
                manager._testClearLaunchAgentInstallEvidence()
                manager._testSetLastObservedGatewayPID(nil)
            }

            #expect(await manager.waitForGatewayReady(timeout: 0.5))
            #expect(manager._testControlChannelRefreshForces().last == true)
            #expect(manager.status == .running(details: "pid 4242"))

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `responsive health rejection does not arm launchd repair`() async throws {
        let port = 19105
        let url = try #require(URL(string: "ws://example.invalid"))
        let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                sendHook: { task, message, sendIndex in
                    guard sendIndex > 0 else { return }
                    guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                    let response = Data(
                        """
                        {"type":"res","id":"\(id)","ok":false,
                         "error":{"code":"INVALID_REQUEST","message":"health rejected"}}
                        """.utf8)
                    task.emitReceiveSuccess(.data(response))
                })
        }

        try await self.withLaunchAgentEnvironment(statusPayload: self.loadedGatewayStatus(port: port)) {
            manager.setTestingDesiredActive(true)
            manager.setTestingStatus(.attachedExisting(details: "pid 4242"))
            manager._testClearLaunchAgentReadinessFailure()
            manager._testSetLaunchAgentReadinessCandidate(port: port, pid: 4242)
            defer {
                manager.setTestingDesiredActive(false)
                manager.setTestingLastFailureReason(nil)
                manager._testClearLaunchAgentReadinessFailure()
            }

            let descriptor = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)

            #expect(await manager.waitForGatewayReady(timeout: 0.5) == false)
            #expect(!manager._testHasLaunchAgentReadinessFailure())
            guard case let .failed(reason) = manager.status else {
                Issue.record("expected responsive health failure")
                await connection.shutdown()
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
                return
            }
            #expect(reason.contains("health rejected"))

            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "install" }.isEmpty)

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `transient unavailable health response retries until ready`() async throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-gateway-ready-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        try await self.withLaunchAgentEnvironment {
            try await DeviceIdentityStore.withStateDirectory(stateDir) {
                let port = GatewayEnvironment.gatewayPort()
                // Named profiles require the healthy listener to match their managed service.
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(self.loadedGatewayStatus(port: port))
                let url = try #require(URL(string: "ws://example.invalid"))
                let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
                    self.gatewayTask(healthSucceedsAfter: 1)
                }
                let descriptor = self.gatewayDescriptor(pid: 4242)

                manager.setTestingDesiredActive(true)
                manager.setTestingStatus(.starting)
                manager._testClearLaunchAgentReadinessFailure()
                await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
                defer {
                    manager.setTestingDesiredActive(false)
                    manager.setTestingLastFailureReason(nil)
                    manager._testClearLaunchAgentReadinessFailure()
                    manager._testSetLastObservedGatewayPID(nil)
                }

                // The readiness budget covers the unavailable reply and retry; cold
                // connection setup must not consume the behavior under test.
                _ = try await connection.request(method: "status", params: nil, retryTransportFailures: false)
                #expect(await manager.waitForGatewayReady(timeout: 1))
                #expect(session.snapshotMakeCount() == 1)
                #expect(session.latestTask()?.snapshotSendCount() == 4)
                #expect(manager.status == .running(details: "pid 4242"))
                #expect(!manager._testHasLaunchAgentReadinessFailure())

                await connection.shutdown()
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            }
        }
    }

    @Test func `readiness waiter rechecks after current owner fails past its timeout`() async throws {
        let port = 19114
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            self.gatewayTask(
                healthSucceedsAfter: 0,
                stallsFirstHealthResponse: true)
        }

        try await self.withLaunchAgentEnvironment(
            port: port,
            statusPayload: self.loadedGatewayStatus(port: port))
        {
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
            let descriptor = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            defer {
                manager.setTestingLastFailureReason(nil)
                manager._testClearLaunchAgentReadinessFailure()
            }

            manager._testStartLaunchdGatewayReadiness(
                port: port,
                pid: 4242,
                readinessWindow: 0.5,
                firstInstallReadinessBudget: 0.5)
            let readiness = Task { @MainActor in
                await manager.waitForGatewayReady(timeout: 0.01)
            }

            await self.waitForCondition { session.snapshotMakeCount() > 0 }
            #expect(session.snapshotMakeCount() > 0)
            #expect(manager.status == .starting)
            #expect(manager.lastFailureReason == nil)
            #expect(!manager._testHasLaunchAgentReadinessFailure())
            #expect(await readiness.value)
            #expect(manager.status == .running(details: "pid 4242"))
            #expect((session.latestTask()?.snapshotSendCount() ?? 0) > 1)

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `cancelling an owner readiness waiter preserves startup state`() async throws {
        let port = 19115
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            self.gatewayTask(healthSucceedsAfter: nil)
        }

        try await self.withLaunchAgentEnvironment(
            port: port,
            statusPayload: self.loadedGatewayStatus(port: port))
        {
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
            let descriptor = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)

            manager._testStartLaunchdGatewayReadiness(
                port: port,
                pid: 4242,
                readinessWindow: 0.5,
                firstInstallReadinessBudget: 1)
            let readiness = Task { @MainActor in
                await manager.waitForGatewayReady(timeout: 0.01)
            }
            await self.waitForCondition { session.snapshotMakeCount() > 0 }
            #expect(session.snapshotMakeCount() > 0)

            let cancelledAt = Date()
            readiness.cancel()
            #expect(await readiness.value == false)
            #expect(Date().timeIntervalSince(cancelledAt) < 0.5)
            #expect(manager.status == .starting)
            #expect(manager.lastFailureReason == nil)
            #expect(!manager._testHasLaunchAgentReadinessFailure())

            manager.stop()
            await manager.waitForStartupAttempt()
            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `new launchd gateway can cross multiple readiness deadlines`() async throws {
        let port = 19116
        let url = try #require(URL(string: "ws://example.invalid"))
        let responseGates = [AsyncTestGate(), AsyncTestGate()]
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            self.gatewayTask(
                healthSucceedsAfter: 2,
                healthResponseGates: responseGates)
        }

        try await self.withLaunchAgentEnvironment(
            port: port,
            statusPayload: self.loadedGatewayStatus(port: port, pid: 4243))
        {
            manager._testClearControlChannelRefreshForces()
            manager._testClearLaunchAgentReadinessFailure()
            let descriptor = self.gatewayDescriptor(pid: 4243)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            defer {
                manager._testClearControlChannelRefreshForces()
                manager._testClearLaunchAgentReadinessFailure()
            }

            manager._testStartLaunchdGatewayReadiness(
                port: port,
                pid: 4242,
                readinessWindow: 0.2,
                firstInstallReadinessBudget: 5)
            // Release each response only after its 200 ms window so the test owns
            // both deadline crossings instead of depending on runner scheduling.
            await self.waitForCondition { session.latestTask()?.snapshotSendCount() ?? 0 >= 2 }
            #expect(session.latestTask()?.snapshotSendCount() ?? 0 >= 2)
            try await Task.sleep(for: .milliseconds(250))
            responseGates[0].open()
            await self.waitForCondition { session.latestTask()?.snapshotSendCount() ?? 0 >= 3 }
            #expect(session.latestTask()?.snapshotSendCount() ?? 0 >= 3)
            try await Task.sleep(for: .milliseconds(250))
            responseGates[1].open()
            await manager.waitForStartupAttempt()

            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "status" }.count == 1)
            #expect(manager.status == .running(details: "pid 4243"))
            #expect(manager.lastFailureReason == nil)
            #expect(!manager._testHasLaunchAgentReadinessFailure())
            #expect(manager._testControlChannelRefreshForces().last == true)

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `responsive startup progress extends readiness without launchd status proof`() async throws {
        let port = 19119
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                if sendIndex == 2 {
                    let response = Data(
                        """
                        {"type":"res","id":"\(id)","ok":false,
                         "error":{"code":"UNAVAILABLE","message":"gateway awaiting authorization"}}
                        """.utf8)
                    task.emitReceiveSuccess(.data(response))
                } else {
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                }
            })
        }

        try await self.withLaunchAgentEnvironment(
            port: port,
            statusPayload: #"{"ok":true,"service":{"loaded":false}}"#)
        {
            manager._testClearLaunchAgentReadinessFailure()
            let descriptor = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            defer {
                manager._testClearLaunchAgentReadinessFailure()
            }

            // Establish the socket first; the unavailable health reply must exercise
            // readiness extension without spending its window on the handshake.
            _ = try await connection.request(method: "status", params: nil, retryTransportFailures: false)
            manager._testStartLaunchdGatewayReadiness(
                port: port,
                pid: 4242,
                readinessWindow: 0.05,
                firstInstallReadinessBudget: 0.5)
            await manager.waitForStartupAttempt()

            #expect(session.snapshotMakeCount() == 1)
            #expect(session.latestTask()?.snapshotSendCount() == 4)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "status" }.isEmpty)
            #expect(manager.status == .running(details: "pid 4242"))
            #expect(manager.lastFailureReason == nil)
            #expect(!manager._testHasLaunchAgentReadinessFailure())

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `delayed fresh install authorization cannot restart readiness budget`() async throws {
        let port = 19118
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex == 1,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
        }

        try await self.withLaunchAgentEnvironment(
            port: port,
            statusPayload: self.loadedGatewayStatus(port: port),
            commandDelayNanoseconds: 100_000_000)
        {
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
            let descriptor = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            defer {
                manager.setTestingLastFailureReason(nil)
                manager._testClearLaunchAgentReadinessFailure()
            }

            // Establish the socket before the short probe budget. This test owns
            // delayed launchd authorization, not cold-handshake scheduling.
            _ = try await connection.request(method: "status", params: nil, retryTransportFailures: false)
            manager._testStartLaunchdGatewayReadiness(
                port: port,
                pid: 4242,
                readinessWindow: 0.01,
                firstInstallReadinessBudget: 0.02)
            await manager.waitForStartupAttempt()

            #expect(manager.status == .failed("Gateway did not start in time"))
            #expect(manager.lastFailureReason == "launchd start timeout")
            #expect(manager._testHasLaunchAgentReadinessFailure())
            #expect(session.latestTask()?.snapshotSendCount() == 3)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "status" }.count == 2)

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `new launchd gateway fails after bounded readiness grace`() async throws {
        let port = 19117
        let url = try #require(URL(string: "ws://example.invalid"))
        let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask()
        }

        try await self.withLaunchAgentEnvironment(
            port: port,
            statusPayload: self.loadedGatewayStatus(port: port))
        {
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
            manager._testClearLaunchAgentInstallEvidence()
            let descriptor = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            defer {
                manager.setTestingLastFailureReason(nil)
                manager._testClearLaunchAgentReadinessFailure()
                manager._testClearLaunchAgentInstallEvidence()
            }

            manager._testStartLaunchdGatewayReadiness(
                port: port,
                pid: 4242,
                readinessWindow: 0.05,
                firstInstallReadinessBudget: 0.1)
            await manager.waitForStartupAttempt()
            guard case .failed("Gateway did not start in time") = manager.status else {
                Issue.record("fresh launchd readiness did not fail within its bounded grace")
                await connection.shutdown()
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
                return
            }

            #expect(manager.lastFailureReason == "launchd start timeout")
            #expect(manager._testHasLaunchAgentReadinessFailure())

            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "install" }.count == 1)

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test func `cancelled readiness probe preserves lifecycle state`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                receiveHook: { _, receiveIndex in
                    if receiveIndex == 0 {
                        try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                    }
                    throw URLError(.cancelled)
                })
        }
        manager.setTestingDesiredActive(true)
        manager.setTestingStatus(.running(details: "pid 4242"))
        manager.setTestingLastFailureReason("keep newer state")
        manager._testClearLaunchAgentReadinessFailure()
        manager._testSetLaunchAgentReadinessCandidate(port: 19106, pid: 4242)
        defer {
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let readiness = Task { @MainActor in
            await manager.waitForGatewayReady(timeout: 0.5)
        }
        await self.waitForCondition {
            session.snapshotMakeCount() > 0
        }
        #expect(session.snapshotMakeCount() == 1)
        readiness.cancel()

        #expect(await readiness.value == false)
        #expect(manager.status == .running(details: "pid 4242"))
        #expect(manager.lastFailureReason == "keep newer state")
        #expect(manager._testHasLaunchAgentReadinessCandidate())
        await connection.shutdown()
    }

    @Test func `transport cancellation does not publish readiness failure`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                receiveHook: { _, _ in
                    throw URLError(.cancelled)
                })
        }
        manager.setTestingDesiredActive(true)
        manager.setTestingStatus(.running(details: "pid 4242"))
        manager.setTestingLastFailureReason("keep current state")
        manager._testClearLaunchAgentReadinessFailure()
        manager._testSetLaunchAgentReadinessCandidate(port: 19113, pid: 4242)
        defer {
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let startedAt = Date()
        #expect(await manager.waitForGatewayReady(timeout: 0.5) == false)
        #expect(Date().timeIntervalSince(startedAt) < 1.5)
        #expect(manager.status == .running(details: "pid 4242"))
        #expect(manager.lastFailureReason == "keep current state")
        #expect(manager._testHasLaunchAgentReadinessCandidate())
        await connection.shutdown()
    }

    @Test func `only endpoint reachability failures arm launchd repair`() {
        let manager = self.manager
        #expect(manager._testProbeFailureMayNeedLaunchAgentRepair(.timedOut))
        #expect(manager._testProbeFailureMayNeedLaunchAgentRepair(.cannotConnectToHost))
        #expect(manager._testProbeFailureMayNeedLaunchAgentRepair(.networkConnectionLost))
        #expect(!manager._testProbeFailureMayNeedLaunchAgentRepair(.cancelled))
        #expect(!manager._testProbeFailureMayNeedLaunchAgentRepair(.badServerResponse))
        #expect(!manager._testProbeFailureMayNeedLaunchAgentRepair(.dataNotAllowed))
        #expect(manager._testGatewayResponseRetriesWithoutRepair("UNAVAILABLE"))
        #expect(!manager._testGatewayResponseRetriesWithoutRepair("INVALID_REQUEST"))
    }

    @Test func `stale readiness wait cannot clear a newer launch failure`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                sendHook: { task, message, sendIndex in
                    guard sendIndex > 0 else { return }
                    guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                },
                receiveHook: { _, receiveIndex in
                    if receiveIndex == 0 {
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                })
        }
        manager._testBeginGatewayStartGeneration()
        defer {
            manager.setTestingDesiredActive(false)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let staleWait = Task { @MainActor in
            await manager.waitForGatewayReady(timeout: 0.5)
        }
        await self.waitForCondition {
            session.snapshotMakeCount() > 0
        }
        #expect(session.snapshotMakeCount() == 1)
        manager._testBeginGatewayStartGeneration()
        manager._testSetLaunchAgentReadinessFailure(port: 19101, pid: 4242)

        #expect(await staleWait.value == false)
        #expect(manager._testHasLaunchAgentReadinessFailure())
        await connection.shutdown()
    }

    @Test func `same generation stale probe preserves a newer readiness candidate`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                sendHook: { task, message, sendIndex in
                    guard sendIndex > 0 else { return }
                    guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                },
                receiveHook: { _, receiveIndex in
                    if receiveIndex == 0 {
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                })
        }
        manager.setTestingDesiredActive(true)
        manager._testClearLaunchAgentReadinessFailure()
        manager._testSetLaunchAgentReadinessCandidate(port: 19109, pid: 4242)
        defer {
            manager.setTestingDesiredActive(false)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let staleWait = Task { @MainActor in
            await manager.waitForGatewayReady(timeout: 0.5)
        }
        await self.waitForCondition {
            session.snapshotMakeCount() > 0
        }
        #expect(session.snapshotMakeCount() == 1)
        manager._testSetLaunchAgentReadinessCandidate(port: 19109, pid: 4243)

        #expect(await staleWait.value == false)
        #expect(manager._testLaunchAgentReadinessCandidatePID() == 4243)
        await connection.shutdown()
    }

    @Test func `same generation stale timeout preserves a newer readiness failure`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                receiveHook: { _, receiveIndex in
                    if receiveIndex == 0 {
                        try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                    }
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                })
        }
        manager.setTestingDesiredActive(true)
        manager.setTestingLastFailureReason(nil)
        manager._testClearLaunchAgentReadinessFailure()
        defer {
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let staleWait = Task { @MainActor in
            await manager.waitForGatewayReady(timeout: 0.2)
        }
        await self.waitForCondition {
            session.snapshotMakeCount() > 0
        }
        #expect(session.snapshotMakeCount() == 1)
        manager.setTestingLastFailureReason("newer same-generation failure")
        manager._testSetLaunchAgentReadinessFailure(port: 19110, pid: 4244)

        #expect(await staleWait.value == false)
        #expect(manager.lastFailureReason == "newer same-generation failure")
        #expect(manager._testHasLaunchAgentReadinessFailure())
        await connection.shutdown()
    }

    @Test func `stale readiness timeout cannot replace a newer launch failure`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                receiveHook: { _, receiveIndex in
                    if receiveIndex == 0 {
                        try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                    }
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                })
        }
        manager._testBeginGatewayStartGeneration()
        defer {
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let staleWait = Task { @MainActor in
            await manager.waitForGatewayReady(timeout: 0.5)
        }
        await self.waitForCondition {
            session.snapshotMakeCount() > 0
        }
        #expect(session.snapshotMakeCount() == 1)
        manager._testBeginGatewayStartGeneration()
        manager.setTestingLastFailureReason("newer command resolution failure")
        manager._testSetLaunchAgentReadinessFailure(port: 19103, pid: 4243)

        #expect(await staleWait.value == false)
        #expect(manager.lastFailureReason == "newer command resolution failure")
        #expect(manager._testHasLaunchAgentReadinessFailure())
        await connection.shutdown()
    }

    @Test func `readiness timeout includes a stalled socket connect`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                receiveHook: { _, receiveIndex in
                    if receiveIndex == 0 {
                        try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                    }
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                })
        }
        manager.setTestingDesiredActive(true)
        manager.setTestingStatus(.attachedExisting(details: "pid 3131"))
        manager.setTestingLastFailureReason(nil)
        manager._testClearLaunchAgentReadinessFailure()
        manager._testSetLaunchAgentReadinessFailure(port: 19111, pid: 4245)
        defer {
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
        }

        let startedAt = Date()
        let ready = await manager.waitForGatewayReady(timeout: 0.1)
        let elapsed = Date().timeIntervalSince(startedAt)
        await connection.shutdown()

        #expect(!ready)
        #expect(elapsed < 1)
        #expect(session.snapshotMakeCount() == 1)
        #expect(manager.status == .failed("Gateway did not start in time"))
        #expect(manager.lastFailureReason == "gateway readiness timeout")
        #expect(manager._testHasLaunchAgentReadinessFailure())
    }

    @Test func `readiness timeout preserves a concrete launch failure`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let (session, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask(
                receiveHook: { _, receiveIndex in
                    if receiveIndex == 0 {
                        try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                    }
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                })
        }
        manager.setTestingDesiredActive(true)
        manager.setTestingStatus(.failed("launchd install denied"))
        manager.setTestingLastFailureReason("launchd install denied")
        manager._testClearLaunchAgentReadinessFailure()
        defer {
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
            manager._testClearLaunchAgentReadinessFailure()
        }

        #expect(await manager.waitForGatewayReady(timeout: 0.1) == false)
        #expect(session.snapshotMakeCount() == 0)
        #expect(manager.status == .failed("launchd install denied"))
        #expect(manager.lastFailureReason == "launchd install denied")
        await connection.shutdown()
    }

    @Test func `replacement readiness timeout records the pid for the next repair`() async throws {
        let port = 19104
        let url = try #require(URL(string: "ws://example.invalid"))
        let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            GatewayTestWebSocketTask()
        }

        try await self.withLaunchAgentEnvironment(statusPayload: self.loadedGatewayStatus(port: port)) {
            manager.setTestingDesiredActive(true)
            manager._testClearLaunchAgentReadinessFailure()
            defer {
                manager.setTestingDesiredActive(false)
                manager.setTestingLastFailureReason(nil)
                manager._testClearLaunchAgentReadinessFailure()
            }

            let listener = self.gatewayDescriptor(pid: 4242)
            await PortGuardian.shared.setTestingDescriptor(listener, forPort: port)

            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "install" }.isEmpty)
            #expect(manager._testHasLaunchAgentReadinessCandidate())

            #expect(await manager.waitForGatewayReady(timeout: 0.05) == false)
            #expect(manager._testHasLaunchAgentReadinessFailure())

            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            _ = await manager._testEnableLaunchAgentIfNeeded(
                bundlePath: "/Applications/OpenClaw.app",
                port: port)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "install" }.count == 1)

            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
        }
    }

    @Test(arguments: [false, true])
    func `readiness without a service record uses actual installation evidence`(_ installed: Bool) async throws {
        let port = try self.availableGatewayPort()
        let url = try #require(URL(string: "ws://example.invalid"))
        let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            self.gatewayTask(healthSucceedsAfter: 0)
        }
        defer { manager.setTestingDesiredActive(false) }
        try await self.withLaunchAgentEnvironment(port: port) {
            manager.setTestingStatus(.starting)
            manager._testBeginGatewayStartGeneration()
            try #require(GatewayLaunchAgentManager.launchdProgramArguments() == [])
            #expect(await manager.waitForGatewayReady(timeout: 0.5, launchAgentInstalled: installed))
            #expect(manager.installation == (installed ? .managed : .external))
            await connection.shutdown()
        }
    }

    @Test(arguments: [false, true])
    func `pause preserves established installation after service removal`(_ managed: Bool) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let port = try self.availableGatewayPort()
        let url = try #require(URL(string: "ws://example.invalid"))
        let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            self.gatewayTask(healthSucceedsAfter: 0)
        }
        defer { manager.setTestingDesiredActive(false) }
        try await self.withLaunchAgentEnvironment(port: port, homeDirectory: root) {
            let plist = GatewayLaunchAgentManager.plistURL(homeDirectory: root, profile: .current)
            if managed {
                try FileManager.default.createDirectory(
                    at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
                let data = try PropertyListSerialization.data(
                    fromPropertyList: ["ProgramArguments": [CLIInstaller.managedExecutableLocation(), "gateway"]],
                    format: .xml, options: 0)
                try data.write(to: plist)
            }
            #expect(await manager._testAttachExistingGatewayIfAvailable(port: port))
            #expect(manager.installation == (managed ? .managed : .external))
            manager.stop()
            _ = await manager._testAttachExistingGatewayAfterPendingDisable(port: port)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().contains(["uninstall"]))
            if managed {
                // Match uninstallLaunchAgent's filesystem effect without touching launchd.
                try FileManager.default.moveItem(at: plist, to: root.appendingPathComponent("uninstalled.plist"))
            }
            #expect(!FileManager.default.fileExists(atPath: plist.path))
            #expect(manager.status == .stopped)
            #expect(manager.installation == (managed ? .managed : .external))
            await connection.shutdown()
        }
    }

    @Test func `failed reattachment releases departed independent Gateway ownership`() async throws {
        let port = try self.availableGatewayPort()
        let url = try #require(URL(string: "ws://example.invalid"))
        let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
            self.gatewayTask(healthSucceedsAfter: 0)
        }
        defer { manager.setTestingDesiredActive(false) }
        try await self.withLaunchAgentEnvironment(port: port) {
            let hasNoServiceRecord = GatewayLaunchAgentManager.launchdProgramArguments() == []
            try #require(hasNoServiceRecord)
            #expect(await manager._testAttachExistingGatewayIfAvailable(port: port))
            #expect(manager.installation == .external)

            manager.stop()
            #expect(manager.installation == .external)
            _ = await manager._testAttachExistingGatewayAfterPendingDisable(port: port)
            await connection.shutdown()

            let configPath = try #require(ProcessInfo.processInfo.environment["OPENCLAW_CONFIG_PATH"])
            try Data(#"{"gateway":{"mode":"remote"}}"#.utf8)
                .write(to: URL(fileURLWithPath: configPath))
            manager.stop()
            _ = await manager._testAttachExistingGatewayAfterPendingDisable(port: port)
            try Data("{\"gateway\":{\"mode\":\"local\",\"port\":\(port)}}".utf8)
                .write(to: URL(fileURLWithPath: configPath))

            let unavailable = GatewayConnection(configProvider: { throw URLError(.cannotConnectToHost) })
            manager.setTestingConnection(unavailable)
            manager._testBeginGatewayStartGeneration()
            #expect(await manager._testAttachExistingGatewayAfterPendingDisable(port: port) == false)
            #expect(manager.installation == .managed)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .allSatisfy { $0.first != "install" })
            await unavailable.shutdown()
        }
    }

    @Test func `identity conflict paths cannot select Gateway auth guidance`() async throws {
        let conflict =
            "Legacy device identity sources conflict across " +
            "[/tmp/author-profile/device.json (deviceId: device-a)]; all sources preserved."
        let reason = try await self.attachFailureReason {
            throw NSError(
                domain: "ai.openclaw.device-identity-store",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: conflict])
        }

        #expect(reason.contains(conflict))
        #expect(!reason.contains("rejected auth"))
        #expect(!reason.contains("gateway.auth.token"))
    }

    @Test(arguments: [
        GatewayConnectAuthDetailCode.authTokenMissing,
        .authTokenMismatch,
        .authTokenNotConfigured,
    ])
    func `token auth rejection retains token guidance`(
        detail: GatewayConnectAuthDetailCode) async throws
    {
        let reason = try await self.attachFailureReason {
            throw GatewayConnectAuthError(
                message: detail.rawValue,
                detailCode: detail.rawValue,
                canRetryWithDeviceToken: false)
        }

        #expect(reason.contains("rejected auth"))
        #expect(reason.contains("gateway.auth.token"))
    }

    @Test func `non-token Gateway rejections preserve their diagnostics`() async throws {
        let cases: [(GatewayConnectAuthDetailCode?, String)] = [
            (.pairingRequired, "pairing required"),
            (.authPasswordMismatch, "password mismatch"),
            (.deviceIdentityRequired, "device identity required"),
            (.authTailscaleIdentityMismatch, "Tailscale identity mismatch"),
            (.authUnauthorized, "unauthorized"),
            (nil, "unstructured rejection"),
        ]

        for (detail, message) in cases {
            let reason = try await self.attachFailureReason {
                throw GatewayConnectAuthError(
                    message: message,
                    detailCode: detail?.rawValue,
                    canRetryWithDeviceToken: false)
            }

            #expect(reason.contains(message))
            #expect(!reason.contains("rejected auth"))
            #expect(!reason.contains("gateway.auth.token"))
        }
    }

    @Test func `legacy transport failures preserve their diagnostics`() async throws {
        let expectedURLMessage = URLError(.dataNotAllowed).localizedDescription
        let urlReason = try await self.attachFailureReason {
            throw URLError(.dataNotAllowed)
        }
        let closeReason = try await self.attachFailureReason {
            throw NSError(
                domain: "Gateway",
                code: 1008,
                userInfo: [NSLocalizedDescriptionKey: "policy violation"])
        }

        #expect(urlReason.contains(expectedURLMessage))
        #expect(closeReason.contains("policy violation"))
        for reason in [urlReason, closeReason] {
            #expect(!reason.contains("rejected auth"))
            #expect(!reason.contains("gateway.auth.token"))
        }
    }

    @Test func `protocol mismatch retains compatibility guidance`() async throws {
        let reason = try await self.attachFailureReason {
            throw GatewayConnectAuthError(
                message: "protocol mismatch",
                detailCode: GatewayConnectAuthDetailCode.protocolMismatch.rawValue,
                canRetryWithDeviceToken: false,
                expectedProtocol: 999)
        }

        #expect(reason.localizedCaseInsensitiveContains("protocol"))
        #expect(!reason.contains("rejected auth"))
        #expect(!reason.contains("gateway.auth.token"))
    }

    @Test func `Gateway authorization failures preserve their diagnostics`() async throws {
        let missingScope = try await self.attachFailureReason {
            throw GatewayResponseError(
                method: "health",
                code: "FORBIDDEN",
                message: "missing scope: operator.admin",
                details: nil)
        }
        let unauthorizedRole = try await self.attachFailureReason {
            throw GatewayResponseError(
                method: "health",
                code: "INVALID_REQUEST",
                message: "unauthorized role: operator",
                details: nil)
        }

        #expect(missingScope.contains("missing scope: operator.admin"))
        #expect(unauthorizedRole.contains("unauthorized role: operator"))
        for reason in [missingScope, unauthorizedRole] {
            #expect(!reason.contains("rejected auth"))
            #expect(!reason.contains("gateway.auth.token"))
        }
    }

    @Test func `attaches to existing gateway without spawning launchd`() async throws {
        let port = 19097
        do {
            let healthData = Data(
                """
                {
                  "ok": true,
                  "ts": 1,
                  "durationMs": 0,
                  "channels": {
                    "telegram": {
                      "configured": true,
                      "linked": true,
                      "authAgeMs": 60000
                    }
                  },
                  "channelOrder": ["telegram"],
                  "channelLabels": {
                    "telegram": "Telegram"
                  },
                  "heartbeatSeconds": 30,
                  "sessions": {
                    "path": "/tmp/sessions",
                    "count": 1,
                    "recent": []
                  }
                }
                """.utf8)
            let url = try #require(URL(string: "ws://example.invalid"))
            let (_, connection, manager) = self.makeGatewayReadinessFixture(url: url) {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        if sendIndex == 1 {
                            let response = Data(
                                """
                                {"type":"res","id":"\(id)","ok":false,
                                 "error":{"code":"UNAVAILABLE","message":"gateway restarting"}}
                                """.utf8)
                            task.emitReceiveSuccess(.data(response))
                            return
                        }
                        let replacement = PortGuardian.Descriptor(
                            pid: 4343,
                            command: "openclaw-gateway",
                            executablePath: "/tmp/openclaw-gateway")
                        await PortGuardian.shared.setTestingDescriptor(replacement, forPort: port)
                        let json = """
                        {
                          "type": "res",
                          "id": "\(id)",
                          "ok": true,
                          "payload": \(String(decoding: healthData, as: UTF8.self))
                        }
                        """
                        task.emitReceiveSuccess(.data(Data(json.utf8)))
                    })
            }
            let descriptor = self.gatewayDescriptor(pid: 4242)

            await PortGuardian.shared.setTestingDescriptor(descriptor, forPort: port)
            manager.setTestingLastFailureReason("stale")
            manager._testClearControlChannelRefreshForces()
            manager._testSetLastObservedGatewayPID(4242)

            @MainActor
            func cleanup() async {
                manager.setTestingDesiredActive(false)
                manager.setTestingLastFailureReason(nil)
                manager._testClearControlChannelRefreshForces()
                manager._testSetLastObservedGatewayPID(nil)
                await connection.shutdown()
                await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            }

            do {
                let attached = await manager._testAttachExistingGatewayIfAvailable(port: port)
                #expect(attached)
                #expect(manager.lastFailureReason == nil)
                guard case let .attachedExisting(statusDetails) = manager.status else {
                    Issue.record("expected attachedExisting status")
                    await cleanup()
                    return
                }
                let details = try #require(statusDetails)
                #expect(details.contains("port \(port)"))
                #expect(details.contains("Telegram linked"))
                #expect(details.contains("auth 1m"))
                #expect(details.contains("pid 4343 openclaw-gateway @ /tmp/openclaw-gateway"))
                #expect(manager._testControlChannelRefreshForces().last == true)
                await cleanup()
            } catch {
                await cleanup()
                throw error
            }
        }
    }
}
