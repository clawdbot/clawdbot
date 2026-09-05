import Foundation

struct CronJob: Decodable, Identifiable {
    struct State: Decodable {
        let nextRunAtMs: Int?
    }

    let id: String
    let name: String
    let enabled: Bool
    let state: State

    var displayName: String {
        let trimmed = self.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled job" : trimmed
    }

    var nextRunDate: Date? {
        guard let ms = self.state.nextRunAtMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }
}
