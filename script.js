const BASE_URL = "http://192.168.4.4:4000";

// Add browser support check
function checkRecordingSupport() {
  const mimeTypes = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];

  const supportedType = mimeTypes.find((type) =>
    MediaRecorder.isTypeSupported(type)
  );

  if (!supportedType) {
    console.error("No supported video recording format found");
    return false;
  }

  console.log("Supported recording format:", supportedType);
  return supportedType;
}

// Add debug logging
function logRecordingDebug(message, data = null) {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[Recording Debug ${timestamp}] ${message}:`, data);
  } else {
    console.log(`[Recording Debug ${timestamp}] ${message}`);
  }
}

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

// Recording variables
let mediaRecorder = null;
let recordingId = null;
let chunkSequence = 0;
let recordedChunks = [];
let isRecording = false;

// Add new variables for recording
let audioContext = null;
let canvas = null;
let canvasContext = null;
let recordingFPS = 30;

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

// Near the top of your file, after variable declarations
// Add this code to load saved data when the page loads
document.addEventListener("DOMContentLoaded", () => {
  // Try to load saved session data
  const savedToken = localStorage.getItem("token");
  const savedEmail = localStorage.getItem("userEmail");

  if (savedToken) {
    token = savedToken;
    isLoggedIn = true;
    btnLogin.innerText = "Logout";

    // Restore email field if available
    if (savedEmail) {
      document.getElementById("email").value = savedEmail;
    }

    // Restore session
    restoreSession();
  }

  // Add canvas element to HTML
  const canvas = document.createElement("canvas");
  canvas.id = "recordingCanvas";
  canvas.width = 1280;
  canvas.height = 720;
  canvas.style.display = "none";
  document.body.appendChild(canvas);
});

// Add this new function to restore a user session
async function restoreSession() {
  try {
    await showProfile();
    connectSocket();
    enableAll();
    log("Session restored. Welcome back!");
  } catch (err) {
    // If there's an error (like expired token), log out
    log("Session expired. Please login again.");
    logoutUser();
  }
}

// Modify your login function to save the token and email
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
    // Save token and email to localStorage
    localStorage.setItem("token", token);
    localStorage.setItem("userEmail", email);

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

// REMOVE the duplicate logoutUser function that appears around line 127
// Keep only this updated version
function logoutUser() {
  // Clear all localStorage items
  localStorage.removeItem("token");
  localStorage.removeItem("userEmail");

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
  showRecordingControls();
}

function showRecordingControls() {
  const recordBtn = document.getElementById("toggleRecording");
  if (userRole === "coach") {
    recordBtn.style.display = "block";
    recordBtn.disabled = !isLoggedIn;
  }
}

function connectSocket() {
  socket = io(BASE_URL, { auth: { token } });

  socket.on("recordingStarted", () => {
    log("Call recording has started");
  });

  socket.on("recordingStopped", () => {
    log("Call recording has stopped");
  });

  socket.on("recordingChunkReceived", (data) => {
    console.log("Received recording chunk:", data.sequence);
  });

  socket.on("recordingError", (error) => {
    log("Recording error: " + error.message);
    if (isRecording) {
      stopRecording();
    }
  });

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
    const message =
      data.message ||
      `You missed a call from your ${data.isDoctorCall ? "doctor" : "patient"}`;
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
  const callerType =
    data.isDoctorCall !== undefined
      ? data.isDoctorCall
        ? "doctor"
        : "patient"
      : "caller";

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
    const constraints = {
      audio: true,
      video: isVideoCall
        ? {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          }
        : false,
    };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    document.getElementById("localVideo").srcObject = localStream;

    audioTrack = localStream.getAudioTracks()[0] || null;
    videoTrack = localStream.getVideoTracks()[0] || null;

    if (videoTrack) {
      logRecordingDebug("Video track settings:", videoTrack.getSettings());
    }

    logRecordingDebug("Media setup complete", {
      hasAudio: !!audioTrack,
      hasVideo: !!videoTrack,
    });
  } catch (err) {
    log("Media error: " + err.message);
    console.error("Media setup error:", err);
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

document.getElementById("end").onclick = async () => {
  await endCall();
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

async function endCall() {
  try {
    // Store callId and other values before any async operations
    const currentCallId = callId;
    const currentReceiverId = currentReceiver;
    const currentAppointmentId = currentAppointment;

    // First stop recording if active
    if (isRecording) {
      log("Stopping recording before ending call...");
      cleanupRecording();
    }

    // Then emit end call event using stored values
    log("Sending end call event...");
    socket.emit("endCall", {
      callId: currentCallId,
      receiver: currentReceiverId,
      appointmentId: currentAppointmentId,
    });

    // Finally cleanup
    log("Cleaning up resources...");
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
    log("Call ended successfully");
  } catch (error) {
    console.error("Error ending call:", error);
    log("Error ending call: " + error.message);
    // Still try to cleanup even if there's an error
    cleanup();
  }
}

// Separate cleanup function
function cleanup() {
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
}

function flushCandidates() {
  candidateQueue.forEach(
    async (c) => await pc.addIceCandidate(new RTCIceCandidate(c))
  );
  candidateQueue = [];
}

// Update the enableAll function to exclude the End button
function enableAll() {
  // Enable all buttons except login and end
  document
    .querySelectorAll("button:not(#login):not(#end)")
    .forEach((btn) => (btn.disabled = false));

  // Ensure end button is disabled
  document.getElementById("end").disabled = true;
}

function disableAll() {
  document
    .querySelectorAll("button:not(#login)")
    .forEach((btn) => (btn.disabled = true));
}

// Add this near the top where other DOM elements are defined
const btnGoogleLogin = document.getElementById("googleLogin");

// Modify Google login handler
btnGoogleLogin.onclick = () => {
  // Get selected user type
  const userType = document.querySelector(
    'input[name="userType"]:checked'
  ).value;

  // Redirect to Google OAuth endpoint with user type
  window.location.href = `${BASE_URL}/api/auth/google?userType=${userType}`;
};

async function handleOAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");

  if (code) {
    try {
      // Get the user type from localStorage if it was saved during redirect
      const userType = urlParams.get("state") || "user";

      const response = await fetch(`${BASE_URL}/api/auth/google/callback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code,
          userType,
        }),
      });

      const data = await response.json();
      if (data.success) {
        // Store the token and user data
        token = data.data.token;
        localStorage.setItem("token", token);
        localStorage.setItem("userEmail", data.data.user.email);

        isLoggedIn = true;
        btnLogin.innerText = "Logout";

        // Update profile and connect socket
        await showProfile();
        connectSocket();
        enableAll();
        log("Logged in with Google successfully.");

        // Clean up the URL and redirect to the main page
        const baseUrl = window.location.origin + window.location.pathname;
        window.location.href = baseUrl;
      } else {
        log("Google login failed: " + (data.message || "Unknown error"));
        // Redirect to main page with error parameter
        window.location.href = "/?error=google_login_failed";
      }
    } catch (error) {
      log("Google login error: " + error.message);
      // Redirect to main page with error parameter
      window.location.href = "/?error=google_login_error";
    }
  }
}

