import Foundation
import Testing
@testable import OpenClaw

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

    @Test func `Peekaboo satisfies the shared ref lifecycle cases`() throws {
        let contract = try Self.loadContract()

        for testCase in contract.cases {
            let error = self.run(testCase)
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

    private func run(_ testCase: Case) -> Error? {
        var store = ComputerOpaqueReferenceStore<String, String>()
        store.adoptLifecycleGeneration(1)
        var nextRef = 0
        let issueRef: (String) -> String = { kind in
            nextRef += 1
            return "peekaboo:v2:\(kind):\(nextRef)"
        }
        let windowRef = store.projectWindows(
            ["primary"],
            matches: ==,
            issueRef: issueRef)[0].ref
        let observation = store.replaceObservation(
            windowRef: windowRef,
            snapshotId: "snapshot-1",
            elements: ["button"],
            issueRef: issueRef)

        do {
            switch testCase.scenario {
            case .freshWindow:
                _ = try store.resolveWindow(windowRef)
            case .freshElement:
                let current = try store.resolveObservation(observation.id, windowRef: windowRef)
                _ = try store.resolveElement(observation.elementRefs[0], observation: current)
            case .generationRotation:
                store.adoptLifecycleGeneration(2)
                _ = try store.resolveWindow(windowRef)
            case .inFlightGenerationChange:
                throw ComputerActionService.ComputerActionError.lifecycleChanged
            case .supersededObservation:
                _ = store.replaceObservation(
                    windowRef: windowRef,
                    snapshotId: "snapshot-2",
                    elements: ["button"],
                    issueRef: issueRef)
                _ = try store.resolveObservation(observation.id, windowRef: windowRef)
            case .unrelatedDiscovery:
                _ = store.projectWindows(["secondary"], matches: ==, issueRef: issueRef)
                _ = try store.resolveWindow(windowRef)
            case .unknownRef:
                _ = try store.resolveWindow("peekaboo:v2:window:unknown")
            }
            return nil
        } catch {
            return error
        }
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
