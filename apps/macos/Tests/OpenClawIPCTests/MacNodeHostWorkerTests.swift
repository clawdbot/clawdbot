import Darwin
import Foundation
import OpenClawKit
import OpenClawProtocol
import os
import Testing
@testable import OpenClaw

private struct WorkerBackpressureTimeout: Error {}

private actor StubMacNodeHostWorker: MacNodeHostWorking {
    let manifest: MacNodeHostManifest
    private var requests: [BridgeInvokeRequest] = []

    init(commands: [String] = ["system.run", "mcp.tools.call.v1"]) {
        self.manifest = MacNodeHostManifest(
            version: "test",
            caps: ["system", "mcp"],
            commands: commands,
            pathEnv: "/usr/bin:/bin")
    }

    func start(launch _: MacNodeHostWorkerLaunch) async throws -> MacNodeHostManifest {
        self.manifest
    }

    func supports(_ command: String) async -> Bool {
        self.manifest.commands.contains(command)
    }

    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        self.requests.append(request)
        return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: #"{"owner":"cli"}"#)
    }

    func handleInput(invokeId _: String, seq _: Int, payloadJSON _: String) async {}
    func cancel(invokeId _: String) async {}

    func setRoute(_: GatewayNodeSessionRoute?, authorityGeneration _: UInt64) async -> Bool {
        true
    }

    func gatewayConnected(ifCurrentRoute _: GatewayNodeSessionRoute) async {}
    func stop() async {}
    func invokedCommands() -> [String] {
        self.requests.map(\.command)
    }
}

