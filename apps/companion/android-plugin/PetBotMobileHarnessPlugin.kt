package com.petbot.companion.harness

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.io.FileInputStream

/**
 * PetBot Mobile Partner Harness Plugin for Capacitor (Standard Android APIs)
 *
 * Connects the companion app and ESP32-S3 Pet Robot to the Android smartphone using
 * standard, Play-safe Android APIs and explicit runtime user permission prompts:
 * - Runtime Permissions: Nearby Bluetooth LE (BLUETOOTH_SCAN/CONNECT) and POST_NOTIFICATIONS
 * - Standard Intent Dispatch: Dialer (ACTION_DIAL), Clock Alarms/Timers, Calendar UI, Maps/Geo Navigation, Media, Torch, Ringer, Safe Deep Links
 * - Local Alerts: Standard NotificationChannel / NotificationCompat alerts
 * - Pocket Vault Share Target: Standard Android Share Sheet staging for MicroSD sync
 */
@CapacitorPlugin(
    name = "PetBotMobileHarness",
    permissions = [
        Permission(
            strings = [
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT
            ],
            alias = "bluetooth"
        ),
        Permission(
            strings = [Manifest.permission.POST_NOTIFICATIONS],
            alias = "notifications"
        )
    ]
)
class PetBotMobileHarnessPlugin : Plugin() {

    companion object {
        private const val TAG = "PetBotMobilePlugin"
        private const val ALERT_CHANNEL_ID = "lobo_companion_alerts"
        private const val ALERT_CHANNEL_NAME = "Lobo Companion Alerts"
        private val ALLOWED_DEEP_LINK_SCHEMES = setOf("http", "https", "tel", "mailto", "geo", "petbot")
    }

    private var isTorchOn = false

