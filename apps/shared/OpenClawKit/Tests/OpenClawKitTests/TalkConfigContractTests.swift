import Foundation
import OpenClawKit
import Testing

private struct TalkConfigContractFixture: Decodable {
    let selectionCases: [SelectionCase]
    let timeoutCases: [TimeoutCase]

    struct SelectionCase: Decodable {
        let id: String
        let defaultProvider: String
        let payloadValid: Bool
        let expectedSelection: ExpectedSelection?
        let talk: [String: AnyCodable]

        var gatewayResponseTalk: [String: AnyCodable] {
            guard let expectedSelection else { return self.talk }
            var config: [String: AnyCodable] = [:]
            if let voiceId = expectedSelection.voiceId {
                config["voiceId"] = AnyCodable(voiceId)
            }
            if let apiKey = expectedSelection.apiKey {
                config["apiKey"] = AnyCodable(apiKey)
            }
            var response = self.talk
            response["provider"] = AnyCodable(expectedSelection.provider)
            response["providers"] = AnyCodable([expectedSelection.provider: config])
            response["resolved"] = AnyCodable([
                "provider": AnyCodable(expectedSelection.provider),
                "config": AnyCodable(config),
            ])
            return response
        }
    }

    struct ExpectedSelection: Decodable {
        let provider: String
        let normalizedPayload: Bool
        let voiceId: String?
        let apiKey: String?
    }

    struct TimeoutCase: Decodable {
        let id: String
        let fallback: Int
        let expectedTimeoutMs: Int
        let talk: [String: AnyCodable]
    }
}

private enum TalkConfigContractFixtureLoader {
    static func load() throws -> TalkConfigContractFixture {
        let fixtureURL = try self.findFixtureURL(startingAt: URL(fileURLWithPath: #filePath))
        let data = try Data(contentsOf: fixtureURL)
        return try JSONDecoder().decode(TalkConfigContractFixture.self, from: data)
    }

    private static func findFixtureURL(startingAt fileURL: URL) throws -> URL {
        var directory = fileURL.deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("test-fixtures/talk-config-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            directory.deleteLastPathComponent()
        }
        throw NSError(domain: "TalkConfigContractFixtureLoader", code: 1)
    }
}

struct TalkConfigContractTests {
    @Test func selectionFixtures() throws {
        for fixture in try TalkConfigContractFixtureLoader.load().selectionCases {
            let selection = TalkConfigParsing.selectProviderConfig(
                fixture.gatewayResponseTalk,
                defaultProvider: fixture.defaultProvider)
            if let expected = fixture.expectedSelection {
                #expect(selection != nil)
                #expect(selection?.provider == expected.provider)
                #expect(selection?.normalizedPayload == expected.normalizedPayload)
                #expect(selection?.config["voiceId"]?.stringValue == expected.voiceId)
                #expect(selection?.config["apiKey"]?.stringValue == expected.apiKey)
            } else {
                #expect(selection == nil)
            }
            #expect(fixture.payloadValid == (selection != nil))
        }
    }

    @Test func timeoutFixtures() throws {
        for fixture in try TalkConfigContractFixtureLoader.load().timeoutCases {
            #expect(
                TalkConfigParsing.resolvedSilenceTimeoutMs(
                    fixture.talk,
                    fallback: fixture.fallback) == fixture.expectedTimeoutMs,
                "\(fixture.id)")
        }
    }
}
