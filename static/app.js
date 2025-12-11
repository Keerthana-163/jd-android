// static/app.js – 3-step UI, no fullscreen, no analysis on client

// ------- DOM elements -------
const notice          = document.getElementById("notice");
const step1           = document.getElementById("step1");
const step2           = document.getElementById("step2");
const step3           = document.getElementById("step3");

const introVideo      = document.getElementById("introVideo");
const step1NextBtn    = document.getElementById("step1NextBtn");

const deviceStatusEl  = document.getElementById("deviceCheckStatus");
const preview         = document.getElementById("preview");
const phonePreview    = document.getElementById("phonePreview");
const micLevelBarInner= document.getElementById("micLevelBarInner");
const startBtn        = document.getElementById("startBtn");

const aiStream        = document.getElementById("aiStream");
const aiAudio         = document.getElementById("aiAudio");
const webcamPreview   = document.getElementById("webcamPreview");
const phonePreviewLive= document.getElementById("phonePreviewLive");
const endBtn          = document.getElementById("endBtn");
const timerEl         = document.getElementById("timer");
     // NEW
const SEG_POLL_INTERVAL_MS = 3000;   // how often to check for new segments
const SEG_START_DELAY_SEGMENTS = 3; // wait for at least N segments before starting
const SAFE_LAG_SEGMENTS = 2; 

// make it visible in console

// ------- State -------
let candidateId = null;
let token       = null;
let pc          = null;
let dc          = null;
let micStream   = null;
let camStream   = null;

let recordedBlobs = [];
let mediaRecorder = null;

let interviewerTurns = [];
let candidateTurns   = [];
let pendingText      = "";
let lastAssistantText= "";

let interviewSeconds = 3 * 60;
let timerInterval    = null;

let audioCtx         = null;
let mixDestination   = null;
let mixedStream      = null;

let devicePreviewStream = null;
let micAnalyser     = null;
let micDataArray    = null;
let micLevelAnimId  = null;

let started          = false;
   // NEW – holds the current live stream URL
   // 🔹 NEW – current streaming URL
// LiveKit state
let lkRoom        = null;   // LiveKit Room
let lkVideoTrack  = null;   // last subscribed video track

// candidate name + first-turn filter
let currentCandidateName = "";
let firstAssistantTurnAccepted = false;
// premises audio capture (from LiveKit)
let premisesAudioRecorder = null;
let premisesAudioChunks   = [];
// ------- Premises segments state (no HLS, plain mp4) -------
let premisesSegments = [];
let premisesIndex = 0;
let premisesPollTimer = null;
let premisesLiveMode = false;

  // start after at least N segments exist

// ------- Helpers -------
function setNotice(msg) {
  if (notice) notice.textContent = msg;
}
function attachHlsToVideo(videoEl, url) {
  if (!videoEl || !url) return;

  // Clear old state
  if (videoEl._hlsInstance) {
    try {
      videoEl._hlsInstance.destroy();
    } catch (e) {
      console.warn("Failed to destroy old HLS instance:", e);
    }
    videoEl._hlsInstance = null;
  }

  videoEl.pause();
  videoEl.removeAttribute("src");
  videoEl.srcObject = null;
  videoEl.load();

  const lower = url.toLowerCase();
  const isHls = lower.endsWith(".m3u8");

  // Debug hooks
  videoEl.onloadedmetadata = () => {
    console.log("HLS video loadedmetadata for", url);
  };
  videoEl.onplaying = () => {
    console.log("HLS video playing for", url, "currentTime=", videoEl.currentTime);
  };
  videoEl.onerror = (e) => {
    console.error("Video tag error", e, "for", url);
  };

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(videoEl);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log("HLS manifest parsed, starting playback");
      videoEl
        .play()
        .catch((err) => console.warn("HLS video play() failed:", err));
    });

    videoEl._hlsInstance = hls;
  } else if (isHls && videoEl.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari / iOS native HLS
    videoEl.src = url;
    videoEl.addEventListener(
      "loadedmetadata",
      () => {
        console.log("Native HLS loadedmetadata, starting playback");
        videoEl
          .play()
          .catch((err) => console.warn("Native HLS play() failed:", err));
      },
      { once: true }
    );
  } else {
    // Fallback: plain mp4/webm file
    videoEl.src = url;
    videoEl.addEventListener(
      "loadedmetadata",
      () => {
        console.log("File video loadedmetadata, starting playback");
        videoEl
          .play()
          .catch((err) => console.warn("File video play() failed:", err));
      },
      { once: true }
    );
  }
}





