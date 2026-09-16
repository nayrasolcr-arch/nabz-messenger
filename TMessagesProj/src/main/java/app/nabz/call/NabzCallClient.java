package app.nabz.call;

import android.content.Context;
import android.media.AudioManager;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.SessionDescription;
import org.webrtc.SdpObserver;

import java.util.ArrayList;
import java.util.List;

import app.nabz.NabzConfig;
import app.nabz.net.CallRepository;
import app.nabz.net.NabzApiClient;
import app.nabz.net.RealtimeClient;

/**
 * Nabz voice-call engine (WebRTC, Opus).
 *
 * Flow:
 *   1. caller: CallRepository.startCall(conversationId)  -> backend creates call (ringing)
 *   2. callee receives {t:"call.ringing"} via RealtimeClient -> accept (REST) or reject
 *   3. both: fetch /calls/ice-servers, build PeerConnection (STUN/TURN)
 *   4. caller creates offer; SDP + ICE candidates are exchanged via
 *      RealtimeClient.sendSignal / {t:"signal"} events
 *   5. audio flows peer-to-peer (Opus); server only relays signaling
 *
 * The Telephony audio-routing (speaker/earpiece) uses AudioManager. Reconnect:
 * on ICE failure the peer restarts ICE; on WS drop RealtimeClient reconnects and
 * signaling resumes (call state survives server-side until ended/missed).
 */
public final class NabzCallClient implements RealtimeClient.Listener {

    private static volatile NabzCallClient sInstance;
    public static NabzCallClient get() {
        if (sInstance == null) {
            synchronized (NabzCallClient.class) {
                if (sInstance == null) sInstance = new NabzCallClient();
            }
        }
        return sInstance;
    }

    public enum CallState { IDLE, RINGING_OUT, RINGING_IN, ACTIVE, ENDED }

    public interface CallUiListener {
        void onStateChanged(CallState state, String callId, String peerUserId);
        void onSignal(JSONObject signal, String fromUserId, String callId);
    }

    private PeerConnectionFactory factory;
    private PeerConnection peerConnection;
    private AudioTrack localAudioTrack;
    private AudioManager audioManager;
    private CallUiListener uiListener;

    private String activeCallId;
    private String peerUserId;
    private CallState state = CallState.IDLE;

    private NabzCallClient() {}

    public void init(Context context, CallUiListener ui) {
        this.audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.uiListener = ui;
        if (factory == null) {
            PeerConnectionFactory.InitializationOptions opts =
                    PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions();
            PeerConnectionFactory.initialize(opts);
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory();
        }
        RealtimeClient.get().setListener(this);
    }

    // ---------------- outbound ----------------

    public void startOutgoingCall(String conversationId, String otherUserId) {
        state = CallState.RINGING_OUT;
        peerUserId = otherUserId;
        notifyUi();
        CallRepository.get().startCall(conversationId, new NabzApiClient.JsonCallback() {
            @Override public void onSuccess(JSONObject data) {
                JSONObject call = data.optJSONObject("call");
                activeCallId = call != null ? call.optString("id") : null;
            }
            @Override public void onError(NabzApiClient.ApiException error) {
                teardown();
            }
        });
    }

    /** Called by the call UI after the callee accepts (REST accept already done). */
    public void onAcceptedLocally() {
        CallRepository.get().iceServers(new NabzApiClient.JsonCallback() {
            @Override public void onSuccess(JSONObject data) {
                preparePeerConnection(data, false);
            }
            @Override public void onError(NabzApiClient.ApiException error) {
                teardown();
            }
        });
    }

