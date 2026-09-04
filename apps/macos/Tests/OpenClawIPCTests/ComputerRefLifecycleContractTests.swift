import CoreGraphics
import Foundation
import OpenClawKit
import PeekabooAutomationKit
import Testing
@testable import OpenClaw

/// Drives the real `ComputerWindowActionExecutor` reference lifecycle through the same
/// case table the CUA provider runs in `ref-lifecycle.contract.test.ts`, so the two
/// providers cannot drift apart on what an opaque ref means.
@MainActor
struct ComputerRefLifecycleContractTests {
    private struct Contract: Decodable {
        let staleErrorCode: String
        let cases: [Case]
    }

    private struct Case: Decodable {
        let id: String
        let scenario: Scenario
        let expected: Expected
    }

    private enum Scenario: String, Decodable {
        case freshWindow = "fresh_window"
        case freshElement = "fresh_element"
        case windowMoved = "window_moved"
        case generationRotation = "generation_rotation"
        case inFlightGenerationChange = "in_flight_generation_change"
        case supersededObservation = "superseded_observation"
        case unrelatedDiscovery = "unrelated_discovery"
        case unknownRef = "unknown_ref"
    }

    private enum Expected: String, Decodable {
        case valid
        case stale
    }

    private static let app = ServiceApplicationInfo(
        processIdentifier: 4321,
        processStartIdentity: 90210,
        bundleIdentifier: "com.example.contract",
        name: "Contract",
        windowCount: 1)

    private static let originalBounds = CGRect(x: 0, y: 0, width: 400, height: 300)
    private static let movedBounds = CGRect(x: 120, y: 80, width: 640, height: 480)

    @Test func `Peekaboo satisfies the shared ref lifecycle cases`() async throws {
        let contract = try Self.loadContract()

        for testCase in contract.cases {
            let error = await self.run(testCase)
            switch testCase.expected {
            case .valid:
                #expect(error == nil, "\(testCase.id) unexpectedly failed: \(String(describing: error))")
            case .stale:
                #expect(
                    error?.localizedDescription.hasPrefix("\(contract.staleErrorCode):") == true,
                    "\(testCase.id) returned \(String(describing: error))")
            }
        }
    }

    @Test func `execution close clears only the native owners snapshot manager`() async throws {
        try await MacNodeComputerExecutionFixture.runWithRoute { route in
            let manager = InMemorySnapshotManager()
            let sibling = InMemorySnapshotManager()
            let queue = ComputerActionExecutionQueue()
            let service = ComputerActionService(executionQueue: queue, snapshotManager: manager)
            queue.installCleanup(
                release: { service.releaseHeldInput() },
                invalidate: { try await service.invalidateReferences() })
            let executionId = UUID()
            let owned = try await queue.perform(
                executionId: executionId,
                route: route,
                checkAuthority: {},
                operation: { _ in try await manager.createSnapshot() })
            let unrelated = try await sibling.createSnapshot()
            #expect(try await manager.ownsSnapshot(snapshotId: owned))

            #expect(try await queue.closeExecution(executionId, route: route, retireUnowned: true))

            #expect(try await !manager.ownsSnapshot(snapshotId: owned))
            #expect(await manager.getMostRecentSnapshot() == nil)
            #expect(try await sibling.ownsSnapshot(snapshotId: unrelated))
        }
    }

    @Test func `execution cleanup invalidates window and observation references without a generation change`() throws {
        let executor = ComputerWindowActionExecutor(snapshotManager: InMemorySnapshotManager())
        executor.adoptLifecycleGeneration(1)
        let window = executor.issueWindowRef(
            app: Self.app,
            window: Self.window(windowID: 77, bounds: Self.originalBounds))
        let observation = executor.issueObservation(windowRef: window, snapshotId: "synthetic-snapshot", elements: [])
        executor.clearReferences()
        #expect(throws: ComputerActionService.ComputerActionError.self) { try executor.resolveWindow(window) }
        #expect(throws: ComputerActionService.ComputerActionError.self) {
            try executor.resolveObservation(observation.id, windowRef: window)
        }
    }

    private func run(_ testCase: Case) async -> Error? {
        let service = ComputerWindowActionExecutor(snapshotManager: InMemorySnapshotManager())
        service.adoptLifecycleGeneration(1)
        let windowRef = service.issueWindowRef(
            app: Self.app,
            window: Self.window(windowID: 77, bounds: Self.originalBounds))
        let observation = service.issueObservation(
            windowRef: windowRef,
            snapshotId: "snapshot-1",
            elements: [ComputerWindowActionExecutor.ElementTarget(id: "button", bounds: .zero)])

        do {
            switch testCase.scenario {
            case .freshWindow:
                _ = try service.resolveWindow(windowRef)
            case .freshElement:
                let current = try service.resolveObservation(observation.id, windowRef: windowRef)
                _ = try service.resolveElement(observation.elementRefs[0], observation: current)
            case .windowMoved:
                let moved = Self.window(windowID: 77, bounds: Self.movedBounds)
                #expect(service.issueWindowRef(app: Self.app, window: moved) == windowRef)
                let refreshed = try service.resolveWindow(windowRef).window
                #expect(refreshed.bounds == Self.movedBounds)
                #expect(refreshed.mutationIdentity == moved.mutationIdentity)
            case .generationRotation:
                service.adoptLifecycleGeneration(2)
                _ = try service.resolveWindow(windowRef)
            case .inFlightGenerationChange:
                try await Self.performWithRevokedLifecycle(service)
            case .supersededObservation:
                _ = service.issueObservation(
                    windowRef: windowRef,
                    snapshotId: "snapshot-2",
                    elements: [ComputerWindowActionExecutor.ElementTarget(id: "button", bounds: .zero)])
                _ = try service.resolveObservation(observation.id, windowRef: windowRef)
            case .unrelatedDiscovery:
                _ = service.issueWindowRef(
                    app: Self.app,
                    window: Self.window(windowID: 88, bounds: Self.movedBounds))
                _ = try service.resolveWindow(windowRef)
            case .unknownRef:
                _ = try service.resolveWindow("peekaboo:v2:window:unknown")
            }
            return nil
        } catch {
            return error
        }
    }

    /// Runs a real action whose lifecycle generation is revoked after the work
    /// completed but before the result is released, which is the only way the
    /// in-flight change reaches a caller.
    private static func performWithRevokedLifecycle(_ service: ComputerWindowActionExecutor) async throws {
        var checks = 0
        _ = try await service.perform(
            OpenClawComputerActParams(action: .getCursorPosition),
            lifecycleGeneration: 1,
            checkExecutionAllowed: {
                checks += 1
                if checks > 1 {
                    throw ComputerActionService.ComputerActionError.lifecycleChanged
                }
            })
    }

    private static func window(windowID: Int, bounds: CGRect) -> ServiceWindowInfo {
        ServiceWindowInfo(
            windowID: windowID,
            title: "Contract Window",
            bounds: bounds,
            mutationIdentity: WindowMutationIdentity(
                windowID: windowID,
                ownerProcessIdentifier: self.app.processIdentifier,
                ownerProcessStartIdentity: 90210,
                capturedBounds: bounds))
    }

    private static func loadContract() throws -> Contract {
        var cursor = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = cursor
                .appendingPathComponent("test")
                .appendingPathComponent("fixtures")
                .appendingPathComponent("computer-ref-lifecycle-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Contract.self, from: Data(contentsOf: candidate))
            }
            cursor.deleteLastPathComponent()
        }
        throw NSError(
            domain: "ComputerRefLifecycleContractTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "missing shared computer ref lifecycle fixture"])
    }
}