// Call handleOAuthCallback immediately
handleOAuthCallback();

// Add recording status indicator
function updateRecordingStatus(isRecording) {
  const recordBtn = document.getElementById("toggleRecording");
  if (isRecording) {
    recordBtn.classList.add("recording-active");
    recordBtn.innerHTML = '<span class="recording-dot"></span> Stop Recording';
  } else {
    recordBtn.classList.remove("recording-active");
    recordBtn.innerHTML = "Start Recording";
  }
}

// Update startRecording function
async function startRecording() {
  try {
    if (!pc || !localStream) {
      log("No active call to record");
      return;
    }

    // Check browser support
    const supportedMimeType = checkRecordingSupport();
    if (!supportedMimeType) {
      log("Your browser doesn't support video recording");
      return;
    }

    // Initialize canvas if not already done
    if (!canvas) {
      canvas = document.getElementById("recordingCanvas");
      if (!canvas) {
        throw new Error("Canvas element not found");
      }
      canvasContext = canvas.getContext("2d");
      if (!canvasContext) {
        throw new Error("Could not get canvas context");
      }
    }

    // Generate unique recording ID
    recordingId = crypto.randomUUID();
    chunkSequence = 0;
    recordedChunks = [];

    // Get all streams
    const localVideo = document.getElementById("localVideo");
    const remoteVideo = document.getElementById("remoteVideo");

    if (!localVideo || !remoteVideo) {
      throw new Error("Video elements not found");
    }

    // Create audio context for mixing
    try {
      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();

      // Add local audio
      if (localStream) {
        const localAudioSource =
          audioContext.createMediaStreamSource(localStream);
        localAudioSource.connect(destination);
        logRecordingDebug("Local audio track added to mix");
      }

      // Add remote audio
      const remoteStream = remoteVideo.srcObject;
      if (remoteStream) {
        const remoteAudioSource =
          audioContext.createMediaStreamSource(remoteStream);
        remoteAudioSource.connect(destination);
        logRecordingDebug("Remote audio track added to mix");
      }

      // Setup canvas recording
      const canvasStream = canvas.captureStream(recordingFPS);

      let frameCount = 0;
      let lastFrameTime = performance.now();
      let frameDropCount = 0;

      function drawFrame() {
        try {
          const currentTime = performance.now();
          const elapsed = currentTime - lastFrameTime;

          canvasContext.clearRect(0, 0, canvas.width, canvas.height);
          const halfWidth = canvas.width / 2;
          const height = canvas.height;

          if (remoteVideo.readyState >= 2) {
            canvasContext.drawImage(remoteVideo, 0, 0, halfWidth, height);
          }

          if (localVideo.readyState >= 2) {
            canvasContext.drawImage(
              localVideo,
              halfWidth,
              0,
              halfWidth,
              height
            );
          }

          frameCount++;

          // Check for frame drops
          if (elapsed > (1000 / recordingFPS) * 1.5) {
            frameDropCount++;
            if (frameDropCount > 10) {
              log("Warning: High frame drop rate detected");
              frameDropCount = 0;
            }
          }

          lastFrameTime = currentTime;

          if (mediaRecorder && mediaRecorder.state === "recording") {
            requestAnimationFrame(drawFrame);
          }
        } catch (error) {
          console.error("Error in drawFrame:", error);
          log("Recording error: " + error.message);
          stopRecording();
        }
      }

      // Combine video (canvas) + audio into one stream
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);

      logRecordingDebug(
        "Combined stream created with tracks:",
        combinedStream
          .getTracks()
          .map((t) => ({ kind: t.kind, enabled: t.enabled }))
      );

      // Create MediaRecorder with appropriate mime type
      mediaRecorder = new MediaRecorder(combinedStream, {
        mimeType: supportedMimeType,
        audioBitsPerSecond: 128000,
        videoBitsPerSecond: isVideoCall ? 2500000 : undefined,
      });

      // Handle data available event
      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          logRecordingDebug("Chunk available", {
            size: event.data.size,
            type: event.data.type,
            sequence: chunkSequence,
          });

          recordedChunks.push(event.data);
          const arrayBuffer = await event.data.arrayBuffer();
          const chunkSize = 1024 * 1024; // 1MB chunks
          const chunks = splitArrayBuffer(arrayBuffer, chunkSize);

          for (const chunk of chunks) {
            socket.emit("recordingChunk", {
              recordingId,
              sequence: chunkSequence++,
              chunk: Array.from(new Uint8Array(chunk)),
              appointmentId: currentAppointment,
            });
          }
        }
      };

      // Handle recording stop
      mediaRecorder.onstop = () => {
        logRecordingDebug("Recording stopped");
        socket.emit("recordingEnded", {
          recordingId,
          appointmentId: currentAppointment,
        });

        // Create downloadable file
        const blob = new Blob(recordedChunks, { type: supportedMimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `recording_${new Date().toISOString()}.webm`;
        a.click();
        URL.revokeObjectURL(url);

        // Cleanup audio context
        if (audioContext) {
          audioContext.close();
          audioContext = null;
        }

        updateRecordingStatus(false);
      };

      // Add error handling
      mediaRecorder.onerror = (error) => {
        console.error("MediaRecorder error:", error);
        log("Recording error: " + error.message);
        stopRecording();
      };

      // Start recording with 1-second chunks
      mediaRecorder.start(1000);
      isRecording = true;
      updateRecordingStatus(true);
      log("Recording started");

      // Start drawing frames
      drawFrame();

      // Notify other participant
      socket.emit("recordingStarted", {
        appointmentId: currentAppointment,
        receiver: currentReceiver,
      });

      logRecordingDebug("Recording started with settings", {
        mimeType: mediaRecorder.mimeType,
        state: mediaRecorder.state,
        videoTrack: combinedStream.getVideoTracks()[0]?.getSettings(),
      });
    } catch (error) {
      console.error("Error setting up recording:", error);
      log("Recording setup failed: " + error.message);
      cleanupRecording();
      throw error;
    }
  } catch (error) {
    console.error("Failed to start recording:", error);
    log("Recording failed to start: " + error.message);
    updateRecordingStatus(false);
  }
}

