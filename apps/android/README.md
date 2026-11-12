# Our Space Android app

The app uses native Kotlin and Compose screens for sign in, couple setup, encrypted chat, canvas,
memories, calls history, space settings, account security, and wallpaper controls. Notification
taps also open native destinations. Authentication, room keys, and device secrets stay in the app.

Push notifications use Firebase Cloud Messaging with a generic, data-only message payload. The
Android app registers its FCM token only after authentication and device registration, removes it
on logout, and opens the shared space when a new-message notification is tapped.

Shows the couple's newest canvas as a **live wallpaper**: when your partner draws, strokes appear on this phone as they are drawn.
Android only (iOS does not allow third-party live wallpapers).

## How it fits the encryption model
The phone registers as one more **device** of your account. Your partner (or your other device) approves it with the normal
approval notice in Account & security on an already trusted device, exactly like any new device. After that the wallpaper downloads its encrypted room-key envelope,
decrypts drawing operations **on the phone**, and draws them. The server never sees drawings.

## Privacy defaults
- **While the phone is locked the wallpaper shows a plain heart**, not the drawing (turn off in the app if you want the drawing on the lock screen).
- Nothing appears until *you* choose it in Android's wallpaper picker; you can switch wallpapers at any time.
- The wallpaper connects only while it is visible on screen, and disconnects shortly after (battery).
- Secrets (device key, room keys, refresh token) are stored in Android Keystore-backed encrypted storage.
- To stop sharing: sign out in the app **and** remove the device in Account & security on another trusted device (this rotates the room key).

## Build and run
1. Install Android Studio (Hedgehog or newer, JDK 17). Open the `apps/android` folder; accept the Gradle sync.
2. The release app uses the configured deployed API. For local development, temporarily configure the API base in the Android source before running.
3. Debug builds may use `http` for local development; release builds require `https`.
4. Run the app, sign in or create an account. The app opens the native Our Space screen.
5. On an already trusted device, open Account & security. Check the new device safety code against the code on this phone, then approve it. The phone's status turns to "Connected".
6. Tap **Set as live wallpaper** and confirm in Android's picker.
7. Use **Live wallpaper setup** from the native Our Space screen to choose the wallpaper. Android's wallpaper picker controls whether it appears on the home screen, lock screen, or both.
8. Draw in the native Shared canvas or on another connected client; the wallpaper updates. The setup screen lets you show a plain heart while the phone is locked.

The account supports up to 10 active devices. Reinstalling or clearing app data creates a new encrypted
device identity; remove unused entries from **Account & security -> Trusted devices** before registering another phone.

Unit tests (JVM): `./gradlew test`. They run the same shared cases as `packages/canvas-core` (JavaScript) so the two ports cannot drift.

## Native migration status
- Native: authentication, couple/invitation setup, encrypted chat and attachments, settings, account/profile/security, sessions, trusted-device revocation with room-key rotation, recovery-key backup/restore, albums and memories, media library, canvas drawing/viewing, call history, wallpaper, and push notification routing.
- Canvas supports pen, brush, and eraser, local stroke previews, undo, clear, background choice, and encrypted operations. It follows the newest canvas or lets you select another shared canvas.
- Native voice calls can start, receive, accept, decline, and end calls with web clients using encrypted signaling and WebRTC. Native video calling remains to migrate; the app currently prompts callers to use voice.

The Android app should be compiled and exercised on an emulator/device before release.
Written without access to an Android SDK. Expect small fixes on first build. The most API-sensitive parts, in order:
1. `Crypto.kt` - calls the C-style libsodium functions of lazysodium's `SodiumAndroid` (`crypto_box_open_easy`, `crypto_aead_xchacha20poly1305_ietf_decrypt`, `crypto_generichash`). If a signature differs, only this file changes.
2. `SyncHub.kt` - uses `IO.Options.builder()...setAuth(...)` from `socket.io-client:2.1.0`.
3. `Store.kt` - `EncryptedSharedPreferences` (security-crypto 1.0.0).
4. Gradle/AGP versions in `build.gradle.kts` (AGP 8.2.2, Kotlin 1.9.22, Gradle 8.5): bump to your Android Studio's recommendation if it asks.
First end-to-end check: after approval the status should reach "Connected". If it stays on "Offline", read Logcat for the failing call.

## Known limits
- Shows the newest canvas automatically unless a canvas is selected in the native editor.
- The picture is fitted to the screen, not cropped; extra space uses the canvas background colour.
- OEM battery savers may stop the wallpaper process in the background; the wallpaper reconnects when it becomes visible.
- Cloudy cases: a very long stroke previews only its latest ~1,600 points live, then the full stroke appears when committed.
- Android lets users set separate home/lock wallpapers; pick "Home screen" or "Both" in the picker.