    private void preparePeerConnection(JSONObject iceServersData, boolean isCaller) {
        List<PeerConnection.IceServer> servers = new ArrayList<>();
        try {
            JSONArray arr = iceServersData.optJSONArray("ice_servers");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject s = arr.optJSONObject(i);
                    if (s == null) continue;
                    JSONArray urls = s.optJSONArray("urls");
                    List<String> urlList = new ArrayList<>();
                    if (urls != null) {
                        for (int u = 0; u < urls.length(); u++) urlList.add(urls.optString(u));
                    } else {
                        urlList.add(s.optString("urls"));
                    }
                    PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urlList);
                    if (s.has("username")) b.setUsername(s.optString("username"));
                    if (s.has("credential")) b.setPassword(s.optString("credential"));
                    servers.add(b.createIceServer());
                }
            }
        } catch (Exception ignored) {}

        PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(servers);
        cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        peerConnection = factory.createPeerConnection(cfg, new PeerConnection.Observer() {
            @Override public void onIceCandidate(IceCandidate candidate) {
                if (activeCallId != null && peerUserId != null) {
                    try {
                        RealtimeClient.get().sendSignal(activeCallId, peerUserId,
                                new JSONObject()
                                        .put("type", "candidate")
                                        .put("candidate", new JSONObject()
                                                .put("candidate", candidate.sdp)
                                                .put("sdpMid", candidate.sdpMid)
                                                .put("sdpMLineIndex", candidate.sdpMLineIndex)));
                    } catch (Exception ignored) {}
                }
            }

            @Override public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
                if (newState == PeerConnection.PeerConnectionState.FAILED && peerConnection != null) {
                    peerConnection.restartIce();
                }
            }

            @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {}
            @Override public void onIceConnectionReceivingChange(boolean b) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
            @Override public void onIceCandidatesRemoved(org.webrtc.IceCandidate[] candidates) {}
            @Override public void onAddStream(org.webrtc.MediaStream mediaStream) {}
            @Override public void onRemoveStream(org.webrtc.MediaStream mediaStream) {}
            @Override public void onDataChannel(org.webrtc.DataChannel dataChannel) {}
            @Override public void onRenegotiationNeeded() {}
            @Override public void onAddTrack(org.webrtc.RtpReceiver rtpReceiver, org.webrtc.MediaStream[] mediaStreams) {}
        });

        AudioSource source = factory.createAudioSource(new MediaConstraints());
        localAudioTrack = factory.createAudioTrack("nabz_a0", source);
        if (peerConnection != null) {
            peerConnection.addTrack(localAudioTrack, java.util.Collections.singletonList("nabz"));
        }

        if (isCaller) createOffer();
    }

    private void createOffer() {
        if (peerConnection == null) return;
        peerConnection.createOffer(new SdpAdapter(desc -> {
            try {
                peerConnection.setLocalDescription(new SdpAdapter(null), desc);
                RealtimeClient.get().sendSignal(activeCallId, peerUserId,
                        new JSONObject().put("type", "offer").put("sdp", desc.description));
            } catch (Exception ignored) {}
        }), new MediaConstraints());
    }

    private void setRemoteAndAnswer(JSONObject sdp) {
        if (peerConnection == null) return;
        try {
            peerConnection.setRemoteDescription(new SdpAdapter(null),
                    new SessionDescription(SessionDescription.Type.OFFER, sdp.getString("sdp")));
            peerConnection.createAnswer(new SdpAdapter(desc -> {
                try {
                    peerConnection.setLocalDescription(new SdpAdapter(null), desc);
                    RealtimeClient.get().sendSignal(activeCallId, peerUserId,
                            new JSONObject().put("type", "answer").put("sdp", desc.description));
                } catch (Exception ignored) {}
            }), new MediaConstraints());
        } catch (Exception ignored) {}
    }

    public void endCall(String reason) {
        if (activeCallId != null) {
            CallRepository.get().end(activeCallId, reason, null);
        }
        teardown();
    }

    public void setSpeaker(boolean on) {
        if (audioManager != null) audioManager.setSpeakerphoneOn(on);
    }

    public void setMuted(boolean muted) {
        if (localAudioTrack != null) localAudioTrack.setEnabled(!muted);
    }

    private void teardown() {
        if (peerConnection != null) {
            peerConnection.close();
            peerConnection = null;
        }
        setSpeaker(false);
        state = CallState.ENDED;
        activeCallId = null;
        peerUserId = null;
    }

    // ---------------- realtime events ----------------

    @Override public void onReady(String userId, JSONArray onlineUserIds) {}

    @Override public void onEvent(String type, JSONObject event) {
        switch (type) {
            case "call.ringing": {
                state = CallState.RINGING_IN;
                activeCallId = event.optString("call_id");
                JSONObject initiator = event.optJSONObject("initiator");
                peerUserId = initiator != null ? initiator.optString("id") : null;
                notifyUi();
                break;
            }
            case "call.accepted": {
                CallRepository.get().iceServers(new NabzApiClient.JsonCallback() {
                    @Override public void onSuccess(JSONObject data) {
                        preparePeerConnection(data, true);
                    }
                    @Override public void onError(NabzApiClient.ApiException error) {
                        teardown();
                    }
                });
                break;
            }
            case "call.rejected": {
                teardown();
                break;
            }
            case "call.ended": {
                teardown();
                break;
            }
            case "signal": {
                String from = event.optString("from");
                JSONObject data = event.optJSONObject("data");
                if (data == null) return;
                String kind = data.optString("type");
                if ("offer".equals(kind)) {
                    CallRepository.get().iceServers(new NabzApiClient.JsonCallback() {
                        @Override public void onSuccess(JSONObject ice) {
                            preparePeerConnection(ice, false);
                            if (data.has("sdp")) {
                                try {
                                    setRemoteAndAnswer(new JSONObject().put("sdp", data.getString("sdp")));
                                } catch (Exception ignored) {}
                            }
                        }
                        @Override public void onError(NabzApiClient.ApiException error) {
                            // cannot build a connection without ICE config
                        }
                    });
                } else if ("answer".equals(kind) && peerConnection != null) {
                    try {
                        peerConnection.setRemoteDescription(new SdpAdapter(null),
                                new SessionDescription(SessionDescription.Type.ANSWER, data.getString("sdp")));
                    } catch (Exception ignored) {}
                } else if ("candidate".equals(kind) && peerConnection != null) {
                    JSONObject c = data.optJSONObject("candidate");
                    if (c != null) {
                        peerConnection.addIceCandidate(new IceCandidate(
                                c.optString("sdpMid", "audio"),
                                c.optInt("sdpMLineIndex", 0),
                                c.optString("candidate")));
                    }
                }
                if (uiListener != null) uiListener.onSignal(data, from, event.optString("call_id"));
                break;
            }
            default: break;
        }
    }

    @Override public void onConnectionStateChange(boolean connected) {}

    private void notifyUi() {
        if (uiListener != null) uiListener.onStateChanged(state, activeCallId, peerUserId);
    }

    /** Minimal SDP observer that forwards created descriptions to a callback. */
    private static class SdpAdapter implements SdpObserver {
        private final java.util.function.Consumer<SessionDescription> onCreated;
        SdpAdapter(java.util.function.Consumer<SessionDescription> onCreated) { this.onCreated = onCreated; }

        @Override public void onCreateSuccess(SessionDescription description) {
            if (onCreated != null) onCreated.accept(description);
        }
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String error) {}
        @Override public void onSetFailure(String error) {}
    }
}
