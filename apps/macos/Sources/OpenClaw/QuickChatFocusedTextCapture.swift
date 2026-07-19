import AppKit
@preconcurrency import ApplicationServices
import Foundation

struct QuickChatTextContext: Equatable, Sendable {
    let appName: String
    let windowTitle: String
    let text: String

    var characterCount: Int {
        self.text.count
    }
}

struct QuickChatTextCollectionLimits: Equatable, Sendable {
    static let standard = QuickChatTextCollectionLimits(
        maximumDepth: 12,
        maximumElements: 800,
        maximumCharacters: 20000)

    let maximumDepth: Int
    let maximumElements: Int
    let maximumCharacters: Int
}

struct QuickChatTextCollection: Equatable, Sendable {
    let text: String
    let visitedElementCount: Int
    let textEntryCount: Int
    let wasTruncated: Bool
}

struct QuickChatTextTreeChildren: Sendable {
    let nodes: [any QuickChatTextTreeNode]
    let wasTruncated: Bool
}

protocol QuickChatTextTreeNode: Sendable {
    var identity: UInt64 { get }
    func stringValue() -> String?
    func computedName() -> String?
    func children(limit: Int) -> QuickChatTextTreeChildren
}

private enum QuickChatCaptureRaceResult: Sendable {
    case snapshot(String, QuickChatTextCollection)
    case timedOut
    case cancelled
}

/// Synchronous one-shot arbitration lets a cancellation handler settle the AX race
/// immediately, including when cancellation wins before the continuation is installed.
private final class QuickChatCaptureRace: @unchecked Sendable {
    private let lock = NSLock()
    private var result: QuickChatCaptureRaceResult?
    private var continuation: CheckedContinuation<QuickChatCaptureRaceResult, Never>?

    func wait() async -> QuickChatCaptureRaceResult {
        await withCheckedContinuation { continuation in
            self.lock.lock()
            if let result = self.result {
                self.lock.unlock()
                continuation.resume(returning: result)
            } else {
                self.continuation = continuation
                self.lock.unlock()
            }
        }
    }

    @discardableResult
    func resolve(_ result: QuickChatCaptureRaceResult) -> Bool {
        self.lock.lock()
        guard self.result == nil else {
            self.lock.unlock()
            return false
        }
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        self.lock.unlock()
        continuation?.resume(returning: result)
        return true
    }
}

enum QuickChatFocusedTextCollector {
    static let truncationMarker = String(localized: "… [truncated]")

    static func collect(
        root: any QuickChatTextTreeNode,
        limits: QuickChatTextCollectionLimits = .standard,
        deadline: ContinuousClock.Instant? = nil,
        isCancelled: () -> Bool = { false }) -> QuickChatTextCollection
    {
        let maximumDepth = max(0, limits.maximumDepth)
        let maximumElements = max(1, limits.maximumElements)
        let maximumCharacters = max(1, limits.maximumCharacters)
        var stack: [(node: any QuickChatTextTreeNode, depth: Int, parentTexts: [String])] = [(root, 0, [])]
        var visitedNodeIDs = Set<UInt64>()
        var rendered = ""
        var visitedElementCount = 0
        var textEntryCount = 0
        var wasStructurallyTruncated = false
        var wasTextTruncated = false

        traversal: while let next = stack.popLast() {
            // Unresponsive AX targets can stall per-message; a wall-clock deadline and
            // cooperative cancellation keep the walk bounded regardless of app health.
            if isCancelled() || deadline.map({ ContinuousClock.now >= $0 }) == true {
                wasStructurallyTruncated = true
                break
            }
            guard visitedNodeIDs.insert(next.node.identity).inserted else { continue }
            guard visitedElementCount < maximumElements else {
                wasStructurallyTruncated = true
                break
            }
            visitedElementCount += 1

            // Suppress only the parent/child echo (an element repeating its ancestor's
            // text) and same-node repeats; equal text from siblings (table cells,
            // repeated lines) is real document content and must be preserved.
            var ownTexts: [String] = []
            for rawCandidate in [next.node.stringValue(), next.node.computedName()] {
                guard let candidate = Self.normalized(rawCandidate),
                      !next.parentTexts.contains(candidate),
                      !ownTexts.contains(candidate)
                else { continue }
                ownTexts.append(candidate)
                let piece = rendered.isEmpty ? candidate : "\n\(candidate)"
                let remaining = maximumCharacters + 1 - rendered.count
                guard remaining > 0 else {
                    wasTextTruncated = true
                    break traversal
                }
                rendered.append(contentsOf: piece.prefix(remaining))
                textEntryCount += 1
                if piece.count >= remaining {
                    wasTextTruncated = true
                    break traversal
                }
            }

            if next.depth >= maximumDepth {
                let overflow = next.node.children(limit: 1)
                if !overflow.nodes.isEmpty || overflow.wasTruncated {
                    wasStructurallyTruncated = true
                }
                continue
            }

            let remainingElements = maximumElements - visitedElementCount
            let childResult = next.node.children(limit: max(1, remainingElements))
            if childResult.wasTruncated {
                wasStructurallyTruncated = true
            }
            let descendantTexts = next.parentTexts + ownTexts.filter { !next.parentTexts.contains($0) }
            for child in childResult.nodes.reversed() {
                stack.append((child, next.depth + 1, descendantTexts))
            }
        }

        if !stack.isEmpty {
            wasStructurallyTruncated = true
        }
        let wasTruncated = wasStructurallyTruncated || wasTextTruncated
        if wasTruncated {
            rendered = Self.appendingTruncationMarker(to: rendered, maximumCharacters: maximumCharacters)
        }
        return QuickChatTextCollection(
            text: rendered,
            visitedElementCount: visitedElementCount,
            textEntryCount: textEntryCount,
            wasTruncated: wasTruncated)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func appendingTruncationMarker(to text: String, maximumCharacters: Int) -> String {
        guard maximumCharacters > self.truncationMarker.count else {
            return String(self.truncationMarker.prefix(maximumCharacters))
        }
        let bodyLimit = maximumCharacters - Self.truncationMarker.count
        return String(text.prefix(bodyLimit)) + Self.truncationMarker
    }
}

enum QuickChatTextContextCaptureOutcome: Sendable {
    case captured(QuickChatTextContext)
    case failed(String)
    case cancelled
}

@MainActor
enum QuickChatFocusedTextCaptureService {
    static func frontmostApplicationName() -> String {
        NSWorkspace.shared.frontmostApplication?.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty ?? String(localized: "focused app")
    }

