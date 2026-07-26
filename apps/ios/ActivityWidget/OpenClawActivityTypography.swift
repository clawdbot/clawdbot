import SwiftUI

enum OpenClawActivityType {
    static var eyebrow: Font {
        body(size: 8).weight(.bold)
    }

    static var subheadSemiBold: Font {
        display(size: 15, weight: .semibold)
    }

    static var subheadBold: Font {
        display(size: 15, weight: .bold)
    }

    static var caption: Font {
        body(size: 12)
    }

    static func symbol(size: CGFloat, weight: Font.Weight) -> Font {
        .system(size: size, weight: weight)
    }

    private static func display(size: CGFloat, weight: Font.Weight) -> Font {
        .custom("RedHatDisplay-Regular", size: size, relativeTo: .subheadline).weight(weight)
    }

    private static func body(size: CGFloat) -> Font {
        .custom("Inter-Regular", size: size, relativeTo: .caption)
    }
}
