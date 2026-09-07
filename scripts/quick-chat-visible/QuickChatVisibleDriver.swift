import AppKit
import ApplicationServices
import Foundation
@preconcurrency import ScreenCaptureKit

struct DriverCommand: Decodable {
    let id: String
    let action: String
    let text: String?
    let name: String?
}

enum DriverFailure: Error {
    case stopped(String)
}

@MainActor
final class QuickChatVisibleDriver {
    let executable: URL
    let evidence: URL
    let application = Process()
    var accessibilityApplication: AXUIElement?
    var panel: AXUIElement?
    var activeModelMenu: AXUIElement?
    var opened = false
    var typedDraft = false

    init(executable: URL, evidence: URL) {
        self.executable = executable
        self.evidence = evidence
    }

    func emit(_ value: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }

    func permissionProbe() throws {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let console = session?[kCGSessionOnConsoleKey as String] as? Bool == true
        let accessibility = AXIsProcessTrusted()
        let posting = CGPreflightPostEventAccess()
        let capture = CGPreflightScreenCaptureAccess()
        try self.emit([
            "kind": "permission-probe",
            "pid": ProcessInfo.processInfo.processIdentifier,
            "executable": CommandLine.arguments[0],
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "consoleSession": console,
            "displayCount": NSScreen.screens.count,
            "accessibility": accessibility,
            "eventPosting": posting,
            "screenCapture": capture,
        ])
        guard console, !NSScreen.screens.isEmpty, accessibility, posting, capture else {
            throw DriverFailure.stopped("GUI session or existing control/capture grant unavailable; no permission requested")
        }
    }

