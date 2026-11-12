# Our Space Android app

The app uses a hybrid architecture. Kotlin handles login/signup, encrypted device registration,
session storage, device approval status, wallpaper setup, Android permissions, downloads, and
navigation. The existing React app is hosted in a hardened WebView for chat, canvas, memories,
media, calls, and settings. The Android sign-in creates one shared refresh session for the native
app and WebView, so the user signs in once and remains signed in until logout. Only the refresh
cookie is transferred to WebView; the React access token remains in memory and is never exposed
through a JavaScript bridge.

Push notifications use Firebase Cloud Messaging with a generic, data-only message payload. The
Android app registers its FCM token only after authentication and device registration, removes it
on logout, and opens the shared space when a new-message notification is tapped.

Shows the couple's newest canvas as a **live wallpaper**: when your partner draws, strokes appear on this phone as they are drawn.
Android only (iOS does not allow third-party live wallpapers).

## How it fits the encryption model
The phone registers as one more **device** of your account. Your partner (or your other device) approves it with the normal
approval banner in the web app, exactly like any new device. After that the wallpaper downloads its encrypted room-key envelope,
decrypts drawing operations **on the phone**, and draws them. The server never sees drawings.

## Privacy defaults
- **While the phone is locked the wallpaper shows a plain heart**, not the drawing (turn off in the app if you want the drawing on the lock screen).
- Nothing appears until *you* choose it in Android's wallpaper picker; you can switch wallpapers at any time.
- The wallpaper connects only while it is visible on screen, and disconnects shortly after (battery).
- Secrets (device key, room keys, refresh token) are stored in Android Keystore-backed encrypted storage.
- To stop sharing: sign out in the app **and** remove the device in Our Space -> Security -> Devices (this rotates the room key).

## Build and run
1. Install Android Studio (Hedgehog or newer, JDK 17). Open the `apps/android` folder; accept the Gradle sync.
2. The release app uses the deployed API and web app automatically. For local development, temporarily configure the API base in the Android source before running.
3. Debug builds may use `http` for local development; release builds require `https`.
4. Run the app, sign in or create an account. Tap **Open Our Space** for the full React experience.
5. In Our Space (web, on a device that already works) a banner appears: *New device "Android live wallpaper (...)"*.
   Check that the **code matches**, then tap **Approve**. The phone's status turns to "Connected".
6. Tap **Set as live wallpaper** and confirm in Android's picker.
7. Open Settings -> Live wallpaper in Our Space. Use **Set wallpaper now** for the direct Android flow, or **Choose home or lock screen** to select the home screen, lock screen, or both.
8. Open the Live Canvas on the web in another window and draw; the wallpaper updates. The live wallpaper settings also let you show a plain heart instead of the drawing while the phone is locked.

The account supports up to 10 active devices. Reinstalling or clearing app data creates a new encrypted
device identity; remove unused entries from **Our Space -> Security -> Devices** before registering another phone.

Unit tests (JVM): `./gradlew test`. They run the same shared cases as `packages/canvas-core` (JavaScript) so the two ports cannot drift.

## Status
The hybrid shell is implemented but should be compiled and exercised on an emulator/device before release.
Written without access to an Android SDK. Expect small fixes on first build. The most API-sensitive parts, in order:
1. `Crypto.kt` - calls the C-style libsodium functions of lazysodium's `SodiumAndroid` (`crypto_box_open_easy`, `crypto_aead_xchacha20poly1305_ietf_decrypt`, `crypto_generichash`). If a signature differs, only this file changes.
2. `SyncHub.kt` - uses `IO.Options.builder()...setAuth(...)` from `socket.io-client:2.1.0`.
3. `Store.kt` - `EncryptedSharedPreferences` (security-crypto 1.0.0).
4. Gradle/AGP versions in `build.gradle.kts` (AGP 8.2.2, Kotlin 1.9.22, Gradle 8.5): bump to your Android Studio's recommendation if it asks.
First end-to-end check: after approval the status should reach "Connected". If it stays on "Offline", read Logcat for the failing call.

## Known limits
- Shows the **newest** canvas automatically (follows when a partner starts a new one). No canvas picker yet.
- The picture is fitted to the screen, not cropped; extra space uses the canvas background colour.
- OEM battery savers may stop the wallpaper process in the background; the wallpaper reconnects when it becomes visible.
- Cloudy cases: a very long stroke previews only its latest ~1,600 points live, then the full stroke appears when committed.
- Android lets users set separate home/lock wallpapers; pick "Home screen" or "Both" in the picker.
