// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Pastyx",
    platforms: [
        .macOS("26.0")
    ],
    targets: [
        .executableTarget(
            name: "Pastyx",
            path: "Sources/Pastyx",
            linkerSettings: [
                .linkedLibrary("sqlite3"),
                .linkedFramework("AppKit"),
                .linkedFramework("SwiftUI"),
                .linkedFramework("Carbon"),
                .linkedFramework("ApplicationServices")
            ]
        )
    ]
)
