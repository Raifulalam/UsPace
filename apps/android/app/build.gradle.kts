plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.couples.wallpaper"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.couples.wallpaper"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.2.0"

        // Where the existing website is served. Override with -PwebAppUrl=https://... if it moves.
        val webAppUrl = (project.findProperty("webAppUrl") as String?) ?: "https://wespc.vercel.app"
        val apiBaseUrl = (project.findProperty("apiBaseUrl") as String?) ?: "https://uspace-ubq2.onrender.com"
        require(webAppUrl.startsWith("https://")) { "webAppUrl must be https" }
        buildConfigField("String", "WEB_APP_URL", "\"$webAppUrl\"")
        buildConfigField("String", "WEB_HOST", "\"${java.net.URI(webAppUrl).host}\"")
        buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
        // Leave false unless the API cookie is switched to SameSite=None (see README).
        buildConfigField("boolean", "ALLOW_THIRD_PARTY_COOKIES", (project.findProperty("allowThirdPartyCookies") as String?) ?: "false")
    }
    buildFeatures { buildConfig = true }
    buildTypes {
        // Cleartext rules live in res/xml/network_security_config.xml (release: none; debug adds localhost/emulator only).
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets {
        // Shared test cases: the same JSON is run by the JavaScript tests and by the Kotlin tests.
        getByName("test") { resources.srcDir("../../../packages/canvas-core/fixtures") }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.webkit:webkit:1.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.socket:socket.io-client:2.1.0") { exclude(group = "org.json", module = "json") }
    implementation("com.goterl:lazysodium-android:5.1.0@aar")
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    implementation("androidx.security:security-crypto:1.0.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
}
