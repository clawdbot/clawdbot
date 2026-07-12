import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private struct WorkerBackpressureTimeout: Error {}

private actor StubMacNodeHostWorker: MacNodeHostWorking {
    let manifest = MacNodeHostManifest(
        version: "test",
        caps: ["system", "mcp"],
        commands: ["system.run", "mcp.tools.call.v1"],
        pathEnv: "/usr/bin:/bin")
    private var requests: [BridgeInvokeRequest] = []

    func start(command _: [String]) async throws -> MacNodeHostManifest { self.manifest }
    func supports(_ command: String) async -> Bool { self.manifest.commands.contains(command) }

    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        self.requests.append(request)
        return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: #"{"owner":"cli"}"#)
    }

    func setRoute(_: GatewayNodeSessionRoute?, authorityGeneration _: UInt64) async -> Bool { true }
    func publishInventory(ifCurrentRoute _: GatewayNodeSessionRoute) async {}
    func stop() async {}
    func invokedCommands() -> [String] { self.requests.map(\.command) }
}

@Suite(.serialized)
struct MacNodeHostWorkerTests {
    @Test func `Mac runtime forwards CLI node commands to the shared worker`() async {
        let worker = StubMacNodeHostWorker()
        let runtime = MacNodeRuntime(nodeHostWorker: worker)

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "worker-run",
            command: OpenClawSystemCommand.run.rawValue,
            paramsJSON: #"{"command":["/usr/bin/true"]}"#))

        #expect(response.ok)
        #expect(response.payloadJSON == #"{"owner":"cli"}"#)
        #expect(await worker.invokedCommands() == [OpenClawSystemCommand.run.rawValue])
    }

    @Test func `capability union preserves native order and adds worker commands once`() {
        #expect(MacNodeModeCoordinator.mergingUnique(
            ["canvas", "screen", "system"],
            ["system", "mcp"]) == ["canvas", "screen", "system", "mcp"])
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
        printf '%s\\n' '{"type":"gateway-request","id":"gateway-1","method":"skills.bins","params":{},"timeoutMs":1000}'
        IFS= read -r unavailable
        printf '%s' "$unavailable" | grep -q '"type":"gateway-response"' || exit 44
        printf '%s' "$unavailable" | grep -q '"ok":false' || exit 45
        while IFS= read -r line; do
          case "$line" in
            *'"type":"invoke"'*) printf '%s\\n' '{"type":"invoke-result","result":{"id":"worker-run","ok":true,"payload":{"owner":"cli"}}}' ;;
          esac
        done
        """

        let manifest = try await worker.start(command: ["/bin/sh", "-c", script])
        #expect(manifest.commands == ["system.run"])
        let response = await worker.invoke(BridgeInvokeRequest(
            id: "worker-run",
            command: "system.run",
            paramsJSON: #"{"command":["/usr/bin/true"]}"#))
        #expect(response.ok)
        #expect(response.payload != nil)
        await worker.stop()
    }

    @Test func `ready worker exit notifies its route owner`() async throws {
        try await confirmation("unexpected worker exit") { confirmed in
            let worker = MacNodeHostWorker(session: GatewayNodeSession()) {
                confirmed()
            }
            let script = """
            printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":["system"],"commands":["system.run"],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
            sleep 0.05
            exit 7
            """

            _ = try await worker.start(command: ["/bin/sh", "-c", script])
            try? await Task.sleep(for: .milliseconds(200))
        }
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

        let first = try await worker.start(command: ["/bin/sh", "-c", firstScript])
        let second = try await worker.start(command: ["/bin/sh", "-c", secondScript])

        #expect(first.version == "first")
        #expect(second.version == "second")
        await worker.stop()
    }

    @Test func `worker drains stdout while a large stdin frame is backpressured`() async throws {
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let script = """
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":["system"],"commands":["system.run"],"pathEnv":"/usr/bin:/bin"},"inventory":{"skills":null,"pluginTools":[]}}'
        IFS= read -r first
        printf '{"type":"invoke-result","result":{"id":"first","ok":true,"payload":{"blob":"'
        head -c 2097152 /dev/zero | tr '\\000' x
        printf '"}}}\\n'
        IFS= read -r second
        printf '%s\\n' '{"type":"invoke-result","result":{"id":"second","ok":true,"payload":{"done":true}}}'
        """
        _ = try await worker.start(command: ["/bin/sh", "-c", script])

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
                operation: { [first, second] in [await first.value, await second.value] })
            await worker.stop()
            #expect(responses.allSatisfy { $0.ok })
        } catch {
            await worker.stop()
            throw error
        }
    }
}