function setLiveStreamUrl(url) {
  if (!url) return;
  console.log("Using HLS premises URL:", url);
  hlsAttached = true; // mark as attached

  // 🔹 Show the mobile camera stream in the main "Premises Camera (Mobile)" box (Step 2)
  if (phonePreview) {
    phonePreview.muted = true;  // avoid echo
    attachHlsToVideo(phonePreview, url);
  }

  // 🔹 And also in Step 3 during the actual interview
  if (phonePreviewLive) {
    phonePreviewLive.muted = true; // interviewer does not need audio from here
    attachHlsToVideo(phonePreviewLive, url);
  }
}



function updateTimerText(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (timerEl) {
    timerEl.textContent = `Timer: ${String(m).padStart(2, "0")}:${String(
      sec
    ).padStart(2, "0")}`;
  }
}
// 🔹 NEW: Use a URL-based live stream for the premises camera
// 🔹 Live stream URL → both preview (Step 2) and interview (Step 3)



function stripHtml(s) {
  return (s || "").replace(/<\/?[^>]+(>|$)/g, "");
}
function setupPremisesAudioRecorder(track) {
  try {
    const ms = new MediaStream();
    // LiveKit RemoteTrack exposes mediaStreamTrack
    ms.addTrack(track.mediaStreamTrack);

    premisesAudioChunks = [];
    premisesAudioRecorder = new MediaRecorder(ms, { mimeType: "audio/webm" });

    premisesAudioRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        premisesAudioChunks.push(e.data);
      }
    };
  } catch (e) {
    console.error("Failed to setup premises audio recorder:", e);
  }
}
function startPremisesInstructionCapture() {
  if (!premisesAudioRecorder) {
    alert("Premises audio not ready yet. Wait for mobile to connect.");
    return;
  }
  premisesAudioChunks = [];
  try {
    premisesAudioRecorder.start(500);
    console.log("Premises instruction recording started");
  } catch (e) {
    console.error("Failed to start premises recorder:", e);
  }
}
let hlsPollCount = 0;
let hlsAttached   = false;
async function pollPremisesHls() {
  if (hlsAttached) {
    return; // already attached
  }

  const attached = await fetchAndAttachPremisesStream();
  if (attached) return;  // stop polling if we got it

  hlsPollCount += 1;
  if (hlsPollCount < 60) {      // ✅ e.g. ~5 minutes of retries
    setTimeout(pollPremisesHls, 5000);
  } else {
    console.warn("Stopped polling for premises HLS after 60 attempts.");
  }
}
// ---------- SEGMENT-BASED PREMISES LIVE VIEW (working logic) ----------

async function fetchPremisesSegments(id) {
  const res = await fetch(`/api/mobile/interviews/${encodeURIComponent(id)}/segments`);
  if (!res.ok) {
    throw new Error(`Segments not available (status ${res.status})`);
  }
  const data = await res.json();

  const segs = (data.segments || []).map((s) => ({
    url: s.url,
    uploadedAt: s.uploadedAt || 0,
  }));

  // Ensure chronological order
  segs.sort((a, b) => a.uploadedAt - b.uploadedAt);
  return segs;
}

async function ensurePremisesSegmentsReady() {
  // Wait until we have at least SEG_START_DELAY_SEGMENTS
  while (premisesLiveMode && candidateId) {
    try {
      premisesSegments = await fetchPremisesSegments(candidateId);
      if (premisesSegments.length >= SEG_START_DELAY_SEGMENTS) {
        console.log(
          "Premises: segments ready:",
          premisesSegments.length
        );
        return;
      }
    } catch (err) {
      console.warn("Premises: error fetching segments:", err);
    }

    console.log("Premises: waiting for first segments...");
    await new Promise((resolve) =>
      setTimeout(resolve, SEG_POLL_INTERVAL_MS)
    );
  }
}