    func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
        var result: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &result)
        if status == .noValue || status == .attributeUnsupported { return nil }
        guard status == .success else {
            throw DriverFailure.stopped("AX attribute \(name) failed: \(status.rawValue)")
        }
        return result
    }

    func text(_ element: AXUIElement, _ name: String) throws -> String? {
        try self.attribute(element, name) as? String
    }

    func tree(_ root: AXUIElement) throws -> [AXUIElement] {
        var pending = [root]
        var visited: [AXUIElement] = []
        while !pending.isEmpty {
            let current = pending.removeLast()
            if visited.contains(where: { CFEqual($0, current) }) { continue }
            visited.append(current)
            let children = try self.attribute(current, kAXChildrenAttribute) as? [AXUIElement] ?? []
            pending.append(contentsOf: children.reversed())
        }
        return visited
    }

    func windows() throws -> [AXUIElement] {
        guard self.application.isRunning, let root = self.accessibilityApplication else {
            throw DriverFailure.stopped("Owned normal app is not running")
        }
        return try self.attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
    }

    func modelControl(in window: AXUIElement) throws -> AXUIElement? {
        for element in try self.tree(window) {
            if try self.text(element, kAXRoleAttribute) == kAXButtonRole,
               try self.text(element, kAXDescriptionAttribute) == "Model and reasoning"
            {
                return element
            }
        }
        return nil
    }

    func currentPanel() throws -> AXUIElement {
        guard let panel = self.panel,
              try self.windows().contains(where: { CFEqual($0, panel) }),
              try self.modelControl(in: panel) != nil
        else {
            throw DriverFailure.stopped("Original Quick Chat presentation no longer exists; will not reopen")
        }
        return panel
    }

    func requireFocus() throws {
        guard self.application.isRunning,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == self.application.processIdentifier
        else { throw DriverFailure.stopped("Owned app is not frontmost; input withheld") }
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
            throw DriverFailure.stopped("Control permission no longer available")
        }
    }

    func key(_ code: CGKeyCode, flags: CGEventFlags = []) throws {
        try self.requireFocus()
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
                throw DriverFailure.stopped("Keyboard event could not be created")
            }
            event.flags = flags
            event.post(tap: .cghidEventTap)
        }
    }

    func press(_ element: AXUIElement) throws {
        try self.requireFocus()
        let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard status == .success else {
            throw DriverFailure.stopped("AXPress failed: \(status.rawValue)")
        }
    }

    func start() async throws {
        try self.permissionProbe()
        guard !self.application.isRunning else { throw DriverFailure.stopped("App already started") }
        guard FileManager.default.isExecutableFile(atPath: self.executable.path) else {
            throw DriverFailure.stopped("Exact prebuilt normal executable is absent")
        }
        let output = self.evidence.appendingPathComponent("normal-app.log")
        guard FileManager.default.createFile(atPath: output.path, contents: nil) else {
            throw DriverFailure.stopped("Cannot create normal app output")
        }
        let log = try FileHandle(forWritingTo: output)
        self.application.executableURL = self.executable
        self.application.arguments = ["--attach-only", "--no-launchd", "--background-only"]
        self.application.environment = ProcessInfo.processInfo.environment
        self.application.standardInput = FileHandle.nullDevice
        self.application.standardOutput = log
        self.application.standardError = log
        try self.application.run()
        try log.close()
        let root = AXUIElementCreateApplication(self.application.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 2)
        self.accessibilityApplication = root
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            guard self.application.isRunning else {
                throw DriverFailure.stopped("Normal app exited during readiness")
            }
            if let running = NSRunningApplication(processIdentifier: self.application.processIdentifier),
               running.isFinishedLaunching,
               running.activate(options: [])
            {
                try self.emit(["kind": "normal-app-started", "pid": self.application.processIdentifier])
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw DriverFailure.stopped("Normal app readiness deadline reached")
    }

    func openQuickChat() async throws {
        guard !self.opened else { throw DriverFailure.stopped("Quick Chat cannot be reopened in this sequence") }
        self.opened = true
        try self.key(49, flags: .maskAlternate)
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            for window in try self.windows() {
                if try self.modelControl(in: window) != nil {
                    self.panel = window
                    return
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw DriverFailure.stopped("Option-Space did not expose a real Quick Chat model control")
    }

    func waitForModelControl() async throws {
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            let window = try self.currentPanel()
            if let control = try self.modelControl(in: window),
               try self.attribute(control, kAXEnabledAttribute) as? Bool == true
            {
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw DriverFailure.stopped("Real model control did not become enabled")
    }

    func typeDraft(_ value: String) async throws {
        guard !self.typedDraft, !value.contains("\n"), !value.contains("\r") else {
            throw DriverFailure.stopped("Draft input must be a single unsent first insertion")
        }
        let window = try self.currentPanel()
        let editors = try self.tree(window).filter { try self.text($0, kAXRoleAttribute) == kAXTextAreaRole }
        guard editors.count == 1, let editor = editors.first else {
            throw DriverFailure.stopped("Quick Chat editable text view is not unique")
        }
        let focused = AXUIElementSetAttributeValue(editor, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard focused == .success else { throw DriverFailure.stopped("Draft focus failed: \(focused.rawValue)") }
        try self.requireFocus()
        let characters = Array(value.utf16)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else {
                throw DriverFailure.stopped("Draft event creation failed")
            }
            characters.withUnsafeBufferPointer { buffer in
                if let base = buffer.baseAddress {
                    event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
                }
            }
            event.post(tap: .cghidEventTap)
        }
        self.typedDraft = true
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if let inserted = try self.text(editor, kAXValueAttribute), !inserted.isEmpty {
                try self.emit(["kind": "draft-input-readback", "text": inserted])
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw DriverFailure.stopped("Draft input did not reach the editable text view")
    }

    func menus() throws -> [AXUIElement] {
        guard let root = self.accessibilityApplication else { throw DriverFailure.stopped("Missing app identity") }
        var elements = try self.tree(root)
        for window in try self.windows() { elements.append(contentsOf: try self.tree(window)) }
        return try elements.filter { try self.text($0, kAXRoleAttribute) == kAXMenuRole }
    }

    func openProvider(_ title: String) throws {
        guard let menu = self.activeModelMenu else { throw DriverFailure.stopped("Real model menu is not open") }
        for item in try self.tree(menu) {
            if try self.text(item, kAXRoleAttribute) == kAXMenuItemRole,
               try self.text(item, kAXTitleAttribute) == title
            {
                try self.press(item)
                return
            }
        }
        throw DriverFailure.stopped("Requested provider submenu is absent")
    }

    func openModelMenu() async throws {
        guard self.activeModelMenu == nil else { throw DriverFailure.stopped("Previous model menu has not closed") }
        try await self.waitForModelControl()
        let panel = try self.currentPanel()
        guard let control = try self.modelControl(in: panel) else { throw DriverFailure.stopped("Model control absent") }
        try self.press(control)
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            for menu in try self.menus() {
                let titles = try self.tree(menu).compactMap { try self.text($0, kAXTitleAttribute) }
                if titles.contains("Session default"), titles.contains("Reasoning") {
                    self.activeModelMenu = menu
                    return
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw DriverFailure.stopped("Actual model menu did not appear")
    }

    func dismissMenu() throws {
        guard let menu = self.activeModelMenu else { throw DriverFailure.stopped("No owned model menu to cancel") }
        var actions: CFArray?
        let status = AXUIElementCopyActionNames(menu, &actions)
        guard status == .success, let available = actions as? [String], available.contains(kAXCancelAction) else {
            throw DriverFailure.stopped("Owned menu does not expose AXCancel; no Escape or panel-dismiss fallback")
        }
        let cancelled = AXUIElementPerformAction(menu, kAXCancelAction as CFString)
        guard cancelled == .success else { throw DriverFailure.stopped("Model menu cancellation failed: \(cancelled.rawValue)") }
        self.activeModelMenu = nil
        _ = try self.currentPanel()
    }

    func capture(_ name: String) async throws {
        guard !name.isEmpty, name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else {
            throw DriverFailure.stopped("Invalid capture name")
        }
        _ = try self.currentPanel()
        guard CGPreflightScreenCaptureAccess() else { throw DriverFailure.stopped("Capture permission unavailable") }
        let content = try await SCShareableContent.current
        guard content.displays.count == 1, let display = content.displays.first,
              let owner = content.applications.first(where: { $0.processID == self.application.processIdentifier })
        else { throw DriverFailure.stopped("Expected single-display owned app capture is unavailable") }
        let filter = SCContentFilter(display: display, including: [owner], exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        configuration.showsCursor = false
        let picture = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard let data = NSBitmapImageRep(cgImage: picture).representation(using: .png, properties: [:]) else {
            throw DriverFailure.stopped("PNG encoding failed")
        }
        try data.write(to: self.evidence.appendingPathComponent("quick-chat-\(name).png"), options: .withoutOverwriting)
        var records: [[String: Any]] = []
        guard let root = self.accessibilityApplication else { throw DriverFailure.stopped("App identity lost") }
        let roots = [root] + (try self.windows())
        var elements: [AXUIElement] = []
        for treeRoot in roots {
            for element in try self.tree(treeRoot) {
                if !elements.contains(where: { CFEqual($0, element) }) { elements.append(element) }
            }
        }
        for (index, element) in elements.enumerated() {
            var record: [String: Any] = [:]
            record["index"] = index
            let children = try self.attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            record["children"] = children.compactMap { child in elements.firstIndex(where: { CFEqual($0, child) }) }
            for attribute in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                if let value = try self.text(element, attribute) { record[attribute] = value }
            }
            for attribute in [kAXEnabledAttribute, kAXFocusedAttribute] {
                if let value = try self.attribute(element, attribute) as? Bool { record[attribute] = value }
            }
            records.append(record)
        }
        let observation: [String: Any] = [
            "name": name,
            "pid": self.application.processIdentifier,
            "sameAccessibilityPanel": true,
            "windowIDs": content.windows.filter { $0.owningApplication?.processID == self.application.processIdentifier }.map(\.windowID),
            "roots": roots.compactMap { treeRoot in elements.firstIndex(where: { CFEqual($0, treeRoot) }) },
            "accessibility": records,
        ]
        try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys, .prettyPrinted])
            .write(to: self.evidence.appendingPathComponent("quick-chat-\(name).json"), options: .withoutOverwriting)
    }

    func stop() async throws {
        guard self.application.isRunning else { return }
        self.application.terminate()
        let deadline = Date().addingTimeInterval(5)
        while self.application.isRunning, Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        guard !self.application.isRunning else {
            throw DriverFailure.stopped("App termination incomplete; outer process-tree owner must retain evidence")
        }
        try self.emit(["kind": "normal-app-exit", "status": self.application.terminationStatus])
    }
}

@main
struct QuickChatDriverMain {
    @MainActor
    static func main() async {
        guard CommandLine.arguments.count == 3 else {
            fputs("Expected exact normal executable and evidence directory\n", stderr)
            exit(2)
        }
        let driver = QuickChatVisibleDriver(
            executable: URL(fileURLWithPath: CommandLine.arguments[1]),
            evidence: URL(fileURLWithPath: CommandLine.arguments[2]))
        do {
            try driver.permissionProbe()
            try driver.emit(["kind": "ready-for-command"])
            while let line = readLine() {
                let command = try JSONDecoder().decode(DriverCommand.self, from: Data(line.utf8))
                switch command.action {
                case "start": try await driver.start()
                case "open": try await driver.openQuickChat()
                case "ready": try await driver.waitForModelControl()
                case "draft":
                    guard let text = command.text else { throw DriverFailure.stopped("Draft text is required") }
                    try await driver.typeDraft(text)
                case "model-menu": try await driver.openModelMenu()
                case "provider":
                    guard let title = command.text else { throw DriverFailure.stopped("Provider title required") }
                    try driver.openProvider(title)
                case "dismiss-menu": try driver.dismissMenu()
                case "capture":
                    guard let name = command.name else { throw DriverFailure.stopped("Capture name required") }
                    try await driver.capture(name)
                case "stop": try await driver.stop()
                default: throw DriverFailure.stopped("Unsupported driver action")
                }
                try driver.emit(["kind": "action-completed", "id": command.id, "action": command.action])
                if command.action == "stop" { return }
            }
            throw DriverFailure.stopped("Control input closed before stop")
        } catch {
            try? driver.emit(["kind": "stop", "reason": String(describing: error)])
            do { try await driver.stop() } catch { fputs("\(error)\n", stderr) }
            exit(1)
        }
    }
}
