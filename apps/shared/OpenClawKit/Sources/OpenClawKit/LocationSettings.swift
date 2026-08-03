import Foundation

public enum OpenClawLocationMode: String, Codable, Sendable, CaseIterable {
    case off
    case whileUsing
    case always
}
