// swift-tools-version: 6.0
import PackageDescription

// Speech written down on the Apple Watch itself: Whisper (OpenAI's speech model, as Core ML files from argmax's
// whisperkit-coreml) run by argmax's WhisperKit (MIT, with Apache-2.0 parts taken from Hugging Face's
// swift-transformers). Only the Watch app uses it; the iPhone writes speech down with Apple's own SpeechAnalyzer.
// Kept out of EACore so the iPhone, iPad and Mac apps and the widgets do not carry it. Pinned to one release: a new
// WhisperKit is looked at by a person before it ships (tools/license-check, APPROVED_SWIFT).
let package = Package(
    name: "EAWhisper",
    // macOS so its tests run with `swift test` on the Mac; iOS only so the package resolves for every app platform.
    platforms: [.iOS(.v18), .macOS(.v15), .watchOS(.v11)],
    products: [
        .library(name: "EAWhisper", targets: ["EAWhisper"])
    ],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit", exact: "1.1.1")
    ],
    targets: [
        .target(
            name: "EAWhisper",
            dependencies: [.product(name: "WhisperKit", package: "WhisperKit")],
            path: "Sources/EAWhisper",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "EAWhisperTests",
            dependencies: ["EAWhisper"],
            path: "Tests/EAWhisperTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
