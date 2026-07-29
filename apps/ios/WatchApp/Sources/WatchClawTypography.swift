import SwiftUI

enum WatchClawType {
    static func avatar(size: CGFloat) -> Font {
        self.body(size: size, weight: .bold, relativeTo: .caption)
    }

    static func label(size: CGFloat = 10, weight: Font.Weight = .bold) -> Font {
        self.body(size: size, weight: weight, relativeTo: .caption2)
    }

    static func title(size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        self.display(size: size, weight: weight, relativeTo: .headline)
    }

    static func body(
        size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo textStyle: Font.TextStyle = .body) -> Font
    {
        .custom("Inter-Regular", size: size, relativeTo: textStyle).weight(weight)
    }

    static func symbol(size: CGFloat, weight: Font.Weight) -> Font {
        .system(size: size, weight: weight)
    }

    static var captionSemiBold: Font {
        body(size: 12, weight: .semibold, relativeTo: .caption)
    }

    static var captionBold: Font {
        body(size: 12, weight: .bold, relativeTo: .caption)
    }

    static var caption2: Font {
        body(size: 11, relativeTo: .caption2)
    }

    static var command: Font {
        .custom("JetBrainsMono-Regular", size: 11, relativeTo: .body)
    }

    private static func display(size: CGFloat, weight: Font.Weight, relativeTo textStyle: Font.TextStyle) -> Font {
        .custom("RedHatDisplay-Regular", size: size, relativeTo: textStyle).weight(weight)
    }
}
