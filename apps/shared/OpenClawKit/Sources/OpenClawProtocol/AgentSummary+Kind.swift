import Foundation

extension AgentSummary {
    public var isSelectableAgent: Bool {
        kind != .system
    }
}