    static func capture() async -> QuickChatTextContextCaptureOutcome {
        guard let application = NSWorkspace.shared.frontmostApplication else {
            return .failed(String(localized: "No focused application is available."))
        }
        let appName = application.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? application.bundleIdentifier
            ?? String(localized: "Focused app")
        guard application.processIdentifier != getpid(),
              application.bundleIdentifier != Bundle.main.bundleIdentifier
        else {
            return .failed(String(localized: "Focus another app before attaching its text."))
        }

        let hasPermission = await PermissionManager.status([.accessibility])[.accessibility] == true
        guard !Task.isCancelled else { return .cancelled }
        guard hasPermission else {
            guard self.confirmAccessibilityRequest(appName: appName) else { return .cancelled }
            guard !Task.isCancelled else { return .cancelled }
            let result = await PermissionManager.ensure([.accessibility], interactive: true)
            guard !Task.isCancelled else { return .cancelled }
            guard result[.accessibility] == true else {
                return .failed(String(localized: "Accessibility access is required to attach text from \(appName)."))
            }
            return await self.capture(application: application, appName: appName)
        }
        return await self.capture(application: application, appName: appName)
    }

    private static func capture(
        application: NSRunningApplication,
        appName: String) async -> QuickChatTextContextCaptureOutcome
    {
        guard !Task.isCancelled else { return .cancelled }
        let appElement = AXUIElementCreateApplication(application.processIdentifier)
        // Bound the very first read too; the focused-window copy below otherwise waits
        // for the system default (~6s) on a hung target.
        AXUIElementSetMessagingTimeout(appElement, 1.0)
        var focusedWindowValue: CFTypeRef?
        let focusedWindowError = AXUIElementCopyAttributeValue(
            appElement,
            kAXFocusedWindowAttribute as CFString,
            &focusedWindowValue)
        guard focusedWindowError == .success,
              let focusedWindowValue,
              CFGetTypeID(focusedWindowValue) == AXUIElementGetTypeID()
        else {
            return .failed(String(localized: "No focused window is available in \(appName)."))
        }
        let focusedWindow = unsafeDowncast(focusedWindowValue, to: AXUIElement.self)
        // A hung target app would otherwise block each AX message for the system default
        // (~6s); a short per-message timeout keeps worst-case walks near the deadline.
        let root = QuickChatAXTextTreeNode(element: focusedWindow)

        // AX reads are synchronous and can be expensive. Keep the bounded walk off the
        // main actor; this adapter never logs or persists attribute values. The walk
        // itself checks cancellation and a 3s wall-clock deadline per iteration.
        let walk = Task.detached(priority: .userInitiated) {
            let title = root.title()?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? String(localized: "Focused Window")
            let collection = QuickChatFocusedTextCollector.collect(
                root: root,
                deadline: ContinuousClock.now.advanced(by: .seconds(3)),
                isCancelled: { Task.isCancelled })
            return (title, collection)
        }
        // Hard outer bound: a hung target can stall individual AX reads past any
        // cooperative check. A structured group would JOIN the losing child (and thus
        // still wait for the walk), so the race is unstructured: first result wins the
        // continuation, the abandoned walk is cancelled and its result discarded.
        let race = QuickChatCaptureRace()
        Task.detached {
            let value = await walk.value
            race.resolve(.snapshot(value.0, value.1))
        }
        let timeout = Task.detached {
            try? await Task.sleep(for: .seconds(4))
            if race.resolve(.timedOut) {
                walk.cancel()
            }
        }
        let result = await withTaskCancellationHandler {
            await race.wait()
        } onCancel: {
            walk.cancel()
            race.resolve(.cancelled)
        }
        timeout.cancel()

        switch result {
        case .cancelled:
            return .cancelled
        case .timedOut:
            walk.cancel()
            return .failed(String(localized: "\(appName) is not responding to Accessibility requests."))
        case let .snapshot(title, collection):
            guard collection.textEntryCount > 0 else {
                return .failed(String(localized: "No readable text was found in \(appName)."))
            }
            return .captured(QuickChatTextContext(
                appName: appName,
                windowTitle: title,
                text: collection.text))
        }
    }