@Suite(.serialized)
struct MacNodeHostWorkerTests {
    @Test func `worker crash retry budget is bounded and exponentially delayed`() throws {
        let input = MacNodeHostWorkerRetryPolicy.Input(
            launch: MacNodeHostWorkerLaunch(
                command: ["/usr/local/bin/openclaw", "node", "worker"],
                configurationGeneration: 4))
        var policy = MacNodeHostWorkerRetryPolicy(maximumRetryCount: 5)

        try policy.prepareForStart(input)
        let dispositions = (0..<20).map { _ in policy.recordUnexpectedExit(for: input) }

        #expect(dispositions.prefix(5) == [
            .retry(attempt: 1, delayNanoseconds: 1_000_000_000),
            .retry(attempt: 2, delayNanoseconds: 2_000_000_000),
            .retry(attempt: 3, delayNanoseconds: 4_000_000_000),
            .retry(attempt: 4, delayNanoseconds: 8_000_000_000),
            .retry(attempt: 5, delayNanoseconds: 10_000_000_000),
        ])
        #expect(dispositions.dropFirst(5).allSatisfy {
            $0 == .giveUp(unexpectedExitCount: 6)
        })
        #expect(throws: MacNodeHostWorkerRetryPolicy.RetryBudgetExhausted.self) {
            try policy.prepareForStart(input)
        }
    }

    @Test func `new worker input resets an exhausted crash retry budget`() throws {
        let original = MacNodeHostWorkerRetryPolicy.Input(
            launch: MacNodeHostWorkerLaunch(
                command: ["/usr/local/bin/openclaw", "node", "worker"],
                configurationGeneration: 4))
        let updated = MacNodeHostWorkerRetryPolicy.Input(
            launch: MacNodeHostWorkerLaunch(
                command: original.launch.command,
                configurationGeneration: 5))
        var policy = MacNodeHostWorkerRetryPolicy(maximumRetryCount: 1)

        try policy.prepareForStart(original)
        #expect(policy.recordUnexpectedExit(for: original) ==
            .retry(attempt: 1, delayNanoseconds: 1_000_000_000))
        #expect(policy.recordUnexpectedExit(for: original) == .giveUp(unexpectedExitCount: 2))

        try policy.prepareForStart(updated)
        #expect(policy.recordUnexpectedExit(for: updated) ==
            .retry(attempt: 1, delayNanoseconds: 1_000_000_000))
    }

    @Test func `worker allows a generous cold-start window`() async throws {
        #expect(MacNodeHostWorker.defaultStartupTimeout == 300)

        let worker = MacNodeHostWorker(session: GatewayNodeSession(), startupTimeout: 1)
        let script = """
        sleep 0.1
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":[],"commands":[],"pathEnv":"/usr/bin:/bin"}}'
        while IFS= read -r line; do :; done
        """

        let manifest = try await worker.start(launch: MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", script]))
        #expect(manifest.version == "test")
        await worker.stop()
    }

    @Test func `worker launches in the selected checkout`() async throws {
        let checkout = try makeTempDirForTests().resolvingSymlinksInPath()
        let worker = MacNodeHostWorker(session: GatewayNodeSession(), startupTimeout: 1)
        let script = """
        printf '{"type":"ready","version":"test","manifest":{"caps":[],"commands":[],"pathEnv":"%s"}}\\n' \
          "$(/bin/pwd -P)"
        while IFS= read -r line; do :; done
        """

        let manifest = try await worker.start(launch: MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", script],
            currentDirectoryURL: checkout))

        let expectedCurrentDirectory = try #require(realpath(checkout.path, nil))
        defer { free(expectedCurrentDirectory) }
        #expect(manifest.pathEnv == String(cString: expectedCurrentDirectory))
        await worker.stop()
    }

    @Test(arguments: [
        OpenClawSystemCommand.run.rawValue,
        "mcp.tools.call.v1",
        "codex.terminal.resume.v1",
        "system.worker.start",
    ])
    func `Mac runtime forwards worker-owned commands to the shared worker`(command: String) async {
        let worker = StubMacNodeHostWorker(commands: command == "system.worker.start" ? [] : [command])
        let runtime = MacNodeRuntime(nodeHostWorker: worker)

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "worker-run",
            command: command,
            paramsJSON: #"{"command":["/usr/bin/true"]}"#))

        #expect(response.ok)
        #expect(response.payloadJSON == #"{"owner":"cli"}"#)
        #expect(await worker.invokedCommands() == [command])
    }

    @Test(arguments: [MacNodeScreenCommand.snapshot.rawValue, OpenClawComputerCommand.act.rawValue])
    func `selected CUA provider gives the command pair exclusively to the worker`(command: String) async {
        let worker = StubMacNodeHostWorker(commands: [command])
        let runtime = MacNodeRuntime(
            nodeHostWorker: worker,
            computerControlEnabled: { true },
            computerControlProvider: { .cua })

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "cua-owned",
            command: command,
            paramsJSON: "{}"))

        #expect(response.ok)
        #expect(response.payloadJSON == #"{"owner":"cli"}"#)
        #expect(await worker.invokedCommands() == [command])
    }

    @Test func `selected CUA provider never falls back to native snapshot`() async {
        let worker = StubMacNodeHostWorker(commands: [])
        let runtime = MacNodeRuntime(
            nodeHostWorker: worker,
            computerControlEnabled: { true },
            computerControlProvider: { .cua })

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "cua-unavailable",
            command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(!response.ok)
        #expect(response.error?.message == "UNAVAILABLE: selected CUA provider is not ready")
        #expect(await worker.invokedCommands().isEmpty)
    }

    @Test(arguments: [
        MacNodeCodexThreadCatalogContract.listCommand,
        MacNodeCodexThreadCatalogContract.turnsCommand,
        MacNodeClaudeSessionCatalogContract.listCommand,
        MacNodeClaudeSessionCatalogContract.readCommand,
    ])
    func `native session catalogs own commands shared with the worker`(command: String) async {
        let worker = StubMacNodeHostWorker(commands: [command])
        let payload = #"{"owner":"native"}"#
        let runtime = MacNodeRuntime(
            nodeHostWorker: worker,
            codexThreadCatalogEnabled: { true },
            codexThreadListRequest: { _ in payload },
            codexThreadTurnsRequest: { _ in payload },
            claudeSessionCatalogEnabled: { true },
            claudeSessionListRequest: { _ in payload },
            claudeSessionReadRequest: { _ in payload })

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "native-catalog",
            command: command,
            paramsJSON: #"{"limit":1}"#))

        #expect(response.ok)
        #expect(response.payloadJSON == payload)
        #expect(await worker.invokedCommands().isEmpty)
    }

    @Test(arguments: [
        MacNodeCodexThreadCatalogContract.listCommand,
        MacNodeCodexThreadCatalogContract.turnsCommand,
    ])
    func `worker owns Codex catalog commands when native catalog is disabled`(command: String) async {
        let worker = StubMacNodeHostWorker(commands: [command])
        let nativeCatalogEnabledReads = OSAllocatedUnfairLock(initialState: 0)
        let runtime = MacNodeRuntime(
            nodeHostWorker: worker,
            codexThreadCatalogEnabled: {
                nativeCatalogEnabledReads.withLock {
                    $0 += 1
                    return false
                }
            })

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "worker-codex-catalog",
            command: command,
            paramsJSON: #"{"limit":1}"#))

        #expect(response.ok)
        #expect(response.payloadJSON == #"{"owner":"cli"}"#)
        #expect(await worker.invokedCommands() == [command])
        #expect(nativeCatalogEnabledReads.withLock { $0 } == 1)
    }

    @Test(arguments: [
        (
            MacNodeClaudeSessionCatalogContract.listCommand,
            "UNAVAILABLE: Claude session catalog is disabled"),
        (
            MacNodeClaudeSessionCatalogContract.readCommand,
            "UNAVAILABLE: Claude session catalog is disabled"),
        (
            OpenClawComputerCommand.act.rawValue,
            "COMPUTER_DISABLED: enable Computer Control in Settings"),
    ])
    func `worker cannot bypass native capability consent`(command: String, expectedMessage: String) async {
        let worker = StubMacNodeHostWorker(commands: [command])
        let runtime = MacNodeRuntime(
            nodeHostWorker: worker,
            computerControlEnabled: { false },
            codexThreadCatalogEnabled: { false },
            claudeSessionCatalogEnabled: { false })

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "native-disabled",
            command: command))

        #expect(!response.ok)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == expectedMessage)
        #expect(await worker.invokedCommands().isEmpty)
    }

    @Test(arguments: [
        OpenClawCanvasCommand.present.rawValue,
        OpenClawCanvasCommand.hide.rawValue,
        OpenClawCanvasCommand.navigate.rawValue,
    ])
    func `worker cannot bypass the canvas presenter consent gate`(command: String) async {
        await TestIsolation.withUserDefaultsValues([canvasEnabledKey: false]) {
            let worker = StubMacNodeHostWorker(commands: [command])
            let runtime = MacNodeRuntime(nodeHostWorker: worker)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "canvas-disabled",
                command: command))

            #expect(!response.ok)
            #expect(response.error?.code == .unavailable)
            #expect(response.error?.message == "CANVAS_DISABLED: enable Canvas in Settings")
            #expect(await worker.invokedCommands().isEmpty)
        }
    }

    @Test func `worker cannot claim commands in the retired canvas namespace`() async {
        await TestIsolation.withUserDefaultsValues([canvasEnabledKey: true]) {
            let command = "canvas.plugin.render"
            let worker = StubMacNodeHostWorker(commands: [command])
            let runtime = MacNodeRuntime(nodeHostWorker: worker)

            let response = await runtime.handleInvoke(BridgeInvokeRequest(
                id: "canvas-retired",
                command: command))

            #expect(!response.ok)
            #expect(response.error?.code == .invalidRequest)
            #expect(response.error?.message == "INVALID_REQUEST: unknown command")
            #expect(await worker.invokedCommands().isEmpty)
        }
    }

    @Test func `capability union preserves native order and adds worker commands once`() {
        #expect(MacNodeModeCoordinator.mergingUnique(
            ["canvas", "screen", "system"],
            ["system", "mcp"]) == ["canvas", "screen", "system", "mcp"])
    }

    @Test func `provider selection filters command ownership and publishes each provider descriptor`() throws {
        let descriptor = OpenClawProtocol.AnyCodable([
            "contractVersion": OpenClawProtocol.AnyCodable(2),
        ])
        let manifest = MacNodeHostManifest(
            version: "test",
            caps: ["screen", "computer"],
            commands: [MacNodeScreenCommand.snapshot.rawValue, OpenClawComputerCommand.act.rawValue],
            computerUse: descriptor,
            pathEnv: "/usr/bin:/bin")

        let peekaboo = try #require(MacNodeModeCoordinator.workerManifest(manifest, for: .peekaboo))
        #expect(!peekaboo.commands.contains(MacNodeScreenCommand.snapshot.rawValue))
        #expect(!peekaboo.commands.contains(OpenClawComputerCommand.act.rawValue))
        #expect(peekaboo.computerUse == nil)
        let peekabooDescriptor = try #require(MacNodeModeCoordinator.computerUseDescriptor(
            provider: .peekaboo,
            commands: [MacNodeScreenCommand.snapshot.rawValue, OpenClawComputerCommand.act.rawValue],
            workerManifest: peekaboo))
        let peekabooJSON = try JSONEncoder().encode(peekabooDescriptor)
        let peekabooObject = try #require(
            JSONSerialization.jsonObject(with: peekabooJSON) as? [String: Any])
        #expect(peekabooObject["contractVersion"] as? Int == 2)
        #expect((peekabooObject["provider"] as? [String: Any])?["id"] as? String == "peekaboo")
        let actions = try #require(peekabooObject["actions"] as? [String])
        #expect(actions.contains("get_window_state"))
        #expect(actions.contains("invoke_menu"))
        #expect(!actions.contains("zoom"))
        #expect(!actions.contains("get_browser_state"))
        #expect(!actions.contains("start_recording"))
        let features = try #require(peekabooObject["features"] as? [String: Any])
        #expect(features["recording"] as? Bool == false)
        #expect(features["agentCursor"] as? Bool == false)
        #expect(features["multiDisplay"] as? Bool == true)

        let cua = try #require(MacNodeModeCoordinator.workerManifest(manifest, for: .cua))
        #expect(cua.commands == manifest.commands)
        #expect(MacNodeModeCoordinator.computerUseDescriptor(
            provider: .cua,
            commands: cua.commands,
            workerManifest: cua) == descriptor)
    }

    @Test func `elevation host never advertises a persisted CUA provider`() throws {
        let suiteName = "MacNodeElevationHostProviderTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(true, forKey: computerControlEnabledKey)
        defaults.set(ComputerControlProvider.cua.rawValue, forKey: computerControlProviderKey)
        let provider = ComputerControlProvider.current(
            defaults: defaults,
            cuaAvailable: true,
            launchPlan: AppLaunchRuntimePlan(arguments: ["OpenClaw", "--elevation-host"]))
        #expect(provider == .peekaboo)

        let cuaDescriptor = OpenClawProtocol.AnyCodable(["provider": "cua"])
        let manifest = MacNodeHostManifest(
            version: "test",
            caps: ["screen", "computer"],
            commands: [MacNodeScreenCommand.snapshot.rawValue, OpenClawComputerCommand.act.rawValue],
            computerUse: cuaDescriptor,
            pathEnv: "/usr/bin:/bin")
        let workerManifest = try #require(MacNodeModeCoordinator.workerManifest(manifest, for: provider))
        #expect(workerManifest.computerUse == nil)
        let advertised = try #require(MacNodeModeCoordinator.computerUseDescriptor(
            provider: provider,
            commands: manifest.commands,
            workerManifest: workerManifest))
        let data = try JSONEncoder().encode(advertised)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect((object["provider"] as? [String: Any])?["id"] as? String == "peekaboo")
    }

    @Test func `stale route updates cannot replace newer worker authority`() {
        #expect(MacNodeHostWorker.routeUpdateIsCurrent(candidateGeneration: 4, currentGeneration: 4))
        #expect(MacNodeHostWorker.routeUpdateIsCurrent(candidateGeneration: 5, currentGeneration: 4))
        #expect(!MacNodeHostWorker.routeUpdateIsCurrent(candidateGeneration: 3, currentGeneration: 4))
    }

    @Test func `worker forces app exec host without fallback`() async throws {
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let script = """
        test "$OPENCLAW_NODE_EXEC_HOST" = app || exit 42
        test "$OPENCLAW_NODE_EXEC_FALLBACK" = 0 || exit 43
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":["system"],"commands":["system.run"],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
        # Progress belongs to the invoke; ready already lets the app send that invoke.
        while IFS= read -r line; do
          case "$line" in
            *'"type":"invoke"'*)
              printf '%s\\n' '{"type":"gateway-request","generation":0,"id":"gateway-1","method":"node.invoke.progress","params":{"invokeId":"worker-run","nodeId":"","seq":0,"chunk":"hello"},"timeoutMs":1000}'
              IFS= read -r unavailable
              printf '%s' "$unavailable" | grep -q '"type":"gateway-response"' || exit 44
              printf '%s' "$unavailable" | grep -q '"ok":false' || exit 45
              printf '%s\\n' '{"type":"invoke-result","generation":0,"result":{"id":"worker-run","ok":true,"payload":{"owner":"cli"}}}'
              ;;
          esac
        done
        """

        let manifest = try await worker.start(launch: MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", script]))
        #expect(manifest.commands == ["system.run"])
        let response = await worker.invoke(BridgeInvokeRequest(
            id: "worker-run",
            command: "system.run",
            paramsJSON: #"{"command":["/usr/bin/true"]}"#))
        #expect(response.ok)
        #expect(response.payload != nil)
        await worker.stop()
    }

    @Test func `worker strips inherited CUA values and receives only the app-provided endpoint`() async throws {
        let endpoint = CuaDriverWorkerEndpoint(
            socketPath: "/private/test/cua.sock",
            binaryPath: "/Applications/OpenClaw.app/Contents/Resources/cua-driver")
        let endpointValue = try endpoint.environmentValue()
        let inheritedKeys = [CuaDriverWorkerEnvironment.endpoint] +
            CuaDriverWorkerEnvironment.inheritedFamilyPrefixes.flatMap {
                [$0 + "SOCKET_PATH", $0 + "BINARY_PATH"]
            }
        let inheritedEnvironment = Dictionary(uniqueKeysWithValues: inheritedKeys.map {
            ($0, Optional("inherited"))
        })
        let script = """
        test "$OPENCLAW_CUA_DRIVER_ENDPOINT" = "$1" || exit 41
        test "$(env | grep -Ec '^(OPENCLAW_)?CUA_DRIVER_')" = 1 || exit 42
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":[],"commands":[],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
        while IFS= read -r line; do :; done
        """

        try await TestIsolation.withEnvValues(inheritedEnvironment) {
            let worker = MacNodeHostWorker(session: GatewayNodeSession())
            _ = try await worker.start(launch: MacNodeHostWorkerLaunch(
                command: ["/bin/sh", "-c", script, "worker", endpointValue],
                environment: [
                    CuaDriverWorkerEnvironment.endpoint: endpointValue,
                ]))
            await worker.stop()
        }
    }

    @Test func `unbound worker strips every inherited CUA endpoint value`() async throws {
        let inheritedKeys = [CuaDriverWorkerEnvironment.endpoint] +
            CuaDriverWorkerEnvironment.inheritedFamilyPrefixes.flatMap {
                [$0 + "SOCKET_PATH", $0 + "BINARY_PATH"]
            }
        let inheritedEnvironment = Dictionary(uniqueKeysWithValues: inheritedKeys.map {
            ($0, Optional("inherited"))
        })
        let script = """
        test "$(env | grep -Ec '^(OPENCLAW_)?CUA_DRIVER_')" = 0 || exit 41
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":[],"commands":[],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
        while IFS= read -r line; do :; done
        """

        try await TestIsolation.withEnvValues(inheritedEnvironment) {
            let worker = MacNodeHostWorker(session: GatewayNodeSession())
            _ = try await worker.start(launch: MacNodeHostWorkerLaunch(
                command: ["/bin/sh", "-c", script]))
            await worker.stop()
        }
    }

    @Test func `worker cancellation settles when the child suppresses its result`() async throws {
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-worker-cancel-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: marker) }
        let script = """
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":["terminal"],"commands":["codex.terminal.resume.v1"],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
        IFS= read -r buffered_invoke
        IFS= read -r input
        IFS= read -r buffered_cancel
        printf '%s' "$buffered_invoke" | grep -q '"id":"terminal-1"' || exit 40
        printf '%s' "$input" | grep -q '"type":"invoke-input"' || exit 41
        printf '%s' "$input" | grep -q '"invokeId":"terminal-1"' || exit 42
        printf '%s' "$input" | grep -q '"seq":7' || exit 43
        printf '%s' "$buffered_cancel" | grep -q '"type":"invoke-cancel"' || exit 44
        printf '%s' "$buffered_cancel" | grep -q '"invokeId":"terminal-1"' || exit 45
        IFS= read -r active_invoke
        printf '%s' "$active_invoke" | grep -q '"id":"terminal-2"' || exit 46
        printf '%s\\n' "$$" > "$1"
        IFS= read -r active_cancel
        printf '%s' "$active_cancel" | grep -q '"type":"invoke-cancel"' || exit 47
        printf '%s' "$active_cancel" | grep -q '"invokeId":"terminal-2"' || exit 48
        while IFS= read -r line; do :; done
        """

        _ = try await worker.start(launch: MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", script, "worker", marker.path]))
        await worker.handleInput(invokeId: "terminal-1", seq: 7, payloadJSON: #"{"data":"x"}"#)
        await worker.cancel(invokeId: "terminal-1")
        do {
            let buffered = try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { WorkerBackpressureTimeout() },
                operation: {
                    await worker.invoke(BridgeInvokeRequest(
                        id: "terminal-1",
                        command: "codex.terminal.resume.v1"))
                })
            #expect(!buffered.ok)
            #expect(buffered.error?.message == "UNAVAILABLE: node-host worker invocation cancelled")

            let invoking = Task {
                await worker.invoke(BridgeInvokeRequest(
                    id: "terminal-2",
                    command: "codex.terminal.resume.v1"))
            }
            _ = try await TestProcessSupport.waitForPID(in: marker)
            await worker.cancel(invokeId: "terminal-2")
            let active = try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { WorkerBackpressureTimeout() },
                operation: { await invoking.value })
            await worker.stop()
            #expect(!active.ok)
            #expect(active.error?.message == "UNAVAILABLE: node-host worker invocation cancelled")
        } catch {
            await worker.stop()
            throw error
        }
    }

    @Test func `ready worker exit notifies its route owner`() async throws {
        try await confirmation("unexpected worker exit") { confirmed in
            let exitGate = AsyncTestGate()
            let expectedGeneration: UInt64 = 42
            let worker = MacNodeHostWorker(session: GatewayNodeSession()) { generation in
                #expect(generation == expectedGeneration)
                confirmed()
                exitGate.open()
            }
            let script = """
            printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":["system"],"commands":["system.run"],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
            sleep 0.05
            exit 7
            """

            _ = try await worker.start(launch: MacNodeHostWorkerLaunch(
                command: ["/bin/sh", "-c", script],
                configurationGeneration: expectedGeneration))
            await exitGate.wait()
        }
    }

    @Test func `worker deinit terminates its owned process`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-worker-deinit-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let pidFile = directory.appendingPathComponent("worker.pid")
        defer {
            TestProcessSupport.killLeakedProcesses(in: [pidFile])
            try? FileManager.default.removeItem(at: directory)
        }
        var worker: MacNodeHostWorker? = MacNodeHostWorker(session: GatewayNodeSession())
        let script = """
        printf '%s\n' "$$" > "$1"
        printf '%s\n' '{"type":"ready","version":"test","manifest":{"caps":[],"commands":[],"pathEnv":"/bin"}}'
        while :; do /bin/sleep 1; done
        """

        _ = try await #require(worker).start(launch: MacNodeHostWorkerLaunch(command: [
            "/bin/sh",
            "-c",
            script,
            "worker",
            pidFile.path,
        ]))
        let pid = try await TestProcessSupport.waitForPID(in: pidFile)

        worker = nil

        #expect(await TestProcessSupport.waitUntilGone(pid))
    }

    @Test func `changed worker command replaces the running process`() async throws {
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let firstScript = """
        printf '%s\\n' '{"type":"ready","version":"first","manifest":{"caps":["system"],"commands":["system.run"],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
        while IFS= read -r line; do :; done
        """
        let secondScript = """
        printf '%s\\n' '{"type":"ready","version":"second","manifest":{"caps":["system"],"commands":["system.run"],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
        while IFS= read -r line; do :; done
        """

        let first = try await worker.start(launch: MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", firstScript]))
        let second = try await worker.start(launch: MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", secondScript]))

        #expect(first.version == "first")
        #expect(second.version == "second")
        await worker.stop()
    }

    @Test func `stop cancels a changed launch during worker cleanup`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-worker-restart-stop-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let cleanupStartedPIDFile = directory.appendingPathComponent("cleanup-started.pid")
        let replacementPIDFile = directory.appendingPathComponent("replacement.pid")
        defer {
            TestProcessSupport.killLeakedProcesses(in: [replacementPIDFile, cleanupStartedPIDFile])
            try? FileManager.default.removeItem(at: directory)
        }
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        // Shell builtins handle TERM without waiting on a sleep child. Keep cleanup
        // pending on stdin until the owner's existing termination deadline reaps it.
        let firstScript = """
        trap 'printf "%s\n" "$$" > "$1"; IFS= read -r _; exit 0' TERM
        printf '%s\n' '{"type":"ready","version":"first","manifest":{"caps":[],"commands":[],"pathEnv":"/bin"}}'
        while IFS= read -r line; do :; done
        """
        let replacementScript = """
        printf '%s\n' "$$" > "$1"
        printf '%s\n' '{"type":"ready","version":"replacement","manifest":{"caps":[],"commands":[],"pathEnv":"/bin"}}'
        while IFS= read -r line; do :; done
        """

        _ = try await worker.start(launch: MacNodeHostWorkerLaunch(command: [
            "/bin/sh",
            "-c",
            firstScript,
            "worker",
            cleanupStartedPIDFile.path,
        ]))
        let replacement = Task {
            try await worker.start(launch: MacNodeHostWorkerLaunch(command: [
                "/bin/sh",
                "-c",
                replacementScript,
                "worker",
                replacementPIDFile.path,
            ]))
        }
        _ = try await TestProcessSupport.waitForPID(in: cleanupStartedPIDFile)

        await worker.stop()

        switch await replacement.result {
        case .success:
            Issue.record("changed launch succeeded after stop returned")
            await worker.stop()
        case let .failure(error):
            #expect(error.localizedDescription == "worker stopped")
        }
        #expect(TestProcessSupport.pollPID(in: replacementPIDFile) == nil)
    }

    @Test func `stop waits for the worker leader and reaps its descendants`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-worker-stop-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let leaderPIDFile = directory.appendingPathComponent("leader.pid")
        let descendantPIDFile = directory.appendingPathComponent("descendant.pid")
        let termCompleteFile = directory.appendingPathComponent("term-complete")
        defer {
            TestProcessSupport.killLeakedProcesses(in: [descendantPIDFile, leaderPIDFile])
            try? FileManager.default.removeItem(at: directory)
        }
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let script = """
        printf '%s\n' "$$" > "$1"
        /bin/sh -c 'trap "" HUP TERM; printf "%s\\n" "$$" > "$1"; while :; do /bin/sleep 1; done' \
          descendant "$2" </dev/null >/dev/null 2>&1 &
        while [ ! -s "$2" ]; do /bin/sleep 0.01; done
        trap 'touch "$3"; /bin/sleep 0.2; exit 0' TERM
        printf '%s\n' '{"type":"ready","version":"test","manifest":{"caps":[],"commands":[],"pathEnv":"/bin"}}'
        while :; do /bin/sleep 1; done
        """

        _ = try await worker.start(launch: MacNodeHostWorkerLaunch(command: [
            "/bin/sh",
            "-c",
            script,
            "worker",
            leaderPIDFile.path,
            descendantPIDFile.path,
            termCompleteFile.path,
        ]))
        let leaderPID = try await TestProcessSupport.waitForPID(in: leaderPIDFile)
        let descendantPID = try await TestProcessSupport.waitForPID(in: descendantPIDFile)

        await worker.stop()

        #expect(FileManager.default.fileExists(atPath: termCompleteFile.path))
        #expect(TestProcessSupport.processIsGone(leaderPID))
        #expect(TestProcessSupport.processIsGone(descendantPID))
    }

    @Test func `worker drains stdout while a large stdin frame is backpressured`() async throws {
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let script = """
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":["system"],"commands":["system.run"],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
        IFS= read -r first
        printf '{"type":"invoke-result","generation":0,"result":{"id":"first","ok":true,"payload":{"blob":"'
        head -c 2097152 /dev/zero | tr '\\000' x
        printf '"}}}\\n'
        IFS= read -r second
        printf '%s\\n' '{"type":"invoke-result","generation":0,"result":{"id":"second","ok":true,"payload":{"done":true}}}'
        """
        _ = try await worker.start(launch: MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", script]))

        let first = Task {
            await worker.invoke(BridgeInvokeRequest(
                id: "first",
                command: "system.run",
                paramsJSON: #"{"command":["/usr/bin/true"]}"#))
        }
        try await Task.sleep(for: .milliseconds(20))
        let largeParams = #"{"blob":""# + String(repeating: "x", count: 2 * 1024 * 1024) + #""}"#
        let second = Task {
            await worker.invoke(BridgeInvokeRequest(
                id: "second",
                command: "system.run",
                paramsJSON: largeParams))
        }

        do {
            let responses = try await AsyncTimeout.withTimeout(
                seconds: 5,
                onTimeout: { WorkerBackpressureTimeout() },
                operation: { [first, second] in await [first.value, second.value] })
            await worker.stop()
            let allResponsesSucceeded = responses.allSatisfy(\.ok)
            #expect(allResponsesSucceeded)
        } catch {
            await worker.stop()
            throw error
        }
    }

    // Regression: a worker that exits before its ready manifest must consume the
    // crash retry budget and carry its stderr into the start error. Before this,
    // startup-time CLI refusals (for example a state database schema mismatch)
    // never notified the retry policy, so the coordinator respawned the broken
    // CLI forever and the operator only ever saw "exited(1)" in os_log.
    @Test func `startup exit consumes retry budget and surfaces worker stderr`() async throws {
        let exitGate = AsyncTestGate()
        let exitGeneration = OSAllocatedUnfairLock<UInt64?>(initialState: nil)
        let worker = MacNodeHostWorker(
            session: GatewayNodeSession(),
            startupTimeout: 5,
            onUnexpectedExit: { generation in
                exitGeneration.withLock { $0 = generation }
                exitGate.open()
            })
        let script = """
        echo 'refused: state database uses newer schema version' >&2
        sleep 0.2
        exit 7
        """

        do {
            _ = try await worker.start(launch: MacNodeHostWorkerLaunch(
                command: ["/bin/sh", "-c", script],
                configurationGeneration: 3))
            Issue.record("worker start unexpectedly succeeded")
        } catch {
            let workerError = try #require(error as? MacNodeHostWorker.WorkerError)
            guard case let .unavailable(reason, diagnostic) = workerError else {
                Issue.record("worker start did not report an unavailable error")
                return
            }
            #expect(reason.contains("exited"))
            #expect(!reason.contains("state database"))
            #expect(diagnostic?.contains("state database uses newer schema version") == true)
            #expect(error.localizedDescription.contains("state database uses newer schema version"))
        }

        await exitGate.wait()
        #expect(exitGeneration.withLock { $0 } == 3)
        await worker.stop()
    }
}
