import AppKit

enum AppIconStyle: String, CaseIterable, Identifiable {
    case paper
    case heritage
    case clawmark
    case origami
    case pincer
    case openC

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .paper: String(localized: "Original")
        case .heritage: String(localized: "Heritage")
        case .clawmark: String(localized: "Clawmark")
        case .origami: String(localized: "Origami")
        case .pincer: String(localized: "Pincer")
        case .openC: String(localized: "Open C")
        }
    }

    var usesSystemIcon: Bool {
        if #available(macOS 26, *) {
            return self == .paper
        }
        return false
    }

    func resourceName(for appearance: AppIconAppearance) -> String {
        "\(rawValue)-\(appearance.rawValue)"
    }
}

enum AppIconAppearance: String, CaseIterable {
    case light
    case dark

    init(_ appearance: NSAppearance) {
        self = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .dark : .light
    }

    var title: String {
        switch self {
        case .light: String(localized: "Light")
        case .dark: String(localized: "Dark")
        }
    }
}

@MainActor
enum AppIconArtwork {
    private static let images: [String: NSImage] = {
        // SwiftPM has a resource sidecar; the signed app packages these icons in
        // Contents/Resources. Avoid Bundle.module's fatal lookup inside the app.
        let bundle = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main : Bundle.module
        return Dictionary(uniqueKeysWithValues: AppIconStyle.allCases.flatMap { style in
            AppIconAppearance.allCases.compactMap { appearance -> (String, NSImage)? in
                let name = style.resourceName(for: appearance)
                guard let url = bundle.url(forResource: name, withExtension: "icns", subdirectory: "AppIcons"),
                      let image = NSImage(contentsOf: url)
                else { return nil }
                return (name, image)
            }
        })
    }()

    static func image(for style: AppIconStyle, appearance: AppIconAppearance) -> NSImage? {
        self.images[style.resourceName(for: appearance)]
    }
}
