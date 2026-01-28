import AppKit
import MoltbotProtocol
import Foundation
import Testing

@testable import Moltbot

@Suite(.serialized)
struct LowCoverageHelperTests {
    private typealias ProtoAnyCodable = MoltbotProtocol.AnyCodable

    @Test func anyCodableHelperAccessors() throws {
        let payload: [String: ProtoAnyCodable] = [
            "title": ProtoAnyCodable("Hello"),
            "flag": ProtoAnyCodable(true),
            "count": ProtoAnyCodable(3),
            "ratio": ProtoAnyCodable(1.25),
            "list": ProtoAnyCodable([ProtoAnyCodable("a"), ProtoAnyCodable(2)]),
        ]
        let any = ProtoAnyCodable(payload)
        let dict = try #require(any.dictionaryValue)
        #expect(dict["title"]?.stringValue == "Hello")
        #expect(dict["flag"]?.boolValue == true)
        #expect(dict["count"]?.intValue == 3)
        #expect(dict["ratio"]?.doubleValue == 1.25)
        #expect(dict["list"]?.arrayValue?.count == 2)

        let foundation = any.foundationValue as? [String: Any]
        #expect((foundation?["title"] as? String) == "Hello")
    }

    @Test func attributedStringStripsForegroundColor() {
        let text = NSMutableAttributedString(string: "Test")
        text.addAttribute(.foregroundColor, value: NSColor.red, range: NSRange(location: 0, length: 4))
        let stripped = text.strippingForegroundColor()
        let color = stripped.attribute(.foregroundColor, at: 0, effectiveRange: nil)
        #expect(color == nil)
    }

    @Test func viewMetricsReduceWidth() {
        let value = ViewMetricsTesting.reduceWidth(current: 120, next: 180)
        #expect(value == 180)
    }

    @Test func shellExecutorHandlesEmptyCommand() async {
        let result = await ShellExecutor.runDetailed(command: [], cwd: nil, env: nil, timeout: nil)
        #expect(result.success == false)
        #expect(result.errorMessage != nil)
    }

    @Test func shellExecutorRunsCommand() async {
        let result = await ShellExecutor.runDetailed(command: ["/bin/echo", "ok"], cwd: nil, env: nil, timeout: 2)
        #expect(result.success == true)
        #expect(result.stdout.contains("ok") || result.stderr.contains("ok"))
    }

    @Test func shellExecutorTimesOut() async {
        let result = await ShellExecutor.runDetailed(command: ["/bin/sleep", "1"], cwd: nil, env: nil, timeout: 0.05)
        #expect(result.timedOut == true)
    }

    @Test func shellExecutorDrainsStdoutAndStderr() async {
        let script = """
        i=0
        while [ $i -lt 2000 ]; do
          echo "stdout-$i"
          echo "stderr-$i" 1>&2
          i=$((i+1))
        done
        """
        let result = await ShellExecutor.runDetailed(
            command: ["/bin/sh", "-c", script],
            cwd: nil,
            env: nil,
            timeout: 2)
        #expect(result.success == true)
        #expect(result.stdout.contains("stdout-1999"))
        #expect(result.stderr.contains("stderr-1999"))
    }

    @Test func nodeInfoCodableRoundTrip() throws {
        let info = NodeInfo(
            nodeId: "node-1",
            displayName: "Node One",
            platform: "macOS",
            version: "1.0",
            coreVersion: "1.0-core",
            uiVersion: "1.0-ui",
            deviceFamily: "Mac",
            modelIdentifier: "MacBookPro",
            remoteIp: "192.168.1.2",
            caps: ["chat"],
            commands: ["send"],
            permissions: ["send": true],
            paired: true,
            connected: false)
        let data = try JSONEncoder().encode(info)
        let decoded = try JSONDecoder().decode(NodeInfo.self, from: data)
        #expect(decoded.nodeId == "node-1")
        #expect(decoded.isPaired == true)
        #expect(decoded.isConnected == false)
    }

    @Test @MainActor func presenceReporterHelpers() {
        let summary = PresenceReporter._testComposePresenceSummary(mode: "local", reason: "test")
        #expect(summary.contains("mode local"))
        #expect(!PresenceReporter._testAppVersionString().isEmpty)
        #expect(!PresenceReporter._testPlatformString().isEmpty)
        _ = PresenceReporter._testLastInputSeconds()
        _ = PresenceReporter._testPrimaryIPv4Address()
    }

