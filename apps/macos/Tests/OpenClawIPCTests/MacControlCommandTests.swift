import Foundation
import OpenClawIPC
import Testing
@testable import OpenClawMacCLI

struct MacControlCommandTests {
    @Test func `new command parsing routes globals and profile override without reading secrets`() throws {
        for arguments in [[], ["status"], ["--profile", "fleet", "primary", "show"], ["gateway", "list"]] {
            #expect(resolveRootCommandAction(arguments) == .control(arguments))
        }
        let options = try MacControlOptions.parse([
            "--profile", "fleet", "primary", "set", "--ssh-target", "alice@gateway.example:2222",
            "--remote-port", "19000", "--local-port", "19001", "--identity", "/tmp/identity",
            "--ssh-host-key-policy", "strict", "--token-file", "/does-not-exist", "--json", "--no-launch",
        ], environment: ["OPENCLAW_PROFILE": "other"])
        #expect(options.profile.name == "fleet")
        #expect(options.request.operation == "primary.set")
        #expect(options.request.transport == "ssh")
        #expect(options.request.sshTarget == "alice@gateway.example:2222")
        #expect(options.request.remotePort == 19000)
        #expect(options.request.localPort == 19001)
        #expect(options.request.identityPath == "/tmp/identity")
        #expect(options.request.hostKeyPolicy == "strict")
        #expect(options.tokenSource == .file("/does-not-exist"))
        #expect(options.request.token == nil)
        #expect(options.json && !options.launch)
    }

    @Test(arguments: [
        ["primary", "set", "--local", "--token", "synthetic-secret"],
        ["gateway", "add", "Demo", "--url", "wss://gateway.example", "--password=synthetic-secret"],
        ["primary", "set", "--local", "--direct-url", "wss://gateway.example"],
        ["primary", "set", "--direct-url", "wss://gateway.example", "--remote-port", "19000"],
        ["primary", "set", "--ssh-target", "alice@gateway.example", "--local-port", "65536"],
        ["primary", "set", "--local", "--token-stdin"],
        ["status", "--token-file", "/tmp/token"],
        ["gateway", "add", "Demo", "--url", "wss://gateway.example", "--token-stdin", "--password-stdin"],
        ["gateway", "add", "Demo", "--url", "wss://gateway.example", "--token-file", "/tmp/token", "--token-stdin"],
    ])
    func `invalid invocations fail before reaching the app and do not echo secrets`(_ arguments: [String]) throws {
        do {
            _ = try MacControlOptions.parse(arguments)
            Issue.record("Expected a usage error")
        } catch let error as MacControlError {
            #expect(error.code == "usage")
            #expect(!error.message.contains("synthetic-secret"))
        }
    }

    @Test func `browser commands have enough time for sign in and retain explicit deadline`() throws {
        let browser = try MacControlOptions.parse([
            "gateway", "add", "Demo", "--url", "https://gateway.example/base", "--browser",
        ])
        #expect(browser.request.browser == true)
        #expect(browser.timeoutMs == 310_000)
        #expect(try MacControlOptions.parse([
            "gateway", "add", "Demo", "--url", "https://gateway.example",
        ]).request.browser == true)
        #expect(try MacControlOptions.parse([
            "gateway", "add", "Demo", "--url", "https://gateway.example", "--token-stdin",
        ]).request.browser == false)
        #expect(try MacControlOptions.parse(["gateway", "reconnect", "Demo"]).timeoutMs == 310_000)
        #expect(try MacControlOptions.parse(["gateway", "reconnect", "Demo", "--timeout", "500"]).timeoutMs == 500)
        #expect(try MacControlOptions.parse(["status"]).timeoutMs == 15000)
    }

    @Test func `JSON success returns the requested status shape and errors retain structured code`() throws {
        let response = Data(#"{"ok":true,"result":{"primary":{"mode":"unconfigured","transport":null},"gateways":[]}}"#
            .utf8)
        let status = try #require(JSONSerialization.jsonObject(with: macControlResult(
            response,
            primaryOnly: false)) as? [String: Any])
        #expect(status["ok"] == nil)
        #expect(status["gateways"] is [Any])
        let primary = try #require(JSONSerialization.jsonObject(with: macControlResult(
            response,
            primaryOnly: true)) as? [String: Any])
        #expect(primary["mode"] as? String == "unconfigured")
        #expect(primary["transport"] is NSNull)
        let failure = Data(#"{"ok":false,"error":{"code":"ambiguous_gateway","message":"Choose an id."}}"#.utf8)
        do {
            _ = try macControlResult(failure, primaryOnly: false)
            Issue.record("Expected the app error")
        } catch let error as MacControlError {
            #expect(error.code == "ambiguous_gateway")
            #expect(error.message == "Choose an id.")
        }
    }

    @Test func `profile paths share validation with the app and bundle launch stays in its containing app`() throws {
        let options = try MacControlOptions.parse(["status"], environment: ["OPENCLAW_PROFILE": "fleet"])
        #expect(options.profile.stateDirectoryURL(homeDirectory: URL(fileURLWithPath: "/private/home"))
            .path == "/private/home/.openclaw-fleet")
        for invalid in ["../other", "Fleet", "mac", "node", "gateway"] {
            #expect(throws: Error.self) { try MacControlOptions.parse(["--profile", invalid, "status"]) }
        }
        let bundle = MacControlClient
            .applicationBundle(executableURL: URL(fileURLWithPath: "/Example/OpenClaw.app/Contents/MacOS/openclaw-mac"))
        #expect(bundle.path == "/Example/OpenClaw.app")
    }
}
