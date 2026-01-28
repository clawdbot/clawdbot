import MoltbotKit
import CoreGraphics
import ImageIO
import Testing
import UniformTypeIdentifiers

@Suite struct JPEGTranscoderTests {
    private func makeSolidJPEG(width: Int, height: Int, orientation: Int? = nil) throws -> Data {
        let cs = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        guard
            let ctx = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: cs,
                bitmapInfo: bitmapInfo)
        else {
            throw NSError(domain: "JPEGTranscoderTests", code: 1)
        }

        ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let img = ctx.makeImage() else {
            throw NSError(domain: "JPEGTranscoderTests", code: 5)
        }

        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw NSError(domain: "JPEGTranscoderTests", code: 2)
        }

        var props: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 1.0,
        ]
        if let orientation {
            props[kCGImagePropertyOrientation] = orientation
        }

        CGImageDestinationAddImage(dest, img, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            throw NSError(domain: "JPEGTranscoderTests", code: 3)
        }

        return out as Data
    }

    private func makeNoiseJPEG(width: Int, height: Int) throws -> Data {
        let bytesPerPixel = 4
        let byteCount = width * height * bytesPerPixel
        var data = Data(count: byteCount)
        let cs = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

        let out = try data.withUnsafeMutableBytes { rawBuffer -> Data in
            guard let base = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                throw NSError(domain: "JPEGTranscoderTests", code: 6)
            }
            for idx in 0..<byteCount {
                base[idx] = UInt8.random(in: 0...255)
            }

            guard
                let ctx = CGContext(
                    data: base,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: width * bytesPerPixel,
                    space: cs,
                    bitmapInfo: bitmapInfo)
            else {
                throw NSError(domain: "JPEGTranscoderTests", code: 7)
            }

            guard let img = ctx.makeImage() else {
                throw NSError(domain: "JPEGTranscoderTests", code: 8)
            }

            let encoded = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(encoded, UTType.jpeg.identifier as CFString, 1, nil)
            else {
                throw NSError(domain: "JPEGTranscoderTests", code: 9)
            }
            CGImageDestinationAddImage(dest, img, nil)
            guard CGImageDestinationFinalize(dest) else {
                throw NSError(domain: "JPEGTranscoderTests", code: 10)
            }
            return encoded as Data
        }

        return out
    }

    @Test func downscalesToMaxWidthPx() throws {
        let input = try makeSolidJPEG(width: 2000, height: 1000)
        let out = try JPEGTranscoder.transcodeToJPEG(imageData: input, maxWidthPx: 1600, quality: 0.9)
        #expect(out.widthPx == 1600)
        #expect(abs(out.heightPx - 800) <= 1)
        #expect(out.data.count > 0)
    }

    @Test func doesNotUpscaleWhenSmallerThanMaxWidthPx() throws {
        let input = try makeSolidJPEG(width: 800, height: 600)
        let out = try JPEGTranscoder.transcodeToJPEG(imageData: input, maxWidthPx: 1600, quality: 0.9)
        #expect(out.widthPx == 800)
        #expect(out.heightPx == 600)
    }

    @Test func normalizesOrientationAndUsesOrientedWidthForMaxWidthPx() throws {
        // Encode a landscape image but mark it rotated 90° (orientation 6). Oriented width becomes 1000.
        let input = try makeSolidJPEG(width: 2000, height: 1000, orientation: 6)
        let out = try JPEGTranscoder.transcodeToJPEG(imageData: input, maxWidthPx: 1600, quality: 0.9)
        #expect(out.widthPx == 1000)
        #expect(out.heightPx == 2000)
    }

    @Test func respectsMaxBytes() throws {
        let input = try makeNoiseJPEG(width: 1600, height: 1200)
        let out = try JPEGTranscoder.transcodeToJPEG(
            imageData: input,
            maxWidthPx: 1600,
            quality: 0.95,
            maxBytes: 180_000)
        #expect(out.data.count <= 180_000)
    }
}