    private static func confirmAccessibilityRequest(appName: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = String(localized: "Allow OpenClaw to read text from \(appName)")
        alert.informativeText = String(localized: "Attaching focused-window text uses macOS Accessibility access.")
        alert.addButton(withTitle: String(localized: "Grant Access"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        // User-initiated confirmation owns the only path that may trigger the TCC prompt.
        return alert.runModal() == .alertFirstButtonReturn
    }
}

private struct QuickChatAXTextTreeNode: QuickChatTextTreeNode, Sendable {
    let element: AXUIElement

    init(element: AXUIElement) {
        // Messaging timeouts are per element reference; every wrapped descendant needs
        // its own or an unresponsive target stalls each read for the system default.
        AXUIElementSetMessagingTimeout(element, 1.0)
        self.element = element
    }

    var identity: UInt64 {
        UInt64(CFHash(self.element))
    }

    func stringValue() -> String? {
        self.stringAttribute(kAXValueAttribute)
    }

    func computedName() -> String? {
        let candidates = [
            kAXTitleAttribute,
            kAXValueAttribute,
            kAXIdentifierAttribute,
            kAXDescriptionAttribute,
            kAXHelpAttribute,
            kAXPlaceholderValueAttribute,
        ]
        for attribute in candidates {
            if let value = self.stringAttribute(attribute)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty
            {
                return value
            }
        }
        // Deliberately no AX-role fallback: a role name like "Window"/"Group" is structure,
        // not readable content. Emitting it would count toward textEntryCount and let a
        // canvas/image-only window send a chip of role words instead of failing with
        // "No readable text".
        return nil
    }

    func children(limit: Int) -> QuickChatTextTreeChildren {
        let attributes = [
            kAXChildrenAttribute,
            kAXVisibleChildrenAttribute,
            "AXChildrenInNavigationOrder",
            kAXRowsAttribute,
            kAXContentsAttribute,
        ]
        let resolvedLimit = max(1, limit)
        var nodes: [any QuickChatTextTreeNode] = []
        var seen = Set<UInt64>()
        var wasTruncated = false

        for attribute in attributes {
            var count: CFIndex = 0
            guard AXUIElementGetAttributeValueCount(
                self.element,
                attribute as CFString,
                &count) == .success,
                count > 0
            else { continue }
            let remaining = resolvedLimit - nodes.count
            guard remaining > 0 else {
                wasTruncated = true
                break
            }
            if count > remaining {
                wasTruncated = true
            }
            var values: CFArray?
            guard AXUIElementCopyAttributeValues(
                self.element,
                attribute as CFString,
                0,
                min(count, remaining),
                &values) == .success,
                let elements = values as? [AXUIElement]
            else { continue }
            for element in elements {
                let node = QuickChatAXTextTreeNode(element: element)
                if seen.insert(node.identity).inserted {
                    nodes.append(node)
                }
            }
        }
        return QuickChatTextTreeChildren(nodes: nodes, wasTruncated: wasTruncated)
    }

    func title() -> String? {
        self.stringAttribute(kAXTitleAttribute)
    }

    private func stringAttribute(_ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            self.element,
            attribute as CFString,
            &value) == .success
        else { return nil }
        return value as? String
    }
}
