import Foundation

public enum MoltbotLocationMode: String, Codable, Sendable, CaseIterable {
    case off
    case whileUsing
    case always
}