    @Test func portGuardianParsesListenersAndBuildsReports() {
        let output = """
        p123
        cnode
        uuser
        p456
        cssh
        uroot
        """
        let listeners = PortGuardian._testParseListeners(output)
        #expect(listeners.count == 2)
        #expect(listeners[0].command == "node")
        #expect(listeners[1].command == "ssh")

        let okReport = PortGuardian._testBuildReport(
            port: 18789,
            mode: .local,
            listeners: [(pid: 1, command: "node", fullCommand: "node", user: "me")])
        #expect(okReport.offenders.isEmpty)

        let badReport = PortGuardian._testBuildReport(
            port: 18789,
            mode: .local,
            listeners: [(pid: 2, command: "python", fullCommand: "python", user: "me")])
        #expect(!badReport.offenders.isEmpty)

        let emptyReport = PortGuardian._testBuildReport(port: 18789, mode: .local, listeners: [])
        #expect(emptyReport.summary.contains("Nothing is listening"))
    }

    @Test @MainActor func canvasSchemeHandlerResolvesFilesAndErrors() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("canvas-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        let session = root.appendingPathComponent("main", isDirectory: true)
        try FileManager().createDirectory(at: session, withIntermediateDirectories: true)

        let index = session.appendingPathComponent("index.html")
        try "<h1>Hello</h1>".write(to: index, atomically: true, encoding: .utf8)

        let handler = CanvasSchemeHandler(root: root)
        let url = try #require(CanvasScheme.makeURL(session: "main", path: "index.html"))
        let response = handler._testResponse(for: url)
        #expect(response.mime == "text/html")
        #expect(String(data: response.data, encoding: .utf8)?.contains("Hello") == true)

        let invalid = URL(string: "https://example.com")!
        let invalidResponse = handler._testResponse(for: invalid)
        #expect(invalidResponse.mime == "text/html")

        let missing = try #require(CanvasScheme.makeURL(session: "missing", path: "/"))
        let missingResponse = handler._testResponse(for: missing)
        #expect(missingResponse.mime == "text/html")

        #expect(handler._testTextEncodingName(for: "text/html") == "utf-8")
        #expect(handler._testTextEncodingName(for: "application/octet-stream") == nil)
    }

    @Test @MainActor func menuContextCardInjectorInsertsAndFindsIndex() {
        let injector = MenuContextCardInjector()
        let menu = NSMenu()
        menu.minimumWidth = 280
        menu.addItem(NSMenuItem(title: "Active", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Send Heartbeats", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Quit", action: nil, keyEquivalent: "q"))

        let idx = injector._testFindInsertIndex(in: menu)
        #expect(idx == 1)
        #expect(injector._testInitialCardWidth(for: menu) >= 300)

        injector._testSetCache(rows: [SessionRow.previewRows[0]], errorText: nil, updatedAt: Date())
        injector.menuWillOpen(menu)
        injector.menuDidClose(menu)

        let fallbackMenu = NSMenu()
        fallbackMenu.addItem(NSMenuItem(title: "First", action: nil, keyEquivalent: ""))
        #expect(injector._testFindInsertIndex(in: fallbackMenu) == 1)
    }

    @Test @MainActor func canvasWindowHelperFunctions() {
        #expect(CanvasWindowController._testSanitizeSessionKey("  main ") == "main")
        #expect(CanvasWindowController._testSanitizeSessionKey("bad/..") == "bad___")
        #expect(CanvasWindowController._testJSOptionalStringLiteral(nil) == "null")

        let rect = NSRect(x: 10, y: 12, width: 400, height: 420)
        let key = CanvasWindowController._testStoredFrameKey(sessionKey: "test")
        let loaded = CanvasWindowController._testStoreAndLoadFrame(sessionKey: "test", frame: rect)
        UserDefaults.standard.removeObject(forKey: key)
        #expect(loaded?.size.width == rect.size.width)

        let parsed = CanvasWindowController._testParseIPv4("192.168.1.2")
        #expect(parsed != nil)
        if let parsed {
            #expect(CanvasWindowController._testIsLocalNetworkIPv4(parsed))
        }

        let url = URL(string: "http://192.168.1.2")!
        #expect(CanvasWindowController._testIsLocalNetworkCanvasURL(url))
        #expect(CanvasWindowController._testParseIPv4("not-an-ip") == nil)
    }
}
