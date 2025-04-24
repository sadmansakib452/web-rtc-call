const BASE_URL = "https://checks-cleaning-backup-selling.trycloudflare.com";

let socket, pc, localStream;
let callId, currentReceiver, currentAppointment;
let remoteDescSet = false;
let candidateQueue = [];
let selfSocketId = null;
let token = null;
let audioTrack, videoTrack;
let micMuted = false,
  camOff = false;
let isLoggedIn = false;
let isVideoCall = false;

const log = (msg) => {
  console.log("[LOG]", msg);
  document.getElementById("status").innerText = "Status: " + msg;
};

const btnLogin = document.getElementById("login");
const receiverInput = document.getElementById("receiverId");
const dropdown = document.getElementById("receiverDropdown");

btnLogin.onclick = async () => {
  if (isLoggedIn) return logoutUser();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value.trim();
  if (!email || !password) return log("Enter email and password.");

  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!data.success) return log("Login failed: " + data.message);

    token = data.authorization.token;
    await showProfile();
    connectSocket();
    enableAll();
    isLoggedIn = true;
    btnLogin.innerText = "Logout";
    log("Logged in and connected.");
  } catch (err) {
    log("Login error: " + err.message);
  }
};

async function showProfile() {
  const res = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await res.json();
  const user = result.data;
  document.getElementById(
    "profile"
  ).innerText = `👤 ${user.name} (${user.email})`;
}

function logoutUser() {
  token = null;
  isLoggedIn = false;
  btnLogin.innerText = "Login";
  document.getElementById("profile").innerText = "Not logged in";
  ["email", "password", "appointmentId", "receiverId"].forEach(
    (id) => (document.getElementById(id).value = "")
  );
  ["localVideo", "remoteVideo"].forEach(
    (id) => (document.getElementById(id).srcObject = null)
  );
  disableAll();
  if (socket) socket.disconnect();
  log("Logged out.");
}

function connectSocket() {
  socket = io(BASE_URL, { auth: { token } });

  socket.on("connect", () => {
    selfSocketId = socket.id;
    log("Socket connected: " + selfSocketId);
  });

  socket.on("callError", (data) => log("Call error: " + data.message));
  socket.on("callEnded", () => {
    log("Call ended by other party.");
    endCall();
  });

  socket.on("callAccepted", async (data) => {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    remoteDescSet = true;
    flushCandidates();
    document.getElementById("end").disabled = false;
    log("Call connected.");
  });

  socket.on("incomingCall", async (data) => {
    if (data.caller === selfSocketId) return;
    const accept = confirm("Incoming call from " + data.caller);
    if (!accept) return socket.emit("rejectCall", { callId: data.callId });

    callId = data.callId;
    currentReceiver = data.caller;
    currentAppointment = data.appointmentId;

    isVideoCall = data.offer?.sdp?.includes("m=video") || false;

    await setupMedia();
    createPeer();

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    remoteDescSet = true;

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", {
      callId,
      caller: data.caller,
      appointmentId: currentAppointment,
      answer,
    });
    flushCandidates();
    document.getElementById("end").disabled = false;
    log("Call accepted.");
  });

  socket.on("iceCandidate", async (data) => {
    if (!remoteDescSet) candidateQueue.push(data.candidate);
    else await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  });
}

// Receiver dropdown (partner list)
receiverInput.addEventListener("focus", async () => {
  if (!token) return;

  try {
    const res = await fetch(`${BASE_URL}/api/chat/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await res.json();
    const users = result.data;

    dropdown.innerHTML = "";
    users.forEach((user) => {
      const div = document.createElement("div");
      div.className = "dropdown-item";
      div.innerHTML = `<div class="user-detail"><span>${user.name}</span> (${user.email}) - ${user.type}</div>`;
      div.onclick = () => {
        receiverInput.value = user.id;
        dropdown.style.display = "none";
      };
      dropdown.appendChild(div);
    });

    dropdown.style.display = "block";
  } catch (err) {
    log("Failed to load partners");
    dropdown.style.display = "none";
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".receiver-container")) {
    dropdown.style.display = "none";
  }
});

document.getElementById("audioCall").onclick = async () => {
  isVideoCall = false;
  await initiateCall();
};

document.getElementById("videoCall").onclick = async () => {
  isVideoCall = true;
  await initiateCall();
};

async function initiateCall() {
  const receiver = document.getElementById("receiverId").value.trim();
  if (!receiver || !currentAppointment)
    return log("Please fill in all fields.");
  currentReceiver = receiver;

  await setupMedia();
  createPeer();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  callId = `${currentAppointment}-${Date.now()}`;

  socket.emit("call", {
    appointmentId: currentAppointment,
    receiver,
    offer,
  });

  log(`Calling with ${isVideoCall ? "video" : "audio"}...`);
}

async function setupMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia(
      isVideoCall ? { video: true, audio: true } : { audio: true }
    );
  } catch (error) {
    log("Media error: " + error.message);
    return;
  }

  document.getElementById("localVideo").srcObject = localStream;
  const audioTracks = localStream.getAudioTracks();
  const videoTracks = localStream.getVideoTracks();
  audioTrack = audioTracks[0] || null;
  videoTrack = videoTracks[0] || null;
}

function createPeer() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("iceCandidate", {
        callId,
        candidate: e.candidate,
        to: currentReceiver,
      });
    }
  };

  pc.ontrack = (e) => {
    document.getElementById("remoteVideo").srcObject = e.streams[0];
  };
}

document.getElementById("join").onclick = () => {
  const appointmentId = document.getElementById("appointmentId").value.trim();
  if (!socket || !appointmentId) return log("Enter appointment ID.");
  currentAppointment = appointmentId;
  socket.emit("join", { appointmentId });
  log("Joined appointment.");
};

document.getElementById("end").onclick = () => {
  socket.emit("endCall", {
    callId,
    receiver: currentReceiver,
    appointmentId: currentAppointment,
  });
  endCall();
};

document.getElementById("toggleMic").onclick = () => {
  if (!audioTrack) return;
  micMuted = !micMuted;
  audioTrack.enabled = !micMuted;
  document.getElementById("toggleMic").innerText = micMuted
    ? "Unmute Mic"
    : "Mute Mic";
};

document.getElementById("toggleCam").onclick = () => {
  if (!videoTrack) return;
  camOff = !camOff;
  videoTrack.enabled = !camOff;
  document.getElementById("toggleCam").innerText = camOff
    ? "Turn On Camera"
    : "Turn Off Camera";
};

function endCall() {
  if (pc) pc.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  pc = null;
  localStream = null;
  callId = null;
  remoteDescSet = false;
  candidateQueue = [];
  document.getElementById("localVideo").srcObject = null;
  document.getElementById("remoteVideo").srcObject = null;
  document.getElementById("end").disabled = true;
  log("Call ended.");
}

function flushCandidates() {
  candidateQueue.forEach(
    async (c) => await pc.addIceCandidate(new RTCIceCandidate(c))
  );
  candidateQueue = [];
}

function enableAll() {
  document.querySelectorAll("button:not(#login)").forEach((btn) => {
    btn.disabled = false;
  });
}

function disableAll() {
  document.querySelectorAll("button:not(#login)").forEach((btn) => {
    btn.disabled = true;
  });
}
