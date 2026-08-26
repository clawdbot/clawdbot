import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct NodeServiceManagerTests {
    @Test func `active profile performs no persistent node service work`() async {
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "work"])
        NodeServiceManager._testResetPersistentServiceCalls()

        #expect(await NodeServiceManager.start(profile: profile) == nil)
        #expect(await NodeServiceManager.stop(profile: profile) == nil)
        #expect(await NodeServiceManager.restart(profile: profile) == nil)
        #expect(NodeServiceManager.launchdProgramArguments(profile: profile) == [])
        #expect(await !(NodeServiceManager.waitUntilRunning(profile: profile)))
        let snapshot = NodeServiceManager._testPersistentServiceCallSnapshot()
        #expect(snapshot.commands.isEmpty)
        #expect(snapshot.ownershipReads == 0)
    }

    @Test func `builds node service commands with current CLI shape`() async throws {
        try await TestIsolation.withUserDefaultsValues(["openclaw.gatewayProjectRootPath": nil]) {
            let tmp = try makeTempDirForTests()
            CommandResolver.setProjectRoot(tmp.path)

            let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
            try makeExecutableForTests(at: openclawPath)

            let start = await NodeServiceManager._testServiceCommand(["start"])
            #expect(start == [openclawPath.path, "node", "start", "--json"])

            let stop = await NodeServiceManager._testServiceCommand(["stop"])
            #expect(stop == [openclawPath.path, "node", "stop", "--json"])

            let restart = await NodeServiceManager._testServiceCommand(["restart"])
            #expect(restart == [openclawPath.path, "node", "restart", "--json"])
        }
    }

    @Test(arguments: ["start:stop", "stop:start", "restart:stop"])
    func `node lifecycle commands finish in request order`(_ transition: String) async throws {
        let actions = transition.split(separator: ":").map(String.init)
        let previousAction = try #require(actions.first)
        let nextAction = try #require(actions.last)
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_NODE_SERVICE_TEST_ROOT": root.path,
                "OPENCLAW_NODE_SERVICE_DELAYED_ACTION": previousAction,
            ],
            defaults: ["openclaw.gatewayProjectRootPath": nil])
        {
            CommandResolver.setProjectRoot(root.path)
            let executable = root.appendingPathComponent("node_modules/.bin/openclaw")
            try makeExecutableForTests(at: executable)
            let script = """
            #!/bin/sh
            action="$2"
            : > "$OPENCLAW_NODE_SERVICE_TEST_ROOT/$action.entered"
            if [ "$action" = "$OPENCLAW_NODE_SERVICE_DELAYED_ACTION" ]; then
              while [ ! -f "$OPENCLAW_NODE_SERVICE_TEST_ROOT/release" ]; do
                sleep 0.01
              done
            fi
            if [ "$action" = "stop" ]; then
              printf stopped > "$OPENCLAW_NODE_SERVICE_TEST_ROOT/state"
            else
              printf running > "$OPENCLAW_NODE_SERVICE_TEST_ROOT/state"
            fi
            printf '{"ok":true}'
            """
            try script.write(to: executable, atomically: false, encoding: .utf8)

            let release = root.appendingPathComponent("release")
            defer { try? Data().write(to: release) }
            let profile = AppProfile(environment: [:])
            let previous = Task { await self.runNodeServiceAction(previousAction, profile: profile) }
            let previousEntered = root.appendingPathComponent("\(previousAction).entered")
            for _ in 0..<200 where !FileManager.default.fileExists(atPath: previousEntered.path) {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(FileManager.default.fileExists(atPath: previousEntered.path))

            let next = Task { await self.runNodeServiceAction(nextAction, profile: profile) }
            let nextEntered = root.appendingPathComponent("\(nextAction).entered")
            for _ in 0..<50 where !FileManager.default.fileExists(atPath: nextEntered.path) {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(!FileManager.default.fileExists(atPath: nextEntered.path))

            try Data().write(to: release)
            #expect(await previous.value == nil)
            #expect(await next.value == nil)
            let observed = try String(contentsOf: root.appendingPathComponent("state"), encoding: .utf8)
            #expect(observed == (nextAction == "stop" ? "stopped" : "running"))
        }
    }

    @Test(arguments: [
        "failed-start", "failed-stop", "failed-restart", "json-success", "plain-success", "json-failure",
    ])
    func `node lifecycle respects process exit and optional JSON status`(_ scenario: String) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }

        try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_NODE_SERVICE_TEST_CASE": scenario],
            defaults: ["openclaw.gatewayProjectRootPath": nil])
        {
            CommandResolver.setProjectRoot(root.path)
            let executable = root.appendingPathComponent("node_modules/.bin/openclaw")
            try makeExecutableForTests(at: executable)
            let script = """
            #!/bin/sh
            case "$OPENCLAW_NODE_SERVICE_TEST_CASE" in
              failed-*) printf '{"ok":true}'; printf 'cleanup failed' >&2; exit 23 ;;
              json-failure) printf '{"ok":false,"error":"reported failure"}' ;;
              plain-success) printf 'service started' ;;
              *) printf '{"ok":true}' ;;
            esac
            """
            try script.write(to: executable, atomically: false, encoding: .utf8)

            let action = switch scenario {
            case "failed-stop": "stop"
            case "failed-restart": "restart"
            default: "start"
            }
            let expectedError: String? = switch scenario {
            case "failed-start", "failed-stop", "failed-restart": "cleanup failed"
            case "json-failure": "reported failure"
            default: nil
            }

            #expect(await self.runNodeServiceAction(action, profile: AppProfile(environment: [:])) == expectedError)
        }
    }

    @Test func `reads node service ownership command directly from launchd`() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-node-\(UUID().uuidString).plist")
        defer { try? FileManager.default.removeItem(at: url) }
        let arguments = [
            "/Users/Test/.openclaw/tools/node/bin/node",
            "/Users/Test/.openclaw/lib/node_modules/openclaw/dist/index.js",
            "node",
            "run",
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: ["ProgramArguments": arguments],
            format: .xml,
            options: 0)
        try data.write(to: url, options: .atomic)

        #expect(NodeServiceManager._testLaunchdProgramArguments(plistURL: url) == arguments)
        try Data("not a plist".utf8).write(to: url, options: .atomic)
        #expect(NodeServiceManager._testLaunchdProgramArguments(plistURL: url) == nil)
        try FileManager.default.removeItem(at: url)
        #expect(NodeServiceManager._testLaunchdProgramArguments(plistURL: url) == [])
    }

    @Test func `node status requires loaded running service`() {
        #expect(NodeServiceManager._testRuntimeIsRunning(fromJSON: """
        {"service":{"loaded":true,"runtime":{"status":"running"}}}
        """))
        #expect(!NodeServiceManager._testRuntimeIsRunning(fromJSON: """
        {"service":{"loaded":false,"runtime":{"status":"running"}}}
        """))
        #expect(!NodeServiceManager._testRuntimeIsRunning(fromJSON: """
        {"service":{"loaded":true,"runtime":{"status":"stopped"}}}
        """))
    }

    private func runNodeServiceAction(_ action: String, profile: AppProfile) async -> String? {
        switch action {
        case "start":
            await NodeServiceManager.start(profile: profile)
        case "stop":
            await NodeServiceManager.stop(profile: profile)
        case "restart":
            await NodeServiceManager.restart(profile: profile)
        default:
            "Unknown node service action"
        }
    }
}