/**
 * Background poller: keeps updating premisesSegments as new segments arrive.
 */
async function pollPremisesSegmentsLoop() {
  if (!premisesLiveMode || !candidateId) return;

  try {
    const latest = await fetchPremisesSegments(candidateId);
    if (latest.length > premisesSegments.length) {
      premisesSegments = latest;
      console.log("Premises: new segments total =", premisesSegments.length);
    }
  } catch (err) {
    console.warn("Premises: polling error:", err);
  } finally {
    if (premisesLiveMode) {
      premisesPollTimer = setTimeout(
        pollPremisesSegmentsLoop,
        SEG_POLL_INTERVAL_MS
      );
    }
  }
}

/**
 * Play the next segment into a video element.
 * Called initially and also on each 'ended' event.
 */
async function playNextPremisesSegment(videoEl) {
  if (!premisesLiveMode || !videoEl) return;

  // How many segments are still ahead of us?
  const remaining = premisesSegments.length - premisesIndex;

  // If we are too close to the "live edge", wait so that new segments can arrive.
  if (remaining <= SAFE_LAG_SEGMENTS) {
    // We are about to catch up → wait a bit, then try again.
    console.log(
      "Premises: near live edge (remaining=" + remaining +
      "), waiting to maintain lag of",
      SAFE_LAG_SEGMENTS, "segments"
    );
    setTimeout(() => playNextPremisesSegment(videoEl), 1000);
    return;
  }

  const seg = premisesSegments[premisesIndex];
  premisesIndex += 1;

  console.log(
    `Premises: playing segment #${premisesIndex}/${premisesSegments.length} ->`,
    seg.url
  );

  videoEl.src = seg.url;
  try {
    await videoEl.play();
  } catch (e) {
    console.warn("Premises: autoplay failed, user click needed:", e);
  }
}


/**
 * Wire a video element to the segment player.
 */
function attachPremisesToVideoEl(videoEl) {
  if (!videoEl) return;
  videoEl.muted = true;         // avoid echo
  videoEl.playsInline = true;
  videoEl.autoplay = true;

  videoEl.addEventListener("ended", () => {
    if (premisesLiveMode) {
      playNextPremisesSegment(videoEl);
    }
  });
}

/**
 * Entry point: start segment-based live view into phonePreview + phonePreviewLive
 */
async function startPremisesSegmentLiveView() {
  if (!candidateId) {
    console.warn("Premises: no candidateId yet.");
    return;
  }
  if (premisesLiveMode) return; // already running

  premisesLiveMode = true;
  premisesIndex = 0;
  premisesSegments = [];

  // Wire both Step2 & Step3 videos
  attachPremisesToVideoEl(phonePreview);
  attachPremisesToVideoEl(phonePreviewLive);

  // Start background polling for new segments
  pollPremisesSegmentsLoop();

  // Wait until we have a couple of segments, then play
  await ensurePremisesSegmentsReady();
  if (!premisesLiveMode) return;

  // Kick off playback for whichever video is present
  if (phonePreview) {
    playNextPremisesSegment(phonePreview);
  }
  if (phonePreviewLive) {
    // Step 3 will reuse the shared premisesIndex;
    // when user reaches Step 3, we’ll automatically
    // start playing from the current index.
    playNextPremisesSegment(phonePreviewLive);
  }
}

/**
 * Stop premises live view (if you ever need it on endInterview, etc).
 */
function stopPremisesSegmentLiveView() {
  premisesLiveMode = false;
  if (premisesPollTimer) {
    clearTimeout(premisesPollTimer);
    premisesPollTimer = null;
  }
}



// call this instead of single fetch:


async function fetchAndAttachPremisesStream() {
  try {
    if (!candidateId) {
      console.warn("No candidateId in URL for fetching premises stream");
      return false;
    }

    const resp = await fetch(`/api/mobile/interviews/${candidateId}`);

    if (!resp.ok) {
      console.warn("No mobile interview:", await resp.text());
      return false;
    }

    const data = await resp.json();
    const url = data.premisesVideoPath;

    if (!url) {
      console.warn("Mobile interview has no premisesVideoPath yet");
      return false;
    }

    setLiveStreamUrl(url);
    setNotice("Premises live stream attached from HLS / Spaces.");
    return true;   // ✅ attached now

  } catch (e) {
    console.error("Error fetching premises stream:", e);
    return false;
  }
}




