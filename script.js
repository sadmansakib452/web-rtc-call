const BASE_URL = "http://192.168.4.4:5000";

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
let userRole = null;

// Change these lines (around line 13-15)
const ringtone = document.getElementById("ringtone");
const incomingModal = document.getElementById("callModal"); // Changed from "incomingCallModal"
const incomingText = document.getElementById("callerInfo"); // Changed from "incomingCallText"
const acceptBtn = document.getElementById("acceptCall");
const rejectBtn = document.getElementById("rejectCall");
const toastContainer = document.getElementById("toastContainer");

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
  userRole = user.type;
  document.getElementById(
    "profile"
  ).innerText = `👤 ${user.name} (${user.email})`;
}

function logoutUser() {
  token = null;
  isLoggedIn = false;
  userRole = null;
  btnLogin.innerText = "Login";
  document.getElementById("profile").innerText = "Not logged in";
  ["email", "password", "receiverId"].forEach(
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

  socket.on("callError", (data) => {
    log("Call error: " + data.message);
    hideIncomingModal();
    ringtone.pause();
  });

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

  // Update the missedCall event handler
  socket.on("missedCall", (data) => {
    // Log the entire data object for debugging
    console.log("Missed call data:", data);
    
    // Check if data has expected properties
    if (!data.caller || !data.appointmentId) {
      log("Invalid missed call data received");
      return;
    }
    
    // Log the message if it exists, otherwise create a default message
    const message = data.message || `You missed a call from your ${data.isDoctorCall ? 'doctor' : 'patient'}`;
    log("Missed call: " + message);
    
    // Pass the data to the notification function
    showMissedCallNotification(data);
  });

  // Add handler for callCancelled event
  socket.on("callCancelled", (data) => {
    console.log("Call cancelled:", data);
    log("Call cancelled: " + (data.reason || "No reason provided"));
    hideIncomingModal();
    ringtone.pause();
  });

  socket.on("incomingCall", async (data) => {
    if (data.caller === selfSocketId) return;
    ringtone.currentTime = 0;
    ringtone.play();
    callId = data.callId;
    currentReceiver = data.caller;
    currentAppointment = data.appointmentId;
    isVideoCall = data.offer?.sdp?.includes("m=video") || false;

    showIncomingModal(
      `Incoming call from ${data.isDoctorCall ? "Doctor" : "Patient"}`
    );

    // Add a safety timeout in case callCancelled event is missed
    const callTimeout = setTimeout(() => {
      hideIncomingModal();
      ringtone.pause();
      log("Call timed out");
    }, 35000); // 35 seconds (slightly longer than server timeout)

    acceptBtn.onclick = async () => {
      clearTimeout(callTimeout); // Clear the timeout when call is accepted
      hideIncomingModal();
      ringtone.pause();
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
    };

    rejectBtn.onclick = () => {
      hideIncomingModal();
      ringtone.pause();
      socket.emit("rejectCall", { callId: data.callId });
      log("Call rejected.");
    };
  });

  socket.on("iceCandidate", async (data) => {
    if (!remoteDescSet) candidateQueue.push(data.candidate);
    else await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  });
}

function showIncomingModal(text) {
  incomingText.innerText = text;
  incomingModal.style.display = "flex";
}

function hideIncomingModal() {
  incomingModal.style.display = "none";
}

// Update the showMissedCallNotification function (around line 178-196)
function showMissedCallNotification(data) {
  // Validate required data
  if (!data.caller || !data.appointmentId) {
    console.error("Missing required data for missed call notification:", data);
    return;
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  
  // Create message with fallback for isDoctorCall
  const callerType = data.isDoctorCall !== undefined ? 
    (data.isDoctorCall ? "doctor" : "patient") : "caller";
  
  toast.innerHTML = `
    <div><strong>Missed Call:</strong> You missed a call from your ${callerType}</div>
    <button>Call Back</button>
  `;
  
  toast.querySelector("button").onclick = () => {
    currentAppointment = data.appointmentId;
    currentReceiver = data.caller;
    isVideoCall = false;
    initiateCall();
    toast.remove();
  };
  
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 10000);
}

// Dropdown logic and partner mapping
receiverInput.addEventListener("focus", async () => {
  if (!token || !userRole) return;

  const usersRes = await fetch(`${BASE_URL}/api/chat/user`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const usersData = await usersRes.json();
  const allUsers = usersData.data;

  let mappedList = [];
  const endpoint =
    userRole === "user"
      ? "/api/user-dashboard/all-hired-coachs"
      : "/api/coach-dashboard/all-consumer-list";

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await res.json();
  const items = userRole === "user" ? result.coachesList : result.customerlist;

  for (const item of items) {
    const name = userRole === "user" ? item.name : item.customer_name;
    const email = userRole === "user" ? item.email : null;
    const match = allUsers.find((u) =>
      email ? u.email === email : u.name === name
    );
    if (!match) continue;
    mappedList.push({
      name,
      email: match.email,
      receiverId: match.id,
      appointmentId: item.orderId,
      type: match.type,
      avatar: match.avatar_url || "https://via.placeholder.com/30",
    });
  }

  dropdown.innerHTML = "";
  if (!mappedList.length) {
    dropdown.innerHTML =
      "<div class='dropdown-item'>No appointments found.</div>";
    dropdown.style.display = "block";
    return;
  }

  mappedList.forEach((user) => {
    const div = document.createElement("div");
    div.className = "dropdown-item";
    div.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <img src="${user.avatar}" width="30" height="30" style="border-radius: 50%;">
        <div><strong>${user.name}</strong> (${user.email})<br/><span>Type: ${user.type}</span></div>
      </div>
    `;
    div.onclick = () => {
      receiverInput.value = `${user.name} (${user.email})`;
      currentReceiver = user.receiverId;
      currentAppointment = user.appointmentId;
      dropdown.style.display = "none";
      log(`Selected ${user.name}. Ready to call.`);
    };
    dropdown.appendChild(div);
  });

  dropdown.style.display = "block";
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".receiver-container")) dropdown.style.display = "none";
});

document.getElementById("audioCall").onclick = () => {
  isVideoCall = false;
  initiateCall();
};

document.getElementById("videoCall").onclick = () => {
  isVideoCall = true;
  initiateCall();
};

async function initiateCall() {
  if (!currentReceiver || !currentAppointment)
    return log("Select a call partner.");
  await setupMedia();
  createPeer();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  callId = `${currentAppointment}-${Date.now()}`;
  socket.emit("call", {
    appointmentId: currentAppointment,
    receiver: currentReceiver,
    offer,
  });
  document.getElementById("end").disabled = false;
  log(`Calling ${currentReceiver} (${isVideoCall ? "video" : "audio"})...`);
}

async function setupMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia(
      isVideoCall ? { video: true, audio: true } : { audio: true }
    );
    document.getElementById("localVideo").srcObject = localStream;
    audioTrack = localStream.getAudioTracks()[0] || null;
    videoTrack = localStream.getVideoTracks()[0] || null;
  } catch (err) {
    log("Media error: " + err.message);
  }
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
  hideIncomingModal();
  ringtone.pause();
  log("Call ended.");
}

function flushCandidates() {
  candidateQueue.forEach(
    async (c) => await pc.addIceCandidate(new RTCIceCandidate(c))
  );
  candidateQueue = [];
}

function enableAll() {
  document
    .querySelectorAll("button:not(#login)")
    .forEach((btn) => (btn.disabled = false));
}

function disableAll() {
  document
    .querySelectorAll("button:not(#login)")
    .forEach((btn) => (btn.disabled = true));
}