    override fun load() {
        super.load()
        ensureNotificationChannel()
        Log.i(TAG, "PetBotMobileHarnessPlugin loaded with standard Android APIs")
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val existing = nm.getNotificationChannel(ALERT_CHANNEL_ID)
            if (existing == null) {
                val channel = NotificationChannel(
                    ALERT_CHANNEL_ID,
                    ALERT_CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Reminders, timers, and status alerts from your Lobo pet."
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    private fun hasBluetoothPermission(): Boolean {
        val ctx = context
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun hasNotificationPermission(): Boolean {
        val ctx = context
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            NotificationManagerCompat.from(ctx).areNotificationsEnabled()
        }
    }

    private fun hasDndPolicyAccess(): Boolean {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        return nm.isNotificationPolicyAccessGranted
    }

    private fun buildPermissionsPayload(): JSObject {
        val bluetoothGranted = hasBluetoothPermission()
        val notificationsGranted = hasNotificationPermission()
        val dndGranted = hasDndPolicyAccess()

        return JSObject().apply {
            put("bluetooth", bluetoothGranted)
            put("notifications", notificationsGranted)
            put("dndAccess", dndGranted)
            put("standardApisReady", true)
            // Legacy fields retained for TypeScript compatibility
            put("notificationListener", false)
            put("accessibilityService", false)
            put("callPhone", false)
        }
    }

    // --- Standard Runtime Permission APIs ---

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionsPayload())
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        val permission = (call.getString("permission") ?: "ALL").uppercase()
        val ctx = context

        when (permission) {
            "BLUETOOTH" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasBluetoothPermission()) {
                    requestPermissionForAlias("bluetooth", call, "permissionResultCallback")
                } else {
                    val res = buildPermissionsPayload().apply {
                        put("granted", hasBluetoothPermission())
                        put("opened", false)
                    }
                    call.resolve(res)
                }
            }

            "NOTIFICATIONS" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    if (!hasNotificationPermission()) {
                        requestPermissionForAlias("notifications", call, "permissionResultCallback")
                    } else {
                        val res = buildPermissionsPayload().apply {
                            put("granted", true)
                            put("opened", false)
                        }
                        call.resolve(res)
                    }
                } else if (NotificationManagerCompat.from(ctx).areNotificationsEnabled()) {
                    val res = buildPermissionsPayload().apply {
                        put("granted", true)
                        put("opened", false)
                    }
                    call.resolve(res)
                } else {
                    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                    val res = buildPermissionsPayload().apply {
                        put("granted", false)
                        put("opened", true)
                    }
                    call.resolve(res)
                }
            }

            "DND" -> {
                if (hasDndPolicyAccess()) {
                    val res = buildPermissionsPayload().apply {
                        put("granted", true)
                        put("opened", false)
                    }
                    call.resolve(res)
                } else {
                    val intent = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                    val res = buildPermissionsPayload().apply {
                        put("granted", false)
                        put("opened", true)
                    }
                    call.resolve(res)
                }
            }

            "ALL" -> {
                val aliases = mutableListOf<String>()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasBluetoothPermission()) {
                    aliases.add("bluetooth")
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
                    aliases.add("notifications")
                }

                if (aliases.isNotEmpty()) {
                    requestPermissionForAliases(aliases.toTypedArray(), call, "permissionResultCallback")
                } else {
                    val granted = hasBluetoothPermission() && hasNotificationPermission()
                    val res = buildPermissionsPayload().apply {
                        put("granted", granted)
                        put("opened", false)
                    }
                    call.resolve(res)
                }
            }

            else -> {
                call.reject("Unsupported permission request: $permission")
            }
        }
    }

    @PermissionCallback
    fun permissionResultCallback(call: PluginCall) {
        val requested = (call.getString("permission") ?: "ALL").uppercase()
        val payload = buildPermissionsPayload().apply {
            val granted = when (requested) {
                "BLUETOOTH" -> optBoolean("bluetooth", false)
                "NOTIFICATIONS" -> optBoolean("notifications", false)
                "ALL" -> optBoolean("bluetooth", false) && optBoolean("notifications", false)
                else -> false
            }
            put("granted", granted)
            put("opened", false)
        }
        call.resolve(payload)
    }

    // --- Standard Local Notifications ---

    @PluginMethod
    fun postLocalNotification(call: PluginCall) {
        if (!hasNotificationPermission()) {
            call.resolve(JSObject().apply {
                put("success", false)
                put("permissionRequired", "NOTIFICATIONS")
            })
            return
        }

        val title = call.getString("title") ?: "Lobo Companion"
        val body = call.getString("body") ?: ""
        val notifId = call.getInt("id") ?: (System.currentTimeMillis() and 0x7fffffff).toInt()
        val iconRes = context.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info

        ensureNotificationChannel()
        val builder = NotificationCompat.Builder(context, ALERT_CHANNEL_ID)
            .setSmallIcon(iconRes)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)

        NotificationManagerCompat.from(context).notify(notifId, builder.build())
        call.resolve(JSObject().put("success", true).put("id", notifId))
    }

    @PluginMethod
    fun getRecentNotifications(call: PluginCall) {
        // Privileged NotificationListenerService intentionally disabled in Play-safe standard API build
        call.resolve(JSObject().apply {
            put("notifications", JSArray())
            put("standardApiOnly", true)
        })
    }

    @PluginMethod
    fun sendNotificationReply(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("success", false)
            put("reason", "Silent background reply is disabled in standard API mode")
        })
    }

    // --- Pillar 2: Standard Android Intent & Hardware Control Dispatcher ---

    @PluginMethod
    fun dispatchIntentAction(call: PluginCall) {
        val actionType = call.getString("actionType")?.uppercase()
        val params = call.getObject("params") ?: JSObject()
        val ctx = context

        try {
            when (actionType) {
                "CALL" -> {
                    // Uses standard ACTION_DIAL so the user confirms in the system dialer without CALL_PHONE permission
                    val phone = params.optString("phoneNumber", "").trim()
                    if (phone.isEmpty()) {
                        call.reject("Missing phoneNumber")
                        return
                    }
                    val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(phone))).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                    call.resolve(JSObject().put("success", true).put("mode", "ACTION_DIAL"))
                }

                "ALARM" -> {
                    val hour = params.optInt("hour", 7)
                    val minutes = params.optInt("minutes", 0)
                    val message = params.optString("message", "Lobo Alarm")
                    val skipUi = params.optBoolean("skipUi", false)

                    val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                        putExtra(AlarmClock.EXTRA_HOUR, hour)
                        putExtra(AlarmClock.EXTRA_MINUTES, minutes)
                        putExtra(AlarmClock.EXTRA_MESSAGE, message)
                        putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                    call.resolve(JSObject().put("success", true))
                }

                "TIMER" -> {
                    val seconds = params.optInt("seconds", 60)
                    val message = params.optString("message", "Lobo Timer")
                    val skipUi = params.optBoolean("skipUi", false)

                    val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                        putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                        putExtra(AlarmClock.EXTRA_MESSAGE, message)
                        putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                    call.resolve(JSObject().put("success", true))
                }

                "CALENDAR" -> {
                    val title = params.optString("title", "New Event")
                    val startTime = params.optLong("startTime", System.currentTimeMillis())
                    val endTime = params.optLong("endTime", startTime + 3600000)
                    val description = params.optString("description", "")

                    val intent = Intent(Intent.ACTION_INSERT).apply {
                        data = CalendarContract.Events.CONTENT_URI
                        putExtra(CalendarContract.Events.TITLE, title)
                        putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startTime)
                        putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endTime)
                        putExtra(CalendarContract.Events.DESCRIPTION, description)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                    call.resolve(JSObject().put("success", true))
                }

                "NAVIGATION" -> {
                    val destination = params.getString("destination") ?: ""
                    val mode = params.getString("mode", "driving") ?: "driving"
                    val mapsIntent = Intent(
                        Intent.ACTION_VIEW,
                        Uri.parse("google.navigation:q=" + Uri.encode(destination) + "&mode=" + Uri.encode(mode))
                    ).apply {
                        setPackage("com.google.android.apps.maps")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }

                    try {
                        ctx.startActivity(mapsIntent)
                    } catch (_: ActivityNotFoundException) {
                        val fallbackIntent = Intent(
                            Intent.ACTION_VIEW,
                            Uri.parse("geo:0,0?q=" + Uri.encode(destination))
                        ).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        ctx.startActivity(fallbackIntent)
                    }
                    call.resolve(JSObject().put("success", true))
                }

                "MEDIA" -> {
                    val command = params.getString("command", "PLAY_PAUSE")?.uppercase()
                    val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    val keyCode = when (command) {
                        "PLAY" -> KeyEvent.KEYCODE_MEDIA_PLAY
                        "PAUSE" -> KeyEvent.KEYCODE_MEDIA_PAUSE
                        "NEXT" -> KeyEvent.KEYCODE_MEDIA_NEXT
                        "PREVIOUS" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
                        else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                    }
                    audioManager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
                    audioManager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
                    call.resolve(JSObject().put("success", true))
                }

                "TORCH" -> {
                    if (!ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) {
                        call.reject("Device does not support camera flash")
                        return
                    }
                    val enable = params.optBoolean("enabled", !isTorchOn)
                    val cameraManager = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
                    val cameraId = findFlashCameraId(cameraManager)
                    if (cameraId == null) {
                        call.reject("No flash-capable camera unit available")
                        return
                    }
                    cameraManager.setTorchMode(cameraId, enable)
                    isTorchOn = enable
                    call.resolve(JSObject().apply {
                        put("success", true)
                        put("torchEnabled", isTorchOn)
                    })
                }

                "RINGER" -> {
                    val mode = params.getString("mode", "NORMAL")?.uppercase()
                    val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    val targetMode = when (mode) {
                        "SILENT" -> AudioManager.RINGER_MODE_SILENT
                        "VIBRATE" -> AudioManager.RINGER_MODE_VIBRATE
                        else -> AudioManager.RINGER_MODE_NORMAL
                    }

                    if (!hasDndPolicyAccess() &&
                        (targetMode == AudioManager.RINGER_MODE_SILENT || audioManager.ringerMode == AudioManager.RINGER_MODE_SILENT)
                    ) {
                        call.resolve(JSObject().apply {
                            put("success", false)
                            put("permissionRequired", "DND")
                        })
                        return
                    }

                    audioManager.ringerMode = targetMode
                    call.resolve(JSObject().put("success", true))
                }

                "DEEP_LINK" -> {
                    val rawUrl = params.getString("url")?.trim() ?: ""
                    val parsed = Uri.parse(rawUrl)
                    val scheme = parsed.scheme?.lowercase()
                    if (scheme == null || !ALLOWED_DEEP_LINK_SCHEMES.contains(scheme)) {
                        call.reject("Unsupported or unsafe deep link scheme")
                        return
                    }
                    val intent = Intent(Intent.ACTION_VIEW, parsed).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                    call.resolve(JSObject().put("success", true))
                }

                else -> {
                    call.reject("Unsupported intent actionType: $actionType")
                }
            }
        } catch (se: SecurityException) {
            Log.w(TAG, "Missing permission executing $actionType: ${se.message}")
            call.resolve(JSObject().apply {
                put("success", false)
                put("permissionRequired", actionType)
                put("error", se.message)
            })
        } catch (e: Exception) {
            Log.e(TAG, "Error executing intent action $actionType: ${e.message}", e)
            call.reject("Intent execution failed: ${e.message}")
        }
    }

    private fun findFlashCameraId(cameraManager: CameraManager): String? {
        var fallbackId: String? = null
        for (id in cameraManager.cameraIdList) {
            val chars = cameraManager.getCameraCharacteristics(id)
            val hasFlash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            if (!hasFlash) continue
            val facing = chars.get(CameraCharacteristics.LENS_FACING)
            if (facing == CameraCharacteristics.LENS_FACING_BACK) {
                return id
            }
            if (fallbackId == null) {
                fallbackId = id
            }
        }
        return fallbackId
    }

    // --- Pillar 3: Screen Automation Compatibility Endpoints ---

    @PluginMethod
    fun dumpAccessibilityTree(call: PluginCall) {
        call.reject("Screen inspection via AccessibilityService is disabled in the Play-safe standard API build")
    }

    @PluginMethod
    fun performAccessibilityAction(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("success", false)
            put("reason", "Accessibility UI automation is disabled in standard API mode")
        })
    }

    @PluginMethod
    fun performGlobalAction(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("success", false)
            put("reason", "Accessibility global gestures are disabled in standard API mode")
        })
    }

    // --- Pillar 4: Pocket Vault Auto-Sync & Staging ---

    @PluginMethod
    fun getPendingShareFiles(call: PluginCall) {
        val files = PetBotShareReceiverActivity.getPendingStagedFiles(context)
        val arr = JSArray()

        for (f in files) {
            val item = JSObject().apply {
                put("id", f.id)
                put("fileName", f.fileName)
                put("mimeType", f.mimeType)
                put("sizeBytes", f.sizeBytes)
                put("filePath", f.filePath)
                put("stagedTimestamp", f.stagedTimestamp)

                if (f.sizeBytes < 20 * 1024 * 1024) {
                    val fileObj = File(f.filePath)
                    if (fileObj.exists()) {
                        val bytes = FileInputStream(fileObj).use { it.readBytes() }
                        put("base64Data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    }
                }
            }
            arr.put(item)
        }

        call.resolve(JSObject().put("files", arr))
    }

    @PluginMethod
    fun clearPendingShareFiles(call: PluginCall) {
        val cleared = PetBotShareReceiverActivity.clearPendingStagedFiles(context)
        call.resolve(JSObject().put("cleared", cleared))
    }

    // --- System Telemetry ---

    @PluginMethod
    fun getMobileTelemetry(call: PluginCall) {
        val ctx = context
        val batteryManager = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val rawBatteryPct = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val batteryPct = if (rawBatteryPct in 0..100) rawBatteryPct else 100
        val isCharging = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val status = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS)
            status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        } else {
            false
        }

        val connManager = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val networkType = connManager.activeNetwork?.let { network ->
            val caps = connManager.getNetworkCapabilities(network)
            when {
                caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "WIFI"
                caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "CELLULAR"
                else -> "OTHER"
            }
        } ?: "NONE"

        val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val ringer = when (audioManager.ringerMode) {
            AudioManager.RINGER_MODE_SILENT -> "SILENT"
            AudioManager.RINGER_MODE_VIBRATE -> "VIBRATE"
            else -> "NORMAL"
        }

        val res = JSObject().apply {
            put("batteryPct", batteryPct)
            put("isCharging", isCharging)
            put("networkType", networkType)
            put("ringerMode", ringer)
            put("torchEnabled", isTorchOn)
            put("permissions", buildPermissionsPayload())
        }
        call.resolve(res)
    }
}