async function stopPremisesInstructionCaptureAndUpload() {
  if (!premisesAudioRecorder) return;
  if (!candidateId) {
    alert("Missing candidate id in URL.");
    return;
  }

  // stop recording and wait for final chunk
  await new Promise((resolve) => {
    premisesAudioRecorder.addEventListener(
      "stop",
      () => resolve(),
      { once: true }
    );
    try {
      premisesAudioRecorder.stop();
    } catch (e) {
      console.warn("premises recorder stop error:", e);
      resolve();
    }
  });

  if (!premisesAudioChunks.length) {
    alert("No audio captured from premises.");
    return;
  }

  const blob = new Blob(premisesAudioChunks, { type: "audio/webm" });
  const fd = new FormData();
  fd.append("file", blob, `${candidateId}_premises.webm`);
  fd.append("candidate_id", candidateId);

  try {
    const resp = await fetch("/upload_spoken_audio", {
      method: "POST",
      body: fd,
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("upload_spoken_audio failed:", txt);
      alert("Failed to send instructions audio to server.");
      return;
    }

    const data = await resp.json();
    console.log("Spoken instructions transcript:", data.transcript);
    setNotice("Extra interview instructions captured from premises audio.");
  } catch (e) {
    console.error("Error uploading spoken audio:", e);
    alert("Error uploading spoken audio.");
  }
}

function appendAI(text) {
  const d = document.createElement("div");
  d.className = "q";
  d.textContent = text;
  aiStream.appendChild(d);
  aiStream.scrollTop = aiStream.scrollHeight;
}

// We’re not showing candidate text to the student, but still keep this for debugging.
function appendYou(text) {
  const d = document.createElement("div");
  d.style.color = "#111827";
  d.textContent = text;
  aiStream.appendChild(d);
  aiStream.scrollTop = aiStream.scrollHeight;
}
// 🔹 Connect to LiveKit and attach premises video to both Step2 & Step3


// ------- Device check -------
async function initDeviceCheck() {
  // stop old stream if any
  if (devicePreviewStream) {
    devicePreviewStream.getTracks().forEach((t) => t.stop());
    devicePreviewStream = null;
  }
  if (micLevelAnimId) {
    cancelAnimationFrame(micLevelAnimId);
    micLevelAnimId = null;
  }

  try {
    devicePreviewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: { echoCancellation: true },
    });

    if (preview) {
      preview.srcObject = devicePreviewStream;
      preview.play().catch(() => {});
    }
    
    // Placeholder for premises camera: you will set phonePreview.srcObject later
    if (phonePreview) {
      // leave blank; stream will come from your mobile / backend connection
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    const src = audioCtx.createMediaStreamSource(devicePreviewStream);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
    src.connect(micAnalyser);


    const updateLevel = () => {
      if (!micAnalyser || !micDataArray) return;
      micAnalyser.getByteFrequencyData(micDataArray);
      let sum = 0;
      for (let i = 0; i < micDataArray.length; i++) sum += micDataArray[i];
      const avg = sum / micDataArray.length;
      const pct = Math.min(100, Math.max(4, (avg / 255) * 100));
      if (micLevelBarInner) micLevelBarInner.style.width = pct + "%";
      micLevelAnimId = requestAnimationFrame(updateLevel);
    };
    updateLevel();

    if (deviceStatusEl) {
      deviceStatusEl.textContent =
        "Camera & microphone are active. Click “Start Interview” when you are ready.";
    }
    startBtn.disabled = false;
  } catch (err) {
    console.error("Device check failed:", err);
    if (deviceStatusEl) {
      deviceStatusEl.textContent =
        "Unable to access camera/mic. Allow permissions in the browser and refresh.";
    }
    startBtn.disabled = true;
  }
}

