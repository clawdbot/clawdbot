import Foundation

public struct OpenClawCanvasNavigateParams: Codable, Sendable, Equatable {
    public var url: String

    public init(url: String) {
        self.url = url
    }
}

public struct OpenClawCanvasPlacement: Codable, Sendable, Equatable {
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var height: Double?
}

public struct OpenClawCanvasPresentParams: Codable, Sendable, Equatable {
    public var url: String?
    public var placement: OpenClawCanvasPlacement?

    public init(url: String? = nil, placement: OpenClawCanvasPlacement? = nil) {
        self.url = url
        self.placement = placement
    }
}
