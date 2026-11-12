package com.couples.wallpaper

import android.graphics.BitmapFactory
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.MediaController
import android.widget.TextView
import android.widget.VideoView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class NativeMediaPreviewActivity : ComponentActivity() {
    private var temporaryFile: File? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        val status = TextView(this).apply { text = "Loading attachment…" }
        root.addView(status)
        setContentView(root)

        val descriptor = runCatching {
            NativeMediaDescriptor(
                id = intent.getStringExtra(EXTRA_ID) ?: error("Missing media id."),
                key = intent.getStringExtra(EXTRA_KEY) ?: error("Missing media key."),
                mime = intent.getStringExtra(EXTRA_MIME) ?: error("Missing media type."),
                size = intent.getIntExtra(EXTRA_SIZE, -1),
            )
        }.getOrElse {
            status.text = "This attachment cannot be opened."
            return
        }

        lifecycleScope.launch {
            runCatching {
                val bytes = NativeMediaUploader.download(descriptor)
                showMedia(root, status, descriptor.mime, bytes)
            }.onFailure {
                status.text = it.message ?: "This attachment could not be opened."
            }
        }
    }

    private suspend fun showMedia(
        root: LinearLayout,
        status: TextView,
        mime: String,
        bytes: ByteArray,
    ) {
        if (mime.startsWith("image/")) {
            val bitmap = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
                ?: error("Invalid image data.")
            status.text = ""
            val image = ImageView(this).apply {
                setImageBitmap(bitmap)
                adjustViewBounds = true
            }
            root.addView(image, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            return
        }

        val suffix = if (mime.startsWith("video/")) ".video" else ".audio"
        val file = withContext(Dispatchers.IO) {
            File.createTempFile("uspace-media-", suffix, cacheDir).also { it.writeBytes(bytes) }
        }
        temporaryFile = file
        status.text = ""
        if (mime.startsWith("video/")) {
            val video = VideoView(this).apply {
                setMediaController(MediaController(this@NativeMediaPreviewActivity))
                setVideoPath(file.absolutePath)
                start()
            }
            root.addView(video, ViewGroup.LayoutParams.MATCH_PARENT, 600)
        } else if (mime.startsWith("audio/")) {
            val audio = android.media.MediaPlayer().apply {
                setDataSource(file.absolutePath)
                prepare()
            }
            val play = Button(this).apply {
                text = "Play audio"
                setOnClickListener {
                    if (audio.isPlaying) {
                        audio.pause()
                        text = "Play audio"
                    } else {
                        audio.start()
                        text = "Pause audio"
                    }
                }
            }
            root.addView(play, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lifecycle.addObserver(object : androidx.lifecycle.DefaultLifecycleObserver {
                override fun onDestroy(owner: androidx.lifecycle.LifecycleOwner) {
                    audio.release()
                }
            })
        } else {
            error("Unsupported media type.")
        }
    }

    override fun onDestroy() {
        temporaryFile?.delete()
        temporaryFile = null
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ID = "media_id"
        const val EXTRA_KEY = "media_key"
        const val EXTRA_MIME = "media_mime"
        const val EXTRA_SIZE = "media_size"
    }
}