// ------- Realtime event handling -------
function extractAssistantText(msg) {
  const chunks = [];

  if (Array.isArray(msg.output)) {
    msg.output.forEach((o) => {
      if (Array.isArray(o.content)) {
        o.content.forEach((c) => {
          const t = c.text || c.value || "";
          if (t) chunks.push(t);
        });
      }
    });
  }

  if (msg.response && Array.isArray(msg.response.output)) {
    msg.response.output.forEach((o) => {
      if (Array.isArray(o.content)) {
        o.content.forEach((c) => {
          const t = c.text || c.value || "";
          if (t) chunks.push(t);
        });
      }
    });
  }

  if (msg.item) {
    const it = msg.item;
    if (Array.isArray(it.content)) {
      it.content.forEach((c) => {
        const t =
          (c.transcript && (c.transcript.text || c.transcript)) ||
          c.text ||
          c.value ||
          "";
        if (t) chunks.push(t);
      });
    }
    if (typeof it.text === "string") chunks.push(it.text);
    if (typeof it.transcript === "string") chunks.push(it.transcript);
    if (it.transcript && typeof it.transcript.text === "string")
      chunks.push(it.transcript.text);
  }

  if (!chunks.length && typeof msg.text === "string") {
    chunks.push(msg.text);
  }

  return stripHtml(chunks.join(" ").trim());
}

function pushAssistantText(text) {
  const t = stripHtml(text || "").trim();
  if (!t) return;
  if (t === lastAssistantText) return;

  // If we haven't accepted any assistant question yet,
  // ignore generic greetings that don't use the real candidate name
  if (!firstAssistantTurnAccepted) {
    const name = (currentCandidateName || "").toLowerCase();
    if (name && !t.toLowerCase().includes(name)) {
      console.log("Ignoring first assistant line without candidate name:", t);
      return; // do NOT show, do NOT store, keep audio muted
    }

    // This is the first valid assistant question → accept & unmute audio
    firstAssistantTurnAccepted = true;
    try {
      aiAudio.muted = false;
    } catch (e) {
      console.warn("Could not unmute aiAudio:", e);
    }
  }

  lastAssistantText = t;
  interviewerTurns.push(t);
  appendAI(t);
}

function handleDataChannelEvent(ev) {
  if (typeof ev.data !== "string") return;
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }

  // streaming assistant text
  if (msg.type === "response.delta" && msg.delta?.type === "output_text") {
    pendingText += msg.delta.text || "";
    return;
  }

  if (
    msg.type === "response.completed" ||
    msg.type === "response.output_text.completed"
  ) {
    const text = (pendingText || "").trim();
    pendingText = "";
    if (text) pushAssistantText(text);
    return;
  }

  if (msg.type === "response.output" && Array.isArray(msg.output)) {
    const txt = extractAssistantText(msg);
    if (txt) pushAssistantText(txt);
    return;
  }

  if (
    msg.type === "response.created" &&
    msg.response &&
    Array.isArray(msg.response.output)
  ) {
    const txt = extractAssistantText(msg.response);
    if (txt) pushAssistantText(txt);
    return;
  }

  // candidate transcription
  if (
    msg.type === "conversation.item.input_audio_transcription.completed" ||
    msg.type === "input_audio_transcription.completed" ||
    msg.type === "response.input_audio_transcription.completed"
  ) {
    const t = (msg.transcript || msg.text || "").trim();
    if (!t) return;
    candidateTurns.push(t);
    return;
  }

  if (msg.type === "conversation.item.created" && msg.item) {
    if (msg.item.role === "assistant") {
      const txt = extractAssistantText(msg);
      if (txt) pushAssistantText(txt);
    } else if (msg.item.role === "user") {
      const t = extractAssistantText(msg);
      if (t) candidateTurns.push(t);
    }
    return;
  }

  if (
    (msg.type && String(msg.type).startsWith("response")) ||
    msg.role === "assistant"
  ) {
    const txt = extractAssistantText(msg);
    if (txt) pushAssistantText(txt);
  }
}

