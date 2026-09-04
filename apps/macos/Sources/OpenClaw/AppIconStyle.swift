import AppKit

enum AppIconStyle: String, CaseIterable, Identifiable {
    case automatic
    case paper
    case ink
    case seaGlass

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .automatic: String(localized: "Automatic")
        case .paper: String(localized: "Paper")
        case .ink: String(localized: "Ink")
        case .seaGlass: String(localized: "Sea Glass")
        }
    }

    func resolved(for appearance: NSAppearance) -> Self {
        guard self == .automatic else { return self }
        return appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .ink : .paper
    }
}

@MainActor
enum AppIconArtwork {
    private static let images: [AppIconStyle: NSImage] = {
        // SwiftPM has a resource sidecar; the signed app packages these icons in
        // Contents/Resources. Avoid Bundle.module's fatal lookup inside the app.
        let bundle = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main : Bundle.module
        return Dictionary(uniqueKeysWithValues: AppIconStyle.allCases.compactMap { style in
            guard style != .automatic,
                  let url = bundle.url(
                      forResource: style.rawValue,
                      withExtension: "icns",
                      subdirectory: "AppIcons"),
                  let image = NSImage(contentsOf: url)
            else { return nil }
            return (style, image)
        })
    }()

    static func image(for style: AppIconStyle) -> NSImage? {
        self.images[style]
    }
}
