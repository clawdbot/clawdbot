import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("app-icon-debug-dark: \(message)\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3 else {
    fail("usage: app-icon-debug-dark.swift <source.png> <output.png>")
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard
    let imageSource = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
    let sourceImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
else {
    fail("cannot read \(sourceURL.path)")
}

let width = sourceImage.width
let height = sourceImage.height
guard width == 1024, height == 1024 else {
    fail("source must be 1024x1024, got \(width)x\(height)")
}

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let bitmapInfo =
    CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
var pixels = [UInt8](repeating: 0, count: width * height * 4)
guard
    let context = CGContext(
        data: &pixels,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo)
else {
    fail("cannot create an RGBA rendering context")
}
context.draw(sourceImage, in: CGRect(x: 0, y: 0, width: width, height: height))

func isInsetBackground(pixel: Int) -> Bool {
    let red = Int(pixels[pixel])
    let green = Int(pixels[pixel + 1])
    let blue = Int(pixels[pixel + 2])
    return pixels[pixel + 3] == 255
        && min(red, green, blue) >= 224
        && max(red, green, blue) - min(red, green, blue) <= 4
}

// The Debug master is raster-only. Flood-filling from the inset panel keeps the
// disconnected white bug glyph and the full-bleed construction frame intact.
var visited = [Bool](repeating: false, count: width * height)
var cleared = [Bool](repeating: false, count: width * height)
var queue = [128 * width + 128]
visited[queue[0]] = true
var cursor = 0
var clearedCount = 0

while cursor < queue.count {
    let index = queue[cursor]
    cursor += 1
    let pixel = index * 4
    guard isInsetBackground(pixel: pixel) else { continue }

    cleared[index] = true
    clearedCount += 1
    pixels[pixel] = 0
    pixels[pixel + 1] = 0
    pixels[pixel + 2] = 0
    pixels[pixel + 3] = 0

    let x = index % width
    let y = index / width
    if x > 0 {
        let neighbor = index - 1
        if !visited[neighbor] {
            visited[neighbor] = true
            queue.append(neighbor)
        }
    }
    if x + 1 < width {
        let neighbor = index + 1
        if !visited[neighbor] {
            visited[neighbor] = true
            queue.append(neighbor)
        }
    }
    if y > 0 {
        let neighbor = index - width
        if !visited[neighbor] {
            visited[neighbor] = true
            queue.append(neighbor)
        }
    }
    if y + 1 < height {
        let neighbor = index + width
        if !visited[neighbor] {
            visited[neighbor] = true
            queue.append(neighbor)
        }
    }
}

guard clearedCount > 300_000 else {
    fail("expected a connected light inset panel, cleared only \(clearedCount) pixels")
}

// The source artwork was antialiased against white. Remove that matte from the
// two-pixel perimeter so the transparent Dark panel cannot produce a white halo.
var unmattedCount = 0
for index in 0..<(width * height) where !cleared[index] {
    let x = index % width
    let y = index / width
    var touchesBackground = false

    for deltaY in -2...2 where !touchesBackground {
        for deltaX in -2...2 {
            let neighborX = x + deltaX
            let neighborY = y + deltaY
            if neighborX >= 0,
                neighborX < width,
                neighborY >= 0,
                neighborY < height,
                cleared[neighborY * width + neighborX]
            {
                touchesBackground = true
                break
            }
        }
    }

    guard touchesBackground else { continue }
    let pixel = index * 4
    let matte = min(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2])
    guard matte >= 96 else { continue }

    pixels[pixel] -= matte
    pixels[pixel + 1] -= matte
    pixels[pixel + 2] -= matte
    pixels[pixel + 3] = 255 - matte
    unmattedCount += 1
}

guard unmattedCount > 1_000 else {
    fail("expected white-matted inset edges, unmatted only \(unmattedCount) pixels")
}

guard
    let provider = CGDataProvider(data: Data(pixels) as CFData),
    let outputImage = CGImage(
        width: width,
        height: height,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
        provider: provider,
        decode: nil,
        shouldInterpolate: false,
        intent: .defaultIntent),
    let destination = CGImageDestinationCreateWithURL(
        outputURL as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil)
else {
    fail("cannot create \(outputURL.path)")
}

CGImageDestinationAddImage(destination, outputImage, nil)
guard CGImageDestinationFinalize(destination) else {
    fail("cannot write \(outputURL.path)")
}