// ------- Interview flow -------
async function startInterview() {
  if (!candidateId) {
    alert("Missing id in URL, e.g. ?id=CAND_001");
    return;
  }
  if (started) return;
  started = true;

  // reset per-interview state
  interviewerTurns = [];
  candidateTurns   = [];
  pendingText      = "";
  lastAssistantText= "";
  recordedBlobs    = [];
  firstAssistantTurnAccepted = false;
  currentCandidateName = "";

  // hide step2, show step3
  step2.style.display = "none";
  step3.style.display = "block";

  // stop device preview stream
  if (devicePreviewStream) {
    devicePreviewStream.getTracks().forEach((t) => t.stop());
    devicePreviewStream = null;
  }
  if (micLevelAnimId) {
    cancelAnimationFrame(micLevelAnimId);
    micLevelAnimId = null;
  }

  setNotice("Starting interview — creating session...");
  await stopPremisesInstructionCaptureAndUpload();

  const resp = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: candidateId }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    setNotice("Failed to create session: " + txt);
    started = false;
    return;
  }
  const data = await resp.json();
  token = data.token;
  setNotice("Session created. Connecting to AI interviewer.");

  // only use real name for filtering; if not provided, leave empty
  currentCandidateName = (data.candidate_name || "").trim().toLowerCase();
  const roleTitle = data.job_title || "this role"; // optional

  // Fresh mic + cam
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true },
      video: false,
    });
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });

    if (webcamPreview) {
      webcamPreview.srcObject = camStream;
      webcamPreview.play().catch(() => {});
    }
    // phonePreviewLive will be wired by you later
  } catch (e) {
    setNotice("Cannot access mic/webcam: " + e);
    started = false;
    return;
  }

  // PeerConnection + data channel
  pc = new RTCPeerConnection();
  dc = pc.createDataChannel("events");

  // session.update config for VAD + transcription
  const sessionUpdate = {
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      turn_detection: {
        type: "server_vad",
        threshold: 0.75,
        min_speech_ms: 650,
        silence_duration_ms: 1600,
        prefix_padding_ms: 200,
      },
      input_audio_transcription: { model: "whisper-1", language: "en" },
    },
  };

  // ✅ When the data channel opens, let the AI speak first
  dc.onopen = () => {
    try {
      dc.send(JSON.stringify(sessionUpdate));
      dc.send(
        JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio", "text"] }, // no extra instructions
        })
      );
    } catch (e) {
      console.error("Error sending initial response.create:", e);
    }
  };

  dc.onmessage = handleDataChannelEvent;

  if (micStream) {
    micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
  }

  // mixing mic + AI audio + webcam for recording
  audioCtx =
    audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  mixDestination = audioCtx.createMediaStreamDestination();
  mixedStream = new MediaStream();

  // mic → mix
  if (micStream) {
    const micSrc = audioCtx.createMediaStreamSource(micStream);
    micSrc.connect(mixDestination);
  }

  // AI audio from remote
  pc.ontrack = (e) => {
    const remoteStream = e.streams[0];
    aiAudio.srcObject = remoteStream;
    aiAudio.autoplay = true;
    aiAudio.muted = true; // unmuted only after firstAssistantTurnAccepted
    aiAudio.play().catch(() => {});

    const remoteAudioTrack = remoteStream.getAudioTracks()[0];
    if (remoteAudioTrack && audioCtx && mixDestination) {
      const aiStream = new MediaStream([remoteAudioTrack]);
      const aiSrc = audioCtx.createMediaStreamSource(aiStream);
      aiSrc.connect(mixDestination);
    }
  };

  // add mix audio + webcam video into mixedStream
  mixDestination.stream
    .getAudioTracks()
    .forEach((t) => mixedStream.addTrack(t));
  if (camStream) {
    camStream.getVideoTracks().forEach((t) => mixedStream.addTrack(t));
  }

  // media recorder
  recordedBlobs = [];
  try {
    mediaRecorder = new MediaRecorder(mixedStream, {
      mimeType: "video/webm;codecs=vp8,opus",
    });
  } catch (e) {
    mediaRecorder = new MediaRecorder(mixedStream);
  }
  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) recordedBlobs.push(ev.data);
  };
  mediaRecorder.start(1000);

  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);

  const sdpResp = await fetch(
    "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
        "OpenAI-Beta": "realtime=v1",
      },
      body: offer.sdp,
    }
  );

  if (!sdpResp.ok) {
    const txt = await sdpResp.text();
    setNotice("OpenAI realtime error: " + txt);
    started = false;
    return;
  }
  const answerSdp = await sdpResp.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  // timer
  interviewSeconds = 3 * 60;
  updateTimerText(interviewSeconds);
  timerInterval = setInterval(() => {
    interviewSeconds--;
    if (interviewSeconds < 0) interviewSeconds = 0;
    updateTimerText(interviewSeconds);
    if (interviewSeconds === 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      endInterview(true);
    }
  }, 1000);

  endBtn.disabled = false;
  setNotice(
    "Interview started — interviewer will speak. Timer running (3 minutes)."
  );
}


