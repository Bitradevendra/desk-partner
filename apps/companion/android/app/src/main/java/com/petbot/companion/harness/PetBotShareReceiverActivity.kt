package com.petbot.companion.harness

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * PetBot Mobile "Send & Collect" Share Receiver
 *
 * Receives incoming Android Share Sheet intents (ACTION_SEND / ACTION_SEND_MULTIPLE)
 * when the user explicitly shares images, PDFs, audio clips, or text to "Lobo Pocket Vault".
 * Copies payloads safely into the app cache staging directory for ESP32-S3 MicroSD upload.
 */
class PetBotShareReceiverActivity : Activity() {

    companion object {
        private const val TAG = "PetBotShareReceiver"
        const val STAGING_DIR = "petbot-vault-staging"

        data class StagedVaultFile(
            val id: String,
            val fileName: String,
            val mimeType: String,
            val sizeBytes: Long,
            val filePath: String,
            val stagedTimestamp: Long
        )

        private val memoryRegistry = CopyOnWriteArrayList<StagedVaultFile>()

        fun getStagingDir(context: Context): File {
            val dir = File(context.cacheDir, STAGING_DIR)
            if (!dir.exists()) {
                dir.mkdirs()
            }
            return dir
        }

        fun getPendingStagedFiles(context: Context): List<StagedVaultFile> {
            val dir = getStagingDir(context)
            val files = dir.listFiles() ?: return emptyList()
            val list = mutableListOf<StagedVaultFile>()

            for (f in files) {
                if (f.isFile) {
                    val mime = context.contentResolver.getType(Uri.fromFile(f)) ?: "application/octet-stream"
                    list.add(
                        StagedVaultFile(
                            id = f.name,
                            fileName = f.name,
                            mimeType = mime,
                            sizeBytes = f.length(),
                            filePath = f.absolutePath,
                            stagedTimestamp = f.lastModified()
                        )
                    )
                }
            }
            return list
        }

        fun clearPendingStagedFiles(context: Context): Boolean {
            val dir = getStagingDir(context)
            var allDeleted = true
            dir.listFiles()?.forEach { file ->
                if (!file.delete()) {
                    allDeleted = false
                }
            }
            memoryRegistry.clear()
            return allDeleted
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        try {
            when (intent?.action) {
                Intent.ACTION_SEND -> handleSingleSend(intent)
                Intent.ACTION_SEND_MULTIPLE -> handleMultipleSend(intent)
                else -> {
                    Log.w(TAG, "Unhandled intent action: ${intent?.action}")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to process shared file: ${e.message}", e)
            Toast.makeText(this, "Lobo Vault: Failed to import file", Toast.LENGTH_SHORT).show()
        } finally {
            finish()
        }
    }

    private fun extractSingleUri(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }

    private fun extractMultipleUris(intent: Intent): ArrayList<Uri>? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        }

    private fun sanitizeFileName(raw: String): String {
        val base = File(raw).name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        return base.takeIf { it.isNotBlank() && it != "." && it != ".." }
            ?: "shared_${System.currentTimeMillis()}.bin"
    }

    private fun handleSingleSend(intent: Intent) {
        val uri = extractSingleUri(intent)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)

        if (uri != null) {
            saveUriToStaging(uri, intent.type)
        } else if (!text.isNullOrBlank()) {
            saveTextToStaging(text)
        }
    }

    private fun handleMultipleSend(intent: Intent) {
        val uris = extractMultipleUris(intent) ?: return
        for (uri in uris) {
            saveUriToStaging(uri, intent.type)
        }
    }

    private fun saveUriToStaging(uri: Uri, mimeType: String?) {
        val rawName = queryFileName(uri) ?: "shared_${System.currentTimeMillis()}.${getExtFromMime(mimeType)}"
        val safeName = sanitizeFileName(rawName)
        val stagingDir = getStagingDir(this)
        val targetFile = File(stagingDir, safeName)

        contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(targetFile).use { output ->
                input.copyTo(output)
            }
        }

        val item = StagedVaultFile(
            id = UUID.randomUUID().toString(),
            fileName = targetFile.name,
            mimeType = mimeType ?: "application/octet-stream",
            sizeBytes = targetFile.length(),
            filePath = targetFile.absolutePath,
            stagedTimestamp = System.currentTimeMillis()
        )
        memoryRegistry.add(item)

        Log.i(TAG, "Staged shared file for Lobo MicroSD: ${targetFile.name} (${targetFile.length()} bytes)")
        Toast.makeText(this, "Saved ${targetFile.name} to Lobo Pocket Vault", Toast.LENGTH_SHORT).show()
    }

    private fun saveTextToStaging(text: String) {
        val stagingDir = getStagingDir(this)
        val fileName = "quick_note_${System.currentTimeMillis()}.txt"
        val targetFile = File(stagingDir, fileName)

        targetFile.writeText(text, Charsets.UTF_8)

        val item = StagedVaultFile(
            id = UUID.randomUUID().toString(),
            fileName = fileName,
            mimeType = "text/plain",
            sizeBytes = targetFile.length(),
            filePath = targetFile.absolutePath,
            stagedTimestamp = System.currentTimeMillis()
        )
        memoryRegistry.add(item)

        Log.i(TAG, "Staged shared text note for Lobo MicroSD: $fileName")
        Toast.makeText(this, "Saved Note to Lobo Pocket Vault", Toast.LENGTH_SHORT).show()
    }

    private fun queryFileName(uri: Uri): String? {
        var name: String? = null
        if (uri.scheme == "content") {
            val cursor = contentResolver.query(uri, null, null, null, null)
            cursor?.use {
                if (it.moveToFirst()) {
                    val nameIndex = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex != -1) {
                        name = it.getString(nameIndex)
                    }
                }
            }
        }
        if (name == null) {
            name = uri.path?.let { File(it).name }
        }
        return name
    }

    private fun getExtFromMime(mime: String?): String {
        return when (mime) {
            "image/jpeg" -> "jpg"
            "image/png" -> "png"
            "image/webp" -> "webp"
            "audio/wav" -> "wav"
            "audio/mpeg" -> "mp3"
            "application/pdf" -> "pdf"
            "text/plain" -> "txt"
            else -> "bin"
        }
    }
}
