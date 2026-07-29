import CoreGraphics
import Foundation
import ImageIO
import OpenClawKit
import Testing
import UniformTypeIdentifiers

struct ShareImageProcessorTests {
    @Test func `downscales image larger than five megabytes and normalizes orientation`() throws {
        let input = try self.makeNoiseJPEG(width: 3000, height: 2500, orientation: 6)
        #expect(input.count > ShareImageProcessor.maxPayloadBytes)

        let output = try ShareImageProcessor.processForUpload(data: input)
        #expect(output.count <= ShareImageProcessor.maxPayloadBytes)

        let source = try #require(CGImageSourceCreateWithData(output as CFData, nil))
        let properties = try #require(
            CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let width = try #require((properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue)
        let height = try #require((properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue)
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1

        #expect(max(width, height) <= ShareImageProcessor.maxLongEdgePx)
        #expect(height > width)
        #expect(orientation == 1)
    }

    @Test func `reports invalid image`() {
        do {
            _ = try ShareImageProcessor.processForUpload(data: Data("not an image".utf8))
            Issue.record("Expected invalid-image error")
        } catch let error as ShareImageProcessor.ProcessError {
            #expect(error == .invalidImage)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    private func makeNoiseJPEG(width: Int, height: Int, orientation: Int) throws -> Data {
        let bytesPerPixel = 4
        let byteCount = width * height * bytesPerPixel
        var pixels = Data(count: byteCount)

        return try pixels.withUnsafeMutableBytes { buffer -> Data in
            let bytes = try #require(buffer.baseAddress?.assumingMemoryBound(to: UInt8.self))
            var state: UInt64 = 0x1234_5678_9ABC_DEF0
            for index in 0..<byteCount {
                state = state &* 6_364_136_223_846_793_005 &+ 1
                bytes[index] = UInt8(truncatingIfNeeded: state >> 32)
            }

            let context = try #require(CGContext(
                data: bytes,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * bytesPerPixel,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            let image = try #require(context.makeImage())
            let output = NSMutableData()
            let destination = try #require(CGImageDestinationCreateWithData(
                output,
                UTType.jpeg.identifier as CFString,
                1,
                nil))
            let properties: [CFString: Any] = [
                kCGImageDestinationLossyCompressionQuality: 1.0,
                kCGImagePropertyOrientation: orientation,
            ]
            CGImageDestinationAddImage(destination, image, properties as CFDictionary)
            #expect(CGImageDestinationFinalize(destination))
            return output as Data
        }
    }
}
