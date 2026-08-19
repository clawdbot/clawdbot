import Darwin
import Foundation
import Testing
@testable import OpenClawKit

private struct DeviceIdentityCoordinatorContractFixture: Decodable {
    let databasePath: String
    let stateDirectory: String
    let runtimeDirectory: String
    let uid: UInt32
    let stateCoordinatorPath: String
    let orderedExpectedPaths: [String]
}

private enum DeviceIdentityCoordinatorContractFixtureLoader {
    static func load() throws -> DeviceIdentityCoordinatorContractFixture {
        let fixtureURL = try self.findFixtureURL(startingAt: URL(fileURLWithPath: #filePath))
        return try JSONDecoder().decode(
            DeviceIdentityCoordinatorContractFixture.self,
            from: Data(contentsOf: fixtureURL))
    }

    private static func findFixtureURL(startingAt fileURL: URL) throws -> URL {
        var directory = fileURL.deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(
                "test/fixtures/device-identity-coordinator-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            directory.deleteLastPathComponent()
        }
        throw NSError(domain: "DeviceIdentityCoordinatorContractFixtureLoader", code: 1)
    }
}

struct DeviceIdentityCoordinatorContractTests {
    @Test func `uses a sandbox writable lifecycle runtime`() {
        let stateDirectory = URL(fileURLWithPath: "/sandbox/group/OpenClaw", isDirectory: true)

        #expect(
            DeviceIdentitySQLiteStore.resolveStateLifecycleRuntimeDirectory(
                destinationStateDirURL: stateDirectory,
                appSandboxed: true).path == "/sandbox/group/OpenClaw/tmp")
        #expect(
            DeviceIdentitySQLiteStore.resolveStateLifecycleRuntimeDirectory(
                destinationStateDirURL: stateDirectory,
                appSandboxed: false).path == "/tmp")
    }

    @Test func `matches shared ordered path vector`() throws {
        let fixture = try DeviceIdentityCoordinatorContractFixtureLoader.load()
        let databaseURL = URL(fileURLWithPath: fixture.databasePath)
        let resolved = DeviceIdentitySQLiteStore.resolveDeviceIdentityCoordinatorURLs(
            databaseURL: databaseURL,
            destinationStateDirURL: URL(fileURLWithPath: fixture.stateDirectory, isDirectory: true),
            uid: uid_t(fixture.uid))
        let stateCoordinator = DeviceIdentitySQLiteStore.resolveStateDatabaseCoordinatorURL(
            databaseURL: databaseURL,
            runtimeDirectory: URL(fileURLWithPath: fixture.runtimeDirectory, isDirectory: true),
            uid: uid_t(fixture.uid))

        #expect(stateCoordinator.path == fixture.stateCoordinatorPath)
        #expect(resolved.map(\.path) == fixture.orderedExpectedPaths)
    }
}
