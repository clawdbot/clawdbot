import Foundation
import OpenClawKit

enum GatewayNativeNotification: Decodable, Sendable {
    struct Presentation: Decodable, Sendable {
        enum Category: String, Decodable, Sendable {
            case approvalRequested = "approval-requested"
            case agentFinished = "agent-finished"
            case agentQuestion = "agent-question"
            case scheduledTaskFailed = "scheduled-task-failed"
            case backgroundTaskFailed = "background-task-failed"
        }

        let id: String
        let category: Category
        let title: String
        let body: String
        let path: String
        let expiresAtMs: Int
        let alert: Bool
    }

    case show(Presentation)
    case remove(String)

    private enum CodingKeys: String, CodingKey { case action, id }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        guard !id.isEmpty, id.utf16.count <= 200 else {
            throw DecodingError.dataCorruptedError(
                forKey: .id,
                in: container,
                debugDescription: "Invalid notification ID")
        }
        switch try container.decode(String.self, forKey: .action) {
        case "remove":
            self = .remove(id)
        case "show":
            let presentation = try Presentation(from: decoder)
            guard presentation.title.utf16.count <= 160,
                  presentation.body.utf16.count <= 320,
                  presentation.path.utf16.count <= 1024,
                  Self.location(presentation.path) != nil,
                  presentation.expiresAtMs >= 0
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .action, in: container, debugDescription: "Invalid notification presentation")
            }
            self = .show(presentation)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .action, in: container, debugDescription: "Unknown notification action")
        }
    }

    static func location(_ value: String) -> (path: String, search: String?)? {
        guard let components = URLComponents(string: value),
              components.scheme == nil, components.host == nil, components.fragment == nil,
              DashboardRouteMap.isValidSameAppPath(components.path)
        else { return nil }
        return (components.path, components.percentEncodedQuery.map { "?" + $0 })
    }
}
