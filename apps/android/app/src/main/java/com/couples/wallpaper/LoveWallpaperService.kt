package com.couples.wallpaper

import android.app.KeyguardManager
import android.content.Context
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder

/**
 * The live wallpaper: shows the couple's newest canvas, redrawing as the partner draws.
 * Privacy: while the phone is locked it shows a neutral placeholder (default; the user can turn that off in the app).
 */
class LoveWallpaperService : WallpaperService() {
    override fun onCreateEngine(): Engine = LoveEngine()

    inner class LoveEngine : Engine() {
        private val handler = Handler(Looper.getMainLooper())
        private val renderer = CanvasRenderer()
        private var visible = false
        private var acquired = false
        private var width = 0
        private var height = 0
        private var lastVersion = -1L
        private var lastLocked: Boolean? = null

        override fun onCreate(surfaceHolder: SurfaceHolder?) {
            super.onCreate(surfaceHolder)
            SyncHub.init(applicationContext) // must exist before the first surface callback
        }

        private val tick = object : Runnable {
            override fun run() {
                drawIfChanged()
                if (visible) handler.postDelayed(this, 33) // ~30 fps while visible; frames are skipped when nothing changed
            }
        }

        override fun onVisibilityChanged(isVisible: Boolean) {
            visible = isVisible
            if (isVisible) {
                if (!acquired) { SyncHub.acquire(applicationContext); acquired = true }
                lastVersion = -1
                handler.post(tick)
            } else {
                handler.removeCallbacks(tick)
                if (acquired) { SyncHub.release(); acquired = false }
            }
        }

        override fun onSurfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {
            width = w; height = h; lastVersion = -1
            drawIfChanged()
        }

        override fun onDestroy() {
            handler.removeCallbacks(tick)
            if (acquired) { SyncHub.release(); acquired = false }
        }

        private fun isLocked(): Boolean =
            (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked

        private fun drawIfChanged() {
            if (width == 0 || height == 0) return
            val hide = SyncHub.store.hideWhenLocked && isLocked()
            val v = SyncHub.version
            if (v == lastVersion && lastLocked == hide) return
            lastVersion = v; lastLocked = hide
            var c: Canvas? = null
            try {
                c = surfaceHolder.lockCanvas() ?: return
                if (hide || SyncHub.status != SyncHub.Status.LIVE) {
                    renderer.drawPlaceholder(c, width, height, SyncHub.scene.bg.color)
                } else {
                    renderer.drawScene(c, width, height, SyncHub.scene, SyncHub.live.values)
                }
            } catch (_: Exception) {
                // surface may disappear mid-draw; the next frame will retry
            } finally {
                if (c != null) try { surfaceHolder.unlockCanvasAndPost(c) } catch (_: Exception) { }
            }
        }
    }
}
