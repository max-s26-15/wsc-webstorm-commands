import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    kotlin("jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.wsc"
version = "0.5.1"

// The WebStorm this plugin is built and verified against. CI downloads it; locally,
// -PwebstormPath=/snap/webstorm/current builds against an installed IDE instead (faster, offline).
// The MCP Server API it extends is not a stable one, so this is also the only build it is
// declared compatible with (untilBuild below).
val webstormVersion = "2026.2.3"
val webstormPath = providers.gradleProperty("webstormPath")

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        if (webstormPath.isPresent) local(webstormPath.get()) else webstorm(webstormVersion)
        bundledPlugin("com.intellij.mcpServer")
        bundledPlugin("org.jetbrains.plugins.terminal")
    }
}

intellijPlatform {
    // Needs a running IDE instance and adds nothing here: the plugin has no settings pages.
    buildSearchableOptions = false
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "262"
            untilBuild = "262.*"
        }
    }
    pluginVerification {
        ides {
            create(IntelliJPlatformType.WebStorm, webstormVersion)
        }
    }
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }
    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }
}
