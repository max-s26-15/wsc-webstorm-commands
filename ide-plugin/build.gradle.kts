plugins {
    kotlin("jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.wsc"
version = "0.3.0"

// Built against the WebStorm that is already installed, not a downloaded copy: the MCP Server
// plugin this one extends is a bundled plugin whose API is only guaranteed for its own build.
// Override with -PwebstormPath=... when the IDE is installed somewhere else.
val webstormPath = providers.gradleProperty("webstormPath").orElse("/snap/webstorm/current")

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        local(webstormPath)
        bundledPlugin("com.intellij.mcpServer")
    }
}

intellijPlatform {
    // Needs a running IDE instance and adds nothing here: the plugin has no settings pages.
    buildSearchableOptions = false
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "262"
            untilBuild = provider { null }
        }
    }
}
