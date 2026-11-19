package com.gnomecannon.everythingapp

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallArgs {
    lateinit var path: String
}

/**
 * Hands a newer Aeneas to Android's package installer (appupdate.rs checked its signature first). Android shows its
 * own prompt and installs it only when it is signed with the same key as this app, so nothing else can replace it.
 */
@TauriPlugin
class ApkInstallPlugin(private val activity: Activity) : Plugin(activity) {
    private fun dirForUpdates(): File = File(activity.cacheDir, "updates").apply { mkdirs() }

    /** The folder an update is saved to: inside the app's own cache, which the app's file provider shares. */
    @Command
    fun updatesDir(invoke: Invoke) {
        val dir = dirForUpdates()
        // Only the newest update is kept.
        dir.listFiles()?.forEach { it.delete() }
        val ret = JSObject()
        ret.put("dir", dir.absolutePath)
        invoke.resolve(ret)
    }

    @Command
    fun install(invoke: Invoke) {
        val args = invoke.parseArgs(InstallArgs::class.java)
        val file = File(args.path)
        if (!file.isFile || file.canonicalFile.parentFile != dirForUpdates().canonicalFile) {
            invoke.reject("not an update file")
            return
        }
        val ret = JSObject()
        // Android 8 and later ask once whether this app may install apps; the page says to press Update again after.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
            ret.put("state", "permission")
            invoke.resolve(ret)
            return
        }
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        ret.put("state", "prompted")
        invoke.resolve(ret)
    }
}
