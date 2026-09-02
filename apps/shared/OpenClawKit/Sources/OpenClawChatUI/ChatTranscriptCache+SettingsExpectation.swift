import Foundation

extension OpenClawChatSQLiteTranscriptCache {
    nonisolated static func encodeSessionSettingsExpectation(
        _ expectation: OpenClawChatSessionSettingsExpectation?) -> String?
    {
        guard let expectation,
              let data = try? JSONEncoder().encode(expectation)
        else { return nil }
        return String(bytes: data, encoding: .utf8)
    }

    nonisolated static func decodeSessionSettingsExpectation(
        _ raw: String?) throws -> OpenClawChatSessionSettingsExpectation?
    {
        guard let raw, !raw.isEmpty else { return nil }
        return try JSONDecoder().decode(
            OpenClawChatSessionSettingsExpectation.self,
            from: Data(raw.utf8))
    }
}
