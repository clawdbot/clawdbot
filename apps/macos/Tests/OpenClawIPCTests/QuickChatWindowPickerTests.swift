import CoreGraphics
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatWindowPickerTests {
    @Test func `candidate filtering excludes own process and nonregular applications`() {
        let inputs = [
            self.input(id: 1, processID: 100, policy: .regular),
            self.input(id: 2, processID: 200, policy: .accessory),
            self.input(id: 3, processID: 300, policy: .regular),
            self.input(id: 4, processID: 400, policy: .regular, isRenderable: false),
        ]

        let candidates = QuickChatWindowPickerLogic.filterCandidates(
            inputs,
            ownProcessID: 100,
            ownBundleIdentifier: "ai.openclaw",
            excludedWindowIDs: [99])

        #expect(candidates.map(\.windowID) == [3])
    }

    @Test func `hit test selects first topmost candidate`() {
        let bottom = QuickChatWindowCandidate(
            windowID: 2,
            processID: 2,
            bundleIdentifier: "bottom",
            appName: "Bottom",
            title: "Window",
            bounds: CGRect(x: 0, y: 0, width: 200, height: 200))
        let top = QuickChatWindowCandidate(
            windowID: 1,
            processID: 1,
            bundleIdentifier: "top",
            appName: "Top",
            title: "Window",
            bounds: CGRect(x: 50, y: 50, width: 100, height: 100))

        #expect(QuickChatWindowPickerLogic.hitTest([top, bottom], at: CGPoint(x: 75, y: 75))?.windowID == 1)
        #expect(QuickChatWindowPickerLogic.hitTest([top, bottom], at: CGPoint(x: 175, y: 175))?.windowID == 2)
        #expect(QuickChatWindowPickerLogic.hitTest([top, bottom], at: CGPoint(x: 250, y: 250)) == nil)
    }

    @Test func `label combines app and title without empty suffix`() {
        #expect(QuickChatWindowPickerLogic.labelText(appName: "Safari", title: "Docs") == "Safari — Docs")
        #expect(QuickChatWindowPickerLogic.labelText(appName: "Safari", title: "  ") == "Safari")
        #expect(QuickChatWindowPickerLogic.labelText(appName: "Safari", title: "Safari") == "Safari")
    }

    @Test func `area selection normalizes drags from every corner`() throws {
        let expected = CGRect(x: 20, y: 30, width: 80, height: 60)
        let corners = [
            (CGPoint(x: 20, y: 30), CGPoint(x: 100, y: 90)),
            (CGPoint(x: 100, y: 30), CGPoint(x: 20, y: 90)),
            (CGPoint(x: 20, y: 90), CGPoint(x: 100, y: 30)),
            (CGPoint(x: 100, y: 90), CGPoint(x: 20, y: 30)),
        ]

        for (start, end) in corners {
            #expect(try #require(QuickChatAreaPickerLogic.normalizedSelection(from: start, to: end)) == expected)
        }
    }

    @Test func `area selection rejects either tiny dimension`() {
        #expect(QuickChatAreaPickerLogic.normalizedSelection(
            from: CGPoint(x: 0, y: 0),
            to: CGPoint(x: 7.9, y: 40)) == nil)
        #expect(QuickChatAreaPickerLogic.normalizedSelection(
            from: CGPoint(x: 0, y: 0),
            to: CGPoint(x: 40, y: 7.9)) == nil)
        #expect(QuickChatAreaPickerLogic.normalizedSelection(
            from: CGPoint(x: 0, y: 0),
            to: CGPoint(x: 8, y: 8)) != nil)
    }

    @Test func `area coordinates convert between appkit and global display spaces`() {
        let screenFrame = CGRect(x: -1440, y: 200, width: 1440, height: 900)
        let displayBounds = CGRect(x: -1440, y: -200, width: 1440, height: 900)
        let appKitSelection = CGRect(x: -1400, y: 900, width: 400, height: 100)

        #expect(QuickChatAreaPickerLogic.globalDisplayRect(
            appKitRect: appKitSelection,
            screenFrame: screenFrame,
            displayBounds: displayBounds) == CGRect(x: -1400, y: -100, width: 400, height: 100))
    }

    private func input(
        id: Int,
        processID: Int32,
        policy: QuickChatWindowActivationPolicy,
        isRenderable: Bool = true) -> QuickChatWindowCandidateInput
    {
        QuickChatWindowCandidateInput(
            windowID: id,
            processID: processID,
            bundleIdentifier: "app.\(id)",
            appName: "App \(id)",
            title: "Window \(id)",
            bounds: CGRect(x: 0, y: 0, width: 200, height: 100),
            activationPolicy: policy,
            isRenderable: isRenderable)
    }
}