async function endInterview(autoEnded = false) {
  if (!started) return;
  started = false;
  endBtn.disabled = true;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  setNotice("Ending interview and finalizing recording...");

  // 1) Gracefully stop MediaRecorder and wait until all chunks are flushed
  async function stopRecorder() {
    if (!mediaRecorder) return;
    if (mediaRecorder.state === "inactive") return;

    await new Promise((resolve) => {
      const safeResolve = () => {
        mediaRecorder.removeEventListener("stop", safeResolve);
        resolve();
      };
      mediaRecorder.addEventListener("stop", safeResolve, { once: true });

      try {
        mediaRecorder.stop();
      } catch (e) {
        console.warn("mediaRecorder.stop error:", e);
        resolve();
      }
    });
  }

  await stopRecorder();

  // 2) Close WebRTC + local streams
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
    pc = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }

  // 3) Upload recording (if we have any blobs)
  if (recordedBlobs && recordedBlobs.length > 0) {
    const blob = new Blob(recordedBlobs, { type: "video/webm" });
    const fd = new FormData();
    fd.append("file", blob, `${candidateId}.webm`);
    fd.append("candidate_id", candidateId);

    try {
      const up = await fetch("/upload_recording", {
        method: "POST",
        body: fd,
      });

      if (!up.ok) {
        const txt = await up.text();
        console.error("upload_recording failed:", txt);
        setNotice("Upload failed: " + txt);
        return;
      }

      const upj = await up.json();
      const recording_url = upj.url;

      // 4) Store metadata (turns etc.) in JSONL via /store_interview
      const metaResp = await fetch("/store_interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate_id: candidateId,
          recording_url,
          interviewerTurns,
          candidateTurns,
        }),
      });

      if (!metaResp.ok) {
        const txt = await metaResp.text();
        console.error("store_interview failed:", txt);
        setNotice("Saving metadata failed: " + txt);
        return;
      }

      const metaJson = await metaResp.json();
      console.log("Interview stored with id:", metaJson.id);

      // 5) Switch UI to thank-you state
      setNotice(
        "Your interview has been saved. Thank you — we will get back to you soon."
      );
      if (step3) step3.style.display = "none";
      const thankYou = document.getElementById("thankYou");
      if (thankYou) thankYou.style.display = "block";
    } catch (e) {
      console.error("Error in endInterview:", e);
      setNotice("Upload failed: " + e);
    }
  } else {
    console.warn("No recorded blobs available at endInterview");
    setNotice(
      "No recording captured. Please contact support if this is unexpected."
    );
  }
}

// ------- Init -------
document.addEventListener("DOMContentLoaded", () => {
  // candidate id from URL
  const params = new URLSearchParams(window.location.search);
  candidateId = params.get("id");
  if (!candidateId) {
    setNotice("Missing ?id=UniqueID in URL. Example: ?id=CAND_004");
  } else {
    setNotice(`Loaded id=${candidateId}. Watch the intro to begin.`);
  }

  // Step1 -> Step2
  step1NextBtn.addEventListener("click", () => {
  step1.style.display = "none";
  step2.style.display = "block";

  initDeviceCheck();

  // reset polling & start once candidate is actually on device check page
  startPremisesSegmentLiveView();
});


  // optional: only enable Next after video ends
  if (introVideo) {
    introVideo.addEventListener("ended", () => {
      // you can disable/enable next button here if desired
    });
  }

  // 🔹 Connect SECOND live stream by URL (manual paste)
  

  // interview controls
  startBtn.addEventListener("click", startInterview);
  endBtn.addEventListener("click", () => endInterview(false));
});


