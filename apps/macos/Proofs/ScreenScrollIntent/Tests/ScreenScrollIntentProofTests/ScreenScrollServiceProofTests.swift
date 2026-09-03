import enum AXorcist.MouseButton
import enum AXorcist.SpecialKey
import CoreGraphics
import Foundation
import PeekabooFoundation
import Testing
@testable import PeekabooAutomationKit

/// Hand-written requests diagnose the pinned dependency; the separate source guard protects
/// OpenClaw's caller. Nothing here claims execution of ComputerScreenActionExecutor.
@Suite(.serialized)
@MainActor
struct ScreenScrollServiceProofTests {
    @Test func `legacy global request dispatches ticks`() async throws {
        try await Self.withService { service, driver in
            do {
                try await service.scroll(ScrollRequest(direction: .down, amount: 3))
            } catch let error as PeekabooError {
                if case .snapshotStale = error, driver.events.isEmpty {
                    print("SCREEN_SCROLL_SERVICE_RED: snapshotStale; emittedTicks=0; pointerMoves=0")
                }
                throw error
            }
            #expect(driver.events == Self.expectedTicks)
        }
    }

    @Test func `foreground global request dispatches ticks`() async throws {
        try await Self.withService { service, driver in
            try await service.scroll(ScrollRequest(direction: .down, amount: 3, foreground: true))
            #expect(driver.events == Self.expectedTicks)
            print("SCREEN_SCROLL_FOREGROUND_CHECKED: three downward ticks; no pointer moves")
        }
    }

    @Test func `background requires snapshot and target even with synth only policy`() async throws {
        try await Self.withService(inputPolicy: UIInputPolicy(defaultStrategy: .synthOnly)) { service, driver in
            let snapshot = "ps1_0123456789abcdef0123456789abcdef"
            let requests = [
                ScrollRequest(direction: .down, amount: 3, foreground: false),
                ScrollRequest(direction: .down, amount: 3, target: "S1", foreground: false),
                ScrollRequest(direction: .down, amount: 3, snapshotId: snapshot, foreground: false),
                ScrollRequest(direction: .down, amount: 3, target: " ", snapshotId: snapshot, foreground: false),
            ]
            for request in requests {
                do {
                    try await service.scroll(request)
                    Issue.record("Background scroll accepted a missing target or snapshot")
                } catch let error as PeekabooError {
                    guard case .snapshotStale = error else { throw error }
                }
                #expect(driver.events.isEmpty)
            }
            print("SCREEN_SCROLL_BACKGROUND_CHECKED: four refusals; no synthetic input")
        }
    }

    private static var expectedTicks: [ScrollInputRecorder.Event] {
        [.currentLocation] + Array(repeating: .scroll(0, -50, ScrollInputRecorder.pointer), count: 3)
    }

    private static func withService(
        inputPolicy: UIInputPolicy = .currentBehavior,
        body: (UIAutomationService, ScrollInputRecorder) async throws -> Void) async throws
    {
        let environment = ProcessInfo.processInfo.environment
        try #require(
            environment["GITHUB_ACTIONS"] == "true" && environment["RUNNER_ENVIRONMENT"] == "github-hosted",
            "Run this proof only on the disposable GitHub-hosted macOS workflow; never fabricate CI markers")
        let laneRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("screen-scroll-proof-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(
            at: laneRoot,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: laneRoot) }
        let driver = ScrollInputRecorder()
        let service = UIAutomationService(
            snapshotManager: InMemorySnapshotManager(),
            inputPolicy: inputPolicy,
            actionInputDriver: ActionInputDriver(),
            syntheticInputDriver: driver,
            automationElementResolver: AutomationElementResolver(),
            feedbackClient: NoopAutomationFeedbackClient(),
            operationLaneCoordinator: DesktopOperationLaneCoordinator(coordinationRootURL: laneRoot))
        try await body(service, driver)
    }
}

@MainActor
private final class ScrollInputRecorder: SyntheticInputDriving {
    enum Event: Equatable {
        case currentLocation
        case move(CGPoint)
        case scroll(Double, Double, CGPoint?)
    }

    private struct UnexpectedInput: Error {}

    static let pointer = CGPoint(x: 120, y: 240)
    private(set) var events: [Event] = []

    func currentLocation() -> CGPoint? {
        self.events.append(.currentLocation)
        return Self.pointer
    }

    func move(to point: CGPoint) throws {
        self.events.append(.move(point))
    }

    func scroll(deltaX: Double, deltaY: Double, at point: CGPoint?) throws {
        self.events.append(.scroll(deltaX, deltaY, point))
    }

    func click(at _: CGPoint, button _: MouseButton, count _: Int) throws -> DesktopActionOutcome {
        throw UnexpectedInput()
    }

    func click(
        at _: CGPoint,
        button _: MouseButton,
        count _: Int,
        targetProcessIdentifier _: pid_t) async throws -> DesktopActionOutcome
    {
        throw UnexpectedInput()
    }

    func pressHold(at _: CGPoint, button _: MouseButton, duration _: TimeInterval) async throws {
        throw UnexpectedInput()
    }

    func type(_: String, delayPerCharacter _: TimeInterval) throws {
        throw UnexpectedInput()
    }

    func tapKey(_: SpecialKey, modifiers _: CGEventFlags) throws {
        throw UnexpectedInput()
    }

    func hotkey(keys _: [String], holdDuration _: TimeInterval) throws {
        throw UnexpectedInput()
    }
}
