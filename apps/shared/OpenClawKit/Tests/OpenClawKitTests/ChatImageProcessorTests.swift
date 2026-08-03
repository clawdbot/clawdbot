import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import OpenClawKit

struct ChatImageProcessorTests {
    private func syntheticJPEG(width: Int, height: Int) throws -> Data {
        guard
            let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else {
            throw NSError(domain: "ChatImageProcessorTests", code: 1)
        }

        context.setFillColor(CGColor(red: 0.8, green: 0.2, blue: 0.4, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0.1, green: 0.7, blue: 0.3, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))

        guard let image = context.makeImage() else {
            throw NSError(domain: "ChatImageProcessorTests", code: 2)
        }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        else {
            throw NSError(domain: "ChatImageProcessorTests", code: 3)
        }

        let properties: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.95,
            kCGImagePropertyExifDictionary: [
                kCGImagePropertyExifDateTimeOriginal: "2026:04:20 16:30:00",
                kCGImagePropertyExifLensModel: "Leaky Lens 50mm f/1.4",
            ] as CFDictionary,
            kCGImagePropertyGPSDictionary: [
                kCGImagePropertyGPSLatitude: 60.02,
                kCGImagePropertyGPSLatitudeRef: "N",
                kCGImagePropertyGPSLongitude: 10.95,
                kCGImagePropertyGPSLongitudeRef: "E",
            ] as CFDictionary,
            kCGImagePropertyTIFFDictionary: [
                kCGImagePropertyTIFFMake: "LeakCorp",
                kCGImagePropertyTIFFModel: "Privacy-Leaker-1",
            ] as CFDictionary,
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw NSError(domain: "ChatImageProcessorTests", code: 4)
        }
        return data as Data
    }

    private func syntheticPNGWithAlpha(width: Int, height: Int) throws -> Data {
        guard
            let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else {
            throw NSError(domain: "ChatImageProcessorTests", code: 5)
        }

        context.clear(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: width / 4, y: height / 4, width: width / 2, height: height / 2))

        guard let image = context.makeImage() else {
            throw NSError(domain: "ChatImageProcessorTests", code: 6)
        }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
        else {
            throw NSError(domain: "ChatImageProcessorTests", code: 7)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw NSError(domain: "ChatImageProcessorTests", code: 8)
        }
        return data as Data
    }

    private func properties(for data: Data) -> [CFString: Any] {
        guard
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else {
            return [:]
        }
        return properties
    }

    private func dimensions(for data: Data) -> (width: Int, height: Int)? {
        let properties = self.properties(for: data)
        guard
            let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
            let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else {
            return nil
        }
        return (width.intValue, height.intValue)
    }

    @Test func `resizes landscape long edge to upload limit`() throws {
        let source = try self.syntheticJPEG(width: 4000, height: 3000)
        let output = try ChatImageProcessor.processForUpload(data: source)
        let dimensions = try #require(self.dimensions(for: output))

        #expect(max(dimensions.width, dimensions.height) <= ChatImageProcessor.maxLongEdgePx)
        #expect(abs((Double(dimensions.width) / Double(dimensions.height)) - (4000.0 / 3000.0)) <= 0.02)
    }

    @Test func `resizes portrait long edge to upload limit`() throws {
        let source = try self.syntheticJPEG(width: 3000, height: 4000)
        let output = try ChatImageProcessor.processForUpload(data: source)
        let dimensions = try #require(self.dimensions(for: output))

        #expect(max(dimensions.width, dimensions.height) <= ChatImageProcessor.maxLongEdgePx)
        #expect(abs((Double(dimensions.width) / Double(dimensions.height)) - (3000.0 / 4000.0)) <= 0.02)
    }

    @Test func `resizes narrow tall long edge to upload limit`() throws {
        let source = try self.syntheticJPEG(width: 1080, height: 2400)
        let output = try ChatImageProcessor.processForUpload(data: source)
        let dimensions = try #require(self.dimensions(for: output))

        #expect(max(dimensions.width, dimensions.height) <= ChatImageProcessor.maxLongEdgePx)
        #expect(abs((Double(dimensions.width) / Double(dimensions.height)) - (1080.0 / 2400.0)) <= 0.02)
    }

    @Test func `small image is not upscaled`() throws {
        let source = try self.syntheticJPEG(width: 400, height: 300)
        let output = try ChatImageProcessor.processForUpload(data: source)
        let dimensions = try #require(self.dimensions(for: output))

        #expect(max(dimensions.width, dimensions.height) <= 400)
    }

    @Test func `output fits payload budget`() throws {
        let source = try self.syntheticJPEG(width: 4000, height: 3000)
        let output = try ChatImageProcessor.processForUpload(data: source)

        #expect(output.count <= ChatImageProcessor.maxPayloadBytes)
    }

    @Test func `rejects non image data`() {
        let garbage = Data("not an image".utf8)

        #expect(throws: ChatImageProcessor.ProcessError.self) {
            _ = try ChatImageProcessor.processForUpload(data: garbage)
        }
    }

    @Test func `strips source metadata from output`() throws {
        let source = try self.syntheticJPEG(width: 3000, height: 2000)
        let output = try ChatImageProcessor.processForUpload(data: source)
        let properties = self.properties(for: output)
        let gps = properties[kCGImagePropertyGPSDictionary] as? [CFString: Any] ?? [:]

        #expect(gps.isEmpty)
        for needle in ["Leaky Lens", "LeakCorp", "Privacy-Leaker", "2026:04:20"] {
            #expect(output.range(of: Data(needle.utf8)) == nil)
        }
    }

    @Test func `flattens transparent sources to opaque JPEG`() throws {
        let source = try self.syntheticPNGWithAlpha(width: 800, height: 600)
        let output = try ChatImageProcessor.processForUpload(data: source)
        let imageSource = try #require(CGImageSourceCreateWithData(output as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(imageSource, 0, nil))

        #expect([.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo))
    }
}
