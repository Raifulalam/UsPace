package com.couples.wallpaper.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.couples.wallpaper.SyncHub
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class NativeSessionState(
    val loading: Boolean = true,
    val authenticated: Boolean = false,
    val userId: String? = null,
    val error: String? = null,
)

class NativeSessionViewModel : ViewModel() {
    private val _state = MutableStateFlow(NativeSessionState())
    val state: StateFlow<NativeSessionState> = _state.asStateFlow()

    fun initialize() {
        if (_state.value.loading.not()) return
        viewModelScope.launch {
            val store = SyncHub.store
            _state.value = NativeSessionState(
                loading = false,
                authenticated = store.hasSession(),
                userId = store.userId,
            )
        }
    }

    fun setAuthenticated(userId: String) {
        _state.value = NativeSessionState(
            loading = false,
            authenticated = true,
            userId = userId,
        )
    }

    fun clearSession() {
        _state.value = NativeSessionState(loading = false)
    }

    fun reportError(message: String) {
        _state.value = _state.value.copy(error = message)
    }
}
