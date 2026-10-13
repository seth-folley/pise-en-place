// swift-tools-version: 6.4
import PackageDescription

let package = Package(
    name: "PiseKit",
    platforms: [.macOS(.v26)],
    products: [.library(name: "PiseKit", targets: ["PiseKit"])],
    dependencies: [
        .package(url: "https://github.com/pointfreeco/swift-composable-architecture", exact: "1.26.2")
    ],
    targets: [
        .target(name: "PiseKit", dependencies: [
            .product(name: "ComposableArchitecture", package: "swift-composable-architecture")
        ]),
        .testTarget(name: "PiseKitTests", dependencies: [
            "PiseKit",
            .product(name: "ComposableArchitecture", package: "swift-composable-architecture")
        ])
    ],
    swiftLanguageModes: [.v6]
)
