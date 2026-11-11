

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}



android {
    namespace = "com.couples.wallpaper"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.couples.wallpaper"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes {
        debug { manifestPlaceholders["usesCleartext"] = "true" } // lets you talk to a dev server over http
        release {
            manifestPlaceholders["usesCleartext"] = "false" // release builds require https
            isMinifyEnabled = false
        }
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
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.socket:socket.io-client:2.1.0") { exclude(group = "org.json", module = "json") }
    implementation("com.goterl:lazysodium-android:5.1.0@aar")
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    implementation("androidx.security:security-crypto:1.0.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
implementation("com.google.firebase:firebase-messaging")
}
