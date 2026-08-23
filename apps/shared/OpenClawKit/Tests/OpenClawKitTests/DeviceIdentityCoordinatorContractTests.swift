import Darwin
import Foundation
import Testing
@testable import OpenClawKit

private struct DeviceIdentityCoordinatorContractFixture: Decodable {
    let databasePath: String
    let stateDirectory: String
    let temporaryDirectory: String
    let uid: UInt32
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
    @Test func `matches shared ordered path vector`() throws {
        let fixture = try DeviceIdentityCoordinatorContractFixtureLoader.load()
        let resolved = DeviceIdentitySQLiteStore.resolveDeviceIdentityCoordinatorURLs(
            databaseURL: URL(fileURLWithPath: fixture.databasePath),
            destinationStateDirURL: URL(fileURLWithPath: fixture.stateDirectory, isDirectory: true),
            temporaryDirectory: URL(fileURLWithPath: fixture.temporaryDirectory, isDirectory: true),
            uid: uid_t(fixture.uid))

        #expect(resolved.map(\.path) == fixture.orderedExpectedPaths)
    }
}
