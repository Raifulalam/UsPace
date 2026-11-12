package com.couples.wallpaper

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

data class NativeInvitation(
    val id: String,
    val status: String,
    val expiresAt: String?,
    val inviteeName: String?,
    val inviteeUsername: String?,
)

data class NativeCoupleState(
    val loading: Boolean = true,
    val coupleId: String? = null,
    val coupleName: String = "Our Space",
    val coupleStatus: String? = null,
    val invitations: List<NativeInvitation> = emptyList(),
    val waitingForInvitation: Boolean = false,
    val issuedCode: String? = null,
    val error: String? = null,
)

class NativeCoupleViewModel : ViewModel() {
    private val _state = MutableStateFlow(NativeCoupleState())
    val state: StateFlow<NativeCoupleState> = _state.asStateFlow()

    fun load() {
        viewModelScope.launch {
            try {
                val couple = try {
                    SyncHub.api.get("/couples/me").getJSONObject("couple")
                } catch (e: ApiException) {
                    if (e.status == 404) null else throw e
                }
                if (couple == null) {
                    val incoming = SyncHub.api.get("/invitations/mine").getJSONArray("invitations")
                    _state.value = NativeCoupleState(
                        loading = false,
                        waitingForInvitation = incoming.length() > 0,
                    )
                } else {
                    _state.value = _state.value.copy(
                        loading = false,
                        coupleId = couple.getString("id"),
                        coupleName = couple.optString("name", "Our Space"),
                        coupleStatus = couple.optString("status"),
                        waitingForInvitation = false,
                        invitations = invitations(SyncHub.api.get("/couples/me/invitations").getJSONArray("invitations")),
                        error = null,
                    )
                }
            } catch (e: Exception) {
                _state.value = _state.value.copy(loading = false, error = e.message ?: "Could not load your space.")
            }
        }
    }

    fun create(name: String) = runAction {
        SyncHub.api.post("/couples", JSONObject().put("name", name.trim()))
    }

    fun accept(code: String) = runAction {
        SyncHub.api.post("/invitations/accept", JSONObject().put("code", code.trim()))
    }

    fun issueInvite() = viewModelScope.launch {
        runCatching {
            SyncHub.api.post("/couples/me/invitations")
                .getString("code")
        }.onSuccess { code ->
            _state.value = _state.value.copy(issuedCode = code, error = null)
            load()
        }.onFailure { error ->
            _state.value = _state.value.copy(error = error.message ?: "Could not create an invitation.")
        }
    }

    fun confirm(id: String) = runAction {
        SyncHub.api.post("/couples/me/invitations/$id/confirm")
    }

    fun reject(id: String) = runAction {
        SyncHub.api.post("/couples/me/invitations/$id/reject")
    }

    fun revoke(id: String) = runAction {
        SyncHub.api.delete("/couples/me/invitations/$id")
    }

    fun leave() = runAction {
        SyncHub.api.post("/couples/me/leave")
    }

    private fun runAction(action: suspend () -> JSONObject) = viewModelScope.launch {
        _state.value = _state.value.copy(error = null)
        runCatching { action() }
            .onSuccess { load() }
            .onFailure { error ->
                _state.value = _state.value.copy(error = error.message ?: "That action could not be completed.")
            }
    }

    private fun invitations(items: JSONArray): List<NativeInvitation> =
        (0 until items.length()).map { index ->
            val item = items.getJSONObject(index)
            val invitee = item.optJSONObject("invitee")
            NativeInvitation(
                id = item.getString("id"),
                status = item.optString("status"),
                expiresAt = item.optString("expiresAt").takeIf { it.isNotBlank() },
                inviteeName = invitee?.optString("displayName"),
                inviteeUsername = invitee?.optString("username"),
            )
        }
}
