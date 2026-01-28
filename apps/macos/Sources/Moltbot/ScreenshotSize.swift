import Foundation
import ImageIO

enum ScreenshotSize {
    struct Size {
        let width: Int
        let height: Int
    }

    static func readPNGSize(data: Data) -> Size? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
        guard let width = props[kCGImagePropertyPixelWidth] as? Int else { return nil }
        guard let height = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return Size(width: width, height: height)
    }
}
