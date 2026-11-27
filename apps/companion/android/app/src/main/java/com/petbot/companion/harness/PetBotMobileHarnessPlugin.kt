package com.petbot.companion.harness

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
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
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.MediaStore
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
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
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

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
            strings = [Manifest.permission.ACCESS_FINE_LOCATION],
            alias = "location"
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

        private val PETBOT_SERVICE_UUID: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        private val PETBOT_CHAR_RX_UUID: UUID = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
        private val PETBOT_CHAR_TX_UUID: UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    private var isTorchOn = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val bleWriteExecutor = Executors.newSingleThreadExecutor()
    private val ttsExecutor = Executors.newSingleThreadExecutor()
    private var ttsEngine: TextToSpeech? = null
    @Volatile private var ttsReady = false
    private val ttsInitLatch = CountDownLatch(1)
    private val bleLock = Any()
    private var activeGatt: BluetoothGatt? = null
    private var activeRxChar: BluetoothGattCharacteristic? = null
    private var activeTxChar: BluetoothGattCharacteristic? = null
    private var currentMtuPayloadBytes = 240
    private var pendingConnectCall: PluginCall? = null
    private var activeScanCallback: ScanCallback? = null
    private var activeScanner: BluetoothLeScanner? = null
    private var scanTimeoutRunnable: Runnable? = null
    private var writeAckLatch: CountDownLatch? = null
    private var lastWriteOk = false

    override fun load() {
        super.load()
        ensureNotificationChannel()
        try {
            ttsEngine = TextToSpeech(context.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    ttsEngine?.language = Locale.getDefault()
                    ttsReady = true
                }
                ttsInitLatch.countDown()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "TextToSpeech init deferred/failed: ${t.message}")
            ttsInitLatch.countDown()
        }
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
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
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
                } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && !hasBluetoothPermission()) {
                    requestPermissionForAlias("location", call, "permissionResultCallback")
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

                "OPEN_APP" -> {
                    val requested = params.optString("appName", "").trim()
                    if (requested.isEmpty()) {
                        call.resolve(JSObject().put("success", false).put("error", "No app name specified"))
                        return
                    }

                    val lower = requested.lowercase(Locale.getDefault())
                    if (lower == "settings" || lower == "phone settings") {
                        val intent = Intent(Settings.ACTION_SETTINGS).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
                        ctx.startActivity(intent)
                        call.resolve(JSObject().put("success", true).put("appName", "Settings"))
                        return
                    }
                    if (lower == "camera") {
                        val camIntent = Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        try {
                            ctx.startActivity(camIntent)
                            call.resolve(JSObject().put("success", true).put("appName", "Camera"))
                            return
                        } catch (_: Throwable) {
                            // Fall through to launcher package scan
                        }
                    }

                    val pm = ctx.packageManager
                    val mainIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                    val apps = pm.queryIntentActivities(mainIntent, 0)
                    val normalizedQuery = lower.replace(" ", "")

                    var bestPkg: String? = null
                    var bestLabel: String? = null
                    for (ri in apps) {
                        val pkg = ri.activityInfo?.packageName ?: continue
                        val label = ri.loadLabel(pm).toString()
                        val labelLower = label.lowercase(Locale.getDefault())
                        if (labelLower == lower || labelLower.replace(" ", "") == normalizedQuery) {
                            bestPkg = pkg
                            bestLabel = label
                            break
                        }
                        if (bestPkg == null && (labelLower.contains(lower) || pkg.lowercase(Locale.getDefault()).contains(normalizedQuery))) {
                            bestPkg = pkg
                            bestLabel = label
                        }
                    }

                    if (bestPkg == null) {
                        val knownPackages = mapOf(
                            "youtube" to "com.google.android.youtube",
                            "whatsapp" to "com.whatsapp",
                            "chrome" to "com.android.chrome",
                            "instagram" to "com.instagram.android",
                            "spotify" to "com.spotify.music",
                            "maps" to "com.google.android.apps.maps",
                            "googlemaps" to "com.google.android.apps.maps",
                            "gmail" to "com.google.android.gm",
                            "photos" to "com.google.android.apps.photos",
                            "gallery" to "com.google.android.apps.photos",
                            "calculator" to "com.google.android.calculator",
                            "clock" to "com.google.android.deskclock",
                            "calendar" to "com.google.android.calendar",
                            "messages" to "com.google.android.apps.messaging",
                            "playstore" to "com.android.vending"
                        )
                        val aliasPkg = knownPackages[normalizedQuery]
                        if (aliasPkg != null && pm.getLaunchIntentForPackage(aliasPkg) != null) {
                            bestPkg = aliasPkg
                            bestLabel = requested
                        }
                    }

                    if (bestPkg != null) {
                        val launchIntent = pm.getLaunchIntentForPackage(bestPkg)?.apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        if (launchIntent != null) {
                            ctx.startActivity(launchIntent)
                            call.resolve(JSObject().put("success", true).put("appName", bestLabel ?: requested).put("packageName", bestPkg))
                            return
                        }
                    }

                    call.resolve(JSObject().put("success", false).put("error", "App '$requested' not found on this phone"))
                }

                "SEARCH_WEB" -> {
                    val q = params.optString("query", "").trim()
                    val target = params.optString("target", "google").lowercase(Locale.getDefault())
                    if (q.isEmpty()) {
                        call.resolve(JSObject().put("success", false).put("error", "Empty search query"))
                        return
                    }
                    val url = if (target == "youtube") {
                        "https://www.youtube.com/results?search_query=" + Uri.encode(q)
                    } else {
                        "https://www.google.com/search?q=" + Uri.encode(q)
                    }
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                    call.resolve(JSObject().put("success", true).put("url", url))
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

    // --- Standard Native Android BLE GATT Bridge ---

    @SuppressLint("MissingPermission")
    private fun cleanupBleConnection(notifyJs: Boolean) {
        scanTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        scanTimeoutRunnable = null

        activeScanCallback?.let { cb ->
            try {
                activeScanner?.stopScan(cb)
            } catch (_: Throwable) {
            }
        }
        activeScanCallback = null
        activeScanner = null

        val gattToClose: BluetoothGatt?
        synchronized(bleLock) {
            gattToClose = activeGatt
            activeGatt = null
            activeRxChar = null
            activeTxChar = null
            currentMtuPayloadBytes = 240
            lastWriteOk = false
            writeAckLatch?.countDown()
        }

        if (gattToClose != null) {
            try {
                gattToClose.disconnect()
                gattToClose.close()
            } catch (_: Throwable) {
            }
            if (notifyJs) {
                notifyListeners("bleDisconnected", JSObject())
            }
        }
    }

    private fun resolvePendingConnect(connected: Boolean, error: String? = null, deviceName: String? = null, address: String? = null) {
        val call = synchronized(bleLock) {
            val c = pendingConnectCall
            pendingConnectCall = null
            c
        } ?: return

        val res = JSObject().apply {
            put("connected", connected)
            if (error != null) put("error", error)
            if (deviceName != null) put("deviceName", deviceName)
            if (address != null) put("address", address)
            put("mtuPayloadBytes", currentMtuPayloadBytes)
        }
        call.resolve(res)
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    fun connectBleDevice(call: PluginCall) {
        val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter: BluetoothAdapter? = btManager?.adapter
        if (adapter == null) {
            call.resolve(JSObject().put("connected", false).put("error", "Bluetooth hardware unavailable"))
            return
        }
        if (!adapter.isEnabled) {
            call.resolve(JSObject().put("connected", false).put("error", "Please turn on Bluetooth in phone settings"))
            return
        }
        if (!hasBluetoothPermission()) {
            call.resolve(JSObject().put("connected", false).put("error", "Bluetooth permission is required to scan"))
            return
        }

        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            call.resolve(JSObject().put("connected", false).put("error", "Bluetooth LE scanner unavailable"))
            return
        }

        val timeoutMs = (call.getInt("timeoutMs") ?: 8000).toLong().coerceIn(2500L, 15000L)
        resolvePendingConnect(false, "Superseded by new scan")
        cleanupBleConnection(false)

        synchronized(bleLock) {
            pendingConnectCall = call
        }

        val gattCallback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS && newState != BluetoothProfile.STATE_CONNECTED) {
                    Log.w(TAG, "GATT connection state failed status=$status newState=$newState")
                    cleanupBleConnection(true)
                    resolvePendingConnect(false, "BLE connection failed (status $status)")
                    return
                }

                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    synchronized(bleLock) { activeGatt = gatt }
                    val mtuOk = try {
                        gatt.requestMtu(512)
                    } catch (_: Throwable) {
                        false
                    }
                    if (!mtuOk) {
                        mainHandler.post { gatt.discoverServices() }
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    cleanupBleConnection(true)
                    resolvePendingConnect(false, "Device disconnected during pairing")
                }
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS && mtu > 23) {
                    currentMtuPayloadBytes = (mtu - 3).coerceIn(20, 505)
                }
                mainHandler.post { gatt.discoverServices() }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    cleanupBleConnection(false)
                    resolvePendingConnect(false, "Service discovery failed ($status)")
                    return
                }

                try {
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                } catch (_: Throwable) {
                }

                val service = gatt.getService(PETBOT_SERVICE_UUID)
                val rxChar = service?.getCharacteristic(PETBOT_CHAR_RX_UUID)
                val txChar = service?.getCharacteristic(PETBOT_CHAR_TX_UUID)

                if (service == null || rxChar == null || txChar == null) {
                    cleanupBleConnection(false)
                    resolvePendingConnect(false, "PetBot BLE service characteristics missing")
                    return
                }

                synchronized(bleLock) {
                    activeRxChar = rxChar
                    activeTxChar = txChar
                }

                gatt.setCharacteristicNotification(txChar, true)
                val cccd = txChar.getDescriptor(CCCD_UUID)
                if (cccd == null) {
                    resolvePendingConnect(
                        true,
                        deviceName = gatt.device?.name ?: "PetBot-Agent",
                        address = gatt.device?.address
                    )
                    return
                }

                val wrote = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
                } else {
                    @Suppress("DEPRECATION")
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(cccd)
                }
                if (!wrote) {
                    cleanupBleConnection(false)
                    resolvePendingConnect(false, "Failed to subscribe to robot BLE notifications")
                }
            }

            override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    resolvePendingConnect(
                        true,
                        deviceName = gatt.device?.name ?: "PetBot-Agent",
                        address = gatt.device?.address
                    )
                } else {
                    cleanupBleConnection(false)
                    resolvePendingConnect(false, "BLE notification enable failed ($status)")
                }
            }

            override fun onCharacteristicWrite(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int
            ) {
                lastWriteOk = (status == BluetoothGatt.GATT_SUCCESS)
                writeAckLatch?.countDown()
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray
            ) {
                if (characteristic.uuid == PETBOT_CHAR_TX_UUID && value.isNotEmpty()) {
                    val b64 = Base64.encodeToString(value, Base64.NO_WRAP)
                    notifyListeners("bleRxData", JSObject().put("base64", b64))
                }
            }

            @Deprecated("Used on Android < 13")
            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic
            ) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && characteristic.uuid == PETBOT_CHAR_TX_UUID) {
                    @Suppress("DEPRECATION")
                    val bytes = characteristic.value
                    if (bytes != null && bytes.isNotEmpty()) {
                        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                        notifyListeners("bleRxData", JSObject().put("base64", b64))
                    }
                }
            }
        }

        val scanCb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val hasUuid = result.scanRecord?.serviceUuids?.any { it.uuid == PETBOT_SERVICE_UUID } == true
                val devName = result.device.name ?: result.scanRecord?.deviceName ?: ""
                val hasName = devName.startsWith("PetBot", ignoreCase = true) || devName.startsWith("Lobo", ignoreCase = true)
                if (!hasUuid && !hasName) {
                    return
                }

                scanTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
                scanTimeoutRunnable = null
                try {
                    scanner.stopScan(this)
                } catch (_: Throwable) {
                }
                activeScanCallback = null

                Log.i(TAG, "Matched BLE robot: name='$devName' addr=${result.device.address} rssi=${result.rssi}")
                mainHandler.post {
                    result.device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
                }
            }

            override fun onScanFailed(errorCode: Int) {
                scanTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
                scanTimeoutRunnable = null
                activeScanCallback = null
                resolvePendingConnect(false, "BLE scan failed (code $errorCode)")
            }
        }

        activeScanner = scanner
        activeScanCallback = scanCb

        val timeoutTask = Runnable {
            try {
                scanner.stopScan(scanCb)
            } catch (_: Throwable) {
            }
            activeScanCallback = null
            resolvePendingConnect(false, "No nearby Lobo found via Bluetooth. Ensure Lobo is powered on.")
        }
        scanTimeoutRunnable = timeoutTask
        mainHandler.postDelayed(timeoutTask, timeoutMs)

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        scanner.startScan(null, settings, scanCb)
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    fun writeBleRx(call: PluginCall) {
        val b64 = call.getString("base64") ?: ""
        val noResponse = call.getBoolean("noResponse") ?: false
        if (b64.isEmpty()) {
            call.resolve(JSObject().put("success", false))
            return
        }

        val bytes = try {
            Base64.decode(b64, Base64.DEFAULT)
        } catch (_: Throwable) {
            call.resolve(JSObject().put("success", false))
            return
        }

        bleWriteExecutor.execute {
            val gatt: BluetoothGatt?
            val rxChar: BluetoothGattCharacteristic?
            val chunkCap: Int
            synchronized(bleLock) {
                gatt = activeGatt
                rxChar = activeRxChar
                chunkCap = currentMtuPayloadBytes.coerceIn(20, 505)
            }

            if (gatt == null || rxChar == null) {
                call.resolve(JSObject().put("success", false))
                return@execute
            }

            val writeType = if (noResponse) {
                BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            } else {
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            }

            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(offset + chunkCap, bytes.size)
                val slice = bytes.copyOfRange(offset, end)
                val latch = CountDownLatch(1)
                writeAckLatch = latch
                lastWriteOk = false

                val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeCharacteristic(rxChar, slice, writeType) == BluetoothStatusCodes.SUCCESS
                } else {
                    @Suppress("DEPRECATION")
                    rxChar.value = slice
                    rxChar.writeType = writeType
                    @Suppress("DEPRECATION")
                    gatt.writeCharacteristic(rxChar)
                }

                if (!started) {
                    call.resolve(JSObject().put("success", false))
                    return@execute
                }

                val awaited = latch.await(if (noResponse) 250L else 2500L, TimeUnit.MILLISECONDS)
                if ((!noResponse && (!awaited || !lastWriteOk))) {
                    call.resolve(JSObject().put("success", false))
                    return@execute
                }
                if (noResponse) {
                    try {
                        Thread.sleep(2)
                    } catch (_: InterruptedException) {
                    }
                }

                offset = end
            }

            call.resolve(JSObject().put("success", true))
        }
    }

    @PluginMethod
    fun disconnectBle(call: PluginCall) {
        resolvePendingConnect(false, "Disconnected")
        cleanupBleConnection(false)
        call.resolve(JSObject().put("disconnected", true))
    }

    @PluginMethod
    fun synthesizeSpeechToWav(call: PluginCall) {
        val text = (call.getString("text") ?: "").trim()
        if (text.isEmpty()) {
            call.resolve(JSObject().put("success", false).put("error", "Empty text"))
            return
        }

        ttsExecutor.execute {
            if (!ttsReady) {
                try {
                    ttsInitLatch.await(1500, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                }
            }
            val tts = ttsEngine
            if (!ttsReady || tts == null) {
                call.resolve(JSObject().put("success", false).put("error", "Android TTS engine not ready"))
                return@execute
            }

            val uttId = "lobo_${System.currentTimeMillis()}"
            val outFile = File(context.cacheDir, "$uttId.wav")
            val latch = CountDownLatch(1)
            var synthOk = false

            tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) {
                    if (utteranceId == uttId) {
                        synthOk = true
                        latch.countDown()
                    }
                }
                @Deprecated("Required for API compat")
                override fun onError(utteranceId: String?) {
                    if (utteranceId == uttId) latch.countDown()
                }
                override fun onError(utteranceId: String?, errorCode: Int) {
                    if (utteranceId == uttId) latch.countDown()
                }
            })

            val params = Bundle()
            val queued = tts.synthesizeToFile(text, params, outFile, uttId)
            if (queued != TextToSpeech.SUCCESS) {
                outFile.delete()
                call.resolve(JSObject().put("success", false).put("error", "TTS queue failed ($queued)"))
                return@execute
            }

            val completed = latch.await(8000, TimeUnit.MILLISECONDS)
            if (!completed || !synthOk || !outFile.exists()) {
                outFile.delete()
                call.resolve(JSObject().put("success", false).put("error", "TTS synthesis timeout"))
                return@execute
            }

            try {
                val wavBytes = outFile.readBytes()
                val pcm16k = extractAndResampleWavTo16kMono(wavBytes)
                val base64Pcm = Base64.encodeToString(pcm16k, Base64.NO_WRAP)
                val durationMs = ((pcm16k.size / 2.0) / 16.0).roundToInt()
                call.resolve(JSObject().apply {
                    put("success", true)
                    put("sampleRate", 16000)
                    put("durationMs", durationMs)
                    put("base64Pcm", base64Pcm)
                })
            } catch (e: Exception) {
                call.resolve(JSObject().put("success", false).put("error", "WAV resample error: ${e.message}"))
            } finally {
                outFile.delete()
            }
        }
    }

    private fun extractAndResampleWavTo16kMono(wavBytes: ByteArray): ByteArray {
        if (wavBytes.size < 44) return ByteArray(0)
        val bb = ByteBuffer.wrap(wavBytes).order(ByteOrder.LITTLE_ENDIAN)

        var channels = 1
        var srcRate = 22050
        var bitsPerSample = 16
        var dataOffset = 44
        var dataSize = wavBytes.size - 44

        var pos = 12
        while (pos + 8 <= wavBytes.size) {
            val id = String(wavBytes, pos, 4, Charsets.US_ASCII)
            val chunkSize = bb.getInt(pos + 4).coerceAtLeast(0)
            val payloadPos = pos + 8
            if (id == "fmt " && payloadPos + 16 <= wavBytes.size) {
                channels = bb.getShort(payloadPos + 2).toInt().coerceIn(1, 2)
                srcRate = bb.getInt(payloadPos + 4).coerceIn(8000, 96000)
                bitsPerSample = bb.getShort(payloadPos + 14).toInt().coerceIn(8, 32)
            } else if (id == "data" && payloadPos <= wavBytes.size) {
                dataOffset = payloadPos
                dataSize = minOf(chunkSize, wavBytes.size - payloadPos)
                break
            }
            pos = payloadPos + chunkSize + (chunkSize and 1)
        }

        val bytesPerFrame = (bitsPerSample / 8) * channels
        if (bytesPerFrame <= 0 || dataSize <= 0) return ByteArray(0)
        val srcFrames = dataSize / bytesPerFrame
        if (srcFrames <= 0) return ByteArray(0)

        val monoSrc = ShortArray(srcFrames)
        for (i in 0 until srcFrames) {
            val framePos = dataOffset + i * bytesPerFrame
            var sum = 0
            for (ch in 0 until channels) {
                val sPos = framePos + ch * (bitsPerSample / 8)
                val sample = when (bitsPerSample) {
                    8 -> ((wavBytes[sPos].toInt() and 0xFF) - 128) shl 8
                    16 -> bb.getShort(sPos).toInt()
                    else -> bb.getShort(sPos + ((bitsPerSample / 8) - 2)).toInt()
                }
                sum += sample
            }
            monoSrc[i] = (sum / channels).coerceIn(-32768, 32767).toShort()
        }

        val dstFrames = ((srcFrames.toLong() * 16000L) / srcRate.toLong()).toInt().coerceAtLeast(1)
        val out = ByteArray(dstFrames * 2)
        val outBb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until dstFrames) {
            val srcPos = (i.toDouble() * srcFrames) / dstFrames
            val i0 = srcPos.toInt().coerceIn(0, srcFrames - 1)
            val i1 = (i0 + 1).coerceIn(0, srcFrames - 1)
            val frac = srcPos - i0
            val interp = (monoSrc[i0] * (1.0 - frac) + monoSrc[i1] * frac).roundToInt().coerceIn(-32767, 32767)
            outBb.putShort(i * 2, interp.toShort())
        }
        return out
    }

    override fun handleOnDestroy() {
        cleanupBleConnection(false)
        try {
            ttsEngine?.stop()
            ttsEngine?.shutdown()
        } catch (_: Throwable) {
        }
        ttsExecutor.shutdownNow()
        bleWriteExecutor.shutdownNow()
        super.handleOnDestroy()
    }
}
