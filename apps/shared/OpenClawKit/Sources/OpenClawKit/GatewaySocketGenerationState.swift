/// Prevents delayed callbacks from a retired socket from adopting a replacement route.
public struct GatewaySocketGenerationState: Sendable {
    public private(set) var activeGeneration: UInt64?
    private var lastRetiredGeneration: UInt64?

    public init() {}

    public func accepts(_ generation: UInt64) -> Bool {
        if let lastRetiredGeneration, generation <= lastRetiredGeneration {
            return false
        }
        return self.activeGeneration == nil || self.activeGeneration == generation
    }

    public mutating func admit(_ generation: UInt64) -> Bool {
        guard self.accepts(generation) else { return false }
        self.activeGeneration = generation
        return true
    }

    public mutating func retire(_ generation: UInt64) -> Bool {
        guard self.accepts(generation) else { return false }
        self.activeGeneration = nil
        self.lastRetiredGeneration = generation
        return true
    }
}