// Add helper function for splitting array buffer
function splitArrayBuffer(arrayBuffer, chunkSize) {
  const chunks = [];
  for (let i = 0; i < arrayBuffer.byteLength; i += chunkSize) {
    chunks.push(arrayBuffer.slice(i, i + chunkSize));
  }
  return chunks;
}

// Add cleanup function for recording
function cleanupRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  isRecording = false;
  updateRecordingStatus(false);
}

// Update stopRecording function
function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    log("Recording stopped");

    // Notify other participant
    socket.emit("recordingStopped", {
      appointmentId: currentAppointment,
      receiver: currentReceiver,
    });
  }
}

// Add recording button event listener
document.getElementById("toggleRecording").addEventListener("click", () => {
  if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  // Try to load saved session data
  const savedToken = localStorage.getItem("token");
  const savedEmail = localStorage.getItem("userEmail");

  // Add recording button styles
  const recordingStyle = document.createElement("style");
  recordingStyle.textContent = `
    .recording-btn {
      background-color: #e74c3c;
    }
    .recording-btn:hover {
      background-color: #c0392b;
    }
    .recording-btn[disabled] {
      background-color: #bdc3c7;
    }
  `;
  document.head.appendChild(recordingStyle);

  if (savedToken) {
    token = savedToken;
    isLoggedIn = true;
    btnLogin.innerText = "Logout";

    // Restore email field if available
    if (savedEmail) {
      document.getElementById("email").value = savedEmail;
    }

    // Restore session
    restoreSession();
  }

  // Check for OAuth callback
  handleOAuthCallback();
});

// Add this after the showProfile function
function showRecordingControls() {
  const recordBtn = document.getElementById("toggleRecording");
  if (userRole === "coach") {
    recordBtn.style.display = "block";
  }
}
