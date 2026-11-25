# Building the Native Android APK for Real Mobile Actions

`apps/companion` includes complete native Android Kotlin services in `android-plugin/`:
- `PetBotMobileHarnessPlugin.kt` (Alarms, Timers, Phone Calls, Flashlight, Ringer, Maps, Calendar, Media)
- `PetBotNotificationListenerService.kt` (WhatsApp/Slack/SMS capture + silent inline `RemoteInput` replies)
- `PetBotAccessibilityService.kt` (Headless Android UI tree inspection & programmatic clicking/typing)
- `PetBotShareReceiverActivity.kt` (Android Share menu → Robot SD Pocket Vault)

When viewed inside a regular mobile browser (Chrome/Safari), browser sandboxes block direct OS access so `MobilePartnerBridge` uses simulator mode. To run **real phone actions on Android**:

1. **Build the companion web bundle**:
   ```bash
   cd apps/companion
   pnpm run build
   ```
2. **Initialize Capacitor Android** *(one-time setup, requires Android Studio / SDK)*:
   ```bash
   pnpm add @capacitor/core @capacitor/cli @capacitor/android
   npx cap add android
   ```
3. **Copy native Kotlin plugins into the Android project**:
   - Copy all `.kt` files from `apps/companion/android-plugin/` into `android/app/src/main/java/com/petbot/companion/harness/`.
   - Copy `accessibility_service_config.xml` into `android/app/src/main/res/xml/`.
   - Merge permissions and `<service>` declarations from `android-plugin/AndroidManifest.xml` into `android/app/src/main/AndroidManifest.xml`.
   - Register `PetBotMobileHarnessPlugin::class.java` in `MainActivity.kt` (or let Capacitor's `@CapacitorPlugin` auto-register it).
4. **Sync and build APK**:
   ```bash
   npx cap sync android
   npx cap open android
   ```
   Build & install on your phone from Android Studio (or run `./gradlew assembleDebug`), then enable **Notification Access** and **Accessibility Service** for **Lobo Companion** in Android Settings.
