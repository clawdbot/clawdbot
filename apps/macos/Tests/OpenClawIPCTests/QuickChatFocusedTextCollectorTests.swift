import Testing
@testable import OpenClaw

@Suite(.serialized)
struct QuickChatFocusedTextCollectorTests {
    @Test func `collector collapses adjacent parent-child echoes`() {
        let child = FakeTextNode(id: 2, stringValue: "same", computedName: "other")
        let root = FakeTextNode(id: 1, stringValue: "same", computedName: "same", children: [child])

        let result = QuickChatFocusedTextCollector.collect(root: root)

        #expect(result.text == "same\nother")
        #expect(result.textEntryCount == 2)
        #expect(!result.wasTruncated)
    }

    @Test func `collector preserves equal text from distinct elements`() {
        let cells = (2...4).map { FakeTextNode(id: UInt64($0), stringValue: "42") }
        let root = FakeTextNode(id: 1, stringValue: "table", children: cells)

        let result = QuickChatFocusedTextCollector.collect(root: root)

        #expect(result.text == "table\n42\n42\n42")
        #expect(result.textEntryCount == 4)
    }

    @Test func `collector suppresses echoes from any ancestor`() {
        let grandchild = FakeTextNode(id: 3, stringValue: "same")
        let child = FakeTextNode(id: 2, stringValue: "same", computedName: "middle", children: [grandchild])
        let root = FakeTextNode(id: 1, stringValue: "same", children: [child])

        let result = QuickChatFocusedTextCollector.collect(root: root)

        #expect(result.text == "same\nmiddle")
        #expect(result.textEntryCount == 2)
    }

    @Test func `collector honors cancellation and deadline`() {
        let children = (2...40).map { FakeTextNode(id: UInt64($0), stringValue: "item \($0)") }
        let root = FakeTextNode(id: 1, stringValue: "root", children: children)

        var calls = 0
        let cancelled = QuickChatFocusedTextCollector.collect(root: root, isCancelled: {
            calls += 1
            return calls > 3
        })
        #expect(cancelled.visitedElementCount < children.count)
        #expect(cancelled.wasTruncated)

        let expired = QuickChatFocusedTextCollector.collect(
            root: root,
            deadline: ContinuousClock.now.advanced(by: .seconds(-1)))
        #expect(expired.visitedElementCount == 0)
        #expect(expired.wasTruncated)
    }

    @Test func `collector enforces depth cap`() {
        let deepest = FakeTextNode(id: 3, stringValue: "too deep")
        let child = FakeTextNode(id: 2, stringValue: "child", children: [deepest])
        let root = FakeTextNode(id: 1, stringValue: "root", children: [child])

        let result = QuickChatFocusedTextCollector.collect(
            root: root,
            limits: QuickChatTextCollectionLimits(
                maximumDepth: 1,
                maximumElements: 20,
                maximumCharacters: 100))

        #expect(result.text.contains("root"))
        #expect(result.text.contains("child"))
        #expect(!result.text.contains("too deep"))
        #expect(result.text.hasSuffix(QuickChatFocusedTextCollector.truncationMarker))
        #expect(result.visitedElementCount == 2)
    }

    @Test func `collector enforces element cap`() {
        let children = (2...12).map { FakeTextNode(id: UInt64($0), stringValue: "item \($0)") }
        let root = FakeTextNode(id: 1, stringValue: "root", children: children)

        let result = QuickChatFocusedTextCollector.collect(
            root: root,
            limits: QuickChatTextCollectionLimits(
                maximumDepth: 12,
                maximumElements: 3,
                maximumCharacters: 100))

        #expect(result.visitedElementCount == 3)
        #expect(result.wasTruncated)
        #expect(result.text.hasSuffix(QuickChatFocusedTextCollector.truncationMarker))
    }

    @Test func `collector enforces character cap with marker`() {
        let root = FakeTextNode(id: 1, stringValue: String(repeating: "a", count: 200))

        let result = QuickChatFocusedTextCollector.collect(
            root: root,
            limits: QuickChatTextCollectionLimits(
                maximumDepth: 12,
                maximumElements: 800,
                maximumCharacters: 40))

        #expect(result.text.count == 40)
        #expect(result.text.hasSuffix(QuickChatFocusedTextCollector.truncationMarker))
        #expect(result.wasTruncated)
    }

    @Test func `collector treats the exact sentinel character as truncation`() {
        let root = FakeTextNode(id: 1, stringValue: String(repeating: "a", count: 41))

        let result = QuickChatFocusedTextCollector.collect(
            root: root,
            limits: QuickChatTextCollectionLimits(
                maximumDepth: 12,
                maximumElements: 800,
                maximumCharacters: 40))

        #expect(result.text.count == 40)
        #expect(result.text.hasSuffix(QuickChatFocusedTextCollector.truncationMarker))
        #expect(result.wasTruncated)
    }

    @Test func `collector reports no text when every node is structure-only`() {
        // Mirrors a canvas/image window: nodes expose no textual attributes (the AX
        // adapter now returns nil instead of a role name). textEntryCount must stay 0
        // so the caller surfaces "No readable text" rather than a chip of role words.
        let child = FakeTextNode(id: 2)
        let root = FakeTextNode(id: 1, children: [child])

        let result = QuickChatFocusedTextCollector.collect(root: root)

        #expect(result.text.isEmpty)
        #expect(result.textEntryCount == 0)
    }
}

private final class FakeTextNode: QuickChatTextTreeNode, Sendable {
    let identity: UInt64
    let storedStringValue: String?
    let storedComputedName: String?
    let childNodes: [FakeTextNode]

    init(
        id: UInt64,
        stringValue: String? = nil,
        computedName: String? = nil,
        children: [FakeTextNode] = [])
    {
        self.identity = id
        self.storedStringValue = stringValue
        self.storedComputedName = computedName
        self.childNodes = children
    }

    func stringValue() -> String? {
        self.storedStringValue
    }

    func computedName() -> String? {
        self.storedComputedName
    }

    func children(limit: Int) -> QuickChatTextTreeChildren {
        QuickChatTextTreeChildren(
            nodes: Array(self.childNodes.prefix(limit)),
            wasTruncated: self.childNodes.count > limit)
    }
}
