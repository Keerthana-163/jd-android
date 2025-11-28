// static/app.js (final)
const els = {
  step1: document.getElementById("step1"),
  step2: document.getElementById("step2"),
  step3: document.getElementById("step3"),
  //step4: document.getElementById("step4"),
  topic: document.getElementById("topic"),
  step1NextBtn: document.getElementById("step1NextBtn"),
  introVideo: document.getElementById("introVideo"),
  introSrc: document.getElementById("introSrc"),
  step2BackBtn: document.getElementById("step2BackBtn"),
  startBtn: document.getElementById("startBtn"),
  step3BackBtn: document.getElementById("step3BackBtn"),
  endBtn: document.getElementById("endBtn"),
  goToAnalysisBtn: document.getElementById("goToAnalysisBtn"),
  aiStream: document.getElementById("aiStream"),
  aiAudio: document.getElementById("aiAudio"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  analyzeStatus: document.getElementById("analyzeStatus"),
  analysisBox: document.getElementById("analysisBox"), // top big box
  questionNav: document.getElementById("questionNav"), // numbers
  overallScoreEl: document.getElementById("overallScore"),
  strengthsEl: document.getElementById("strengths"),
  improvementsEl: document.getElementById("improvements"),
  nextStepsEl: document.getElementById("nextSteps"),
  videoPlayer: document.getElementById("studentPlayback"),
  suggestedCourse: document.getElementById("suggestedCourse"),
  summaryBox: document.getElementById("analysisSummary"),
};

let pc, dc, micStream, camStream, mixedStream;
let audioContext = null;         // Web Audio for mixing
let mixedAudioDestination = null;
let interviewerTurns = [];
let candidateTurns = [];
let pendingAIText = "";
let lastAssistantText = "";
let started = false;
let mediaRecorder = null;
let recordedBlobs = [];
let recordingUrl = "";
let analysisItems = [];
let currentIndex = 0;
let currentQuestionText = "";
let awaitingAnswer = false;
let interviewRunning = false;
let devicePreviewStream = null;
let micAnalyser = null;
let micDataArray = null;
let micLevelAnimId = null;

function showStep(s) {
  els.step1.style.display = "none";
  els.step2.style.display = "none";
  els.step3.style.display = "none";
  document.getElementById("finalReport").style.display = "none";
  s.style.display = "block";
}
document.addEventListener("visibilitychange", () => {
    if (document.hidden && interviewRunning) {
        alert("⚠️ Interview paused because you switched the tab. Please stay on this tab during the interview.");
        
    }
});
function showFinalReport() {
    document.getElementById("step3").style.display = "none";
    document.getElementById("finalReport").style.display = "block";
}

function ensureRecordingUI() {
  if (!document.getElementById("webcamPreview")) {
    const wrap = document.createElement("div");
    wrap.style.display = "flex"; wrap.style.justifyContent = "flex-end"; wrap.style.marginBottom = "8px";
    const v = document.createElement("video"); v.id = "webcamPreview"; v.autoplay = true; v.muted = true; v.width = 180; v.height = 135;
    v.style.borderRadius = "8px"; v.style.border = "1px solid #cfe3ff";
    wrap.appendChild(v);
    els.step3.insertBefore(wrap, els.aiStream);
  }
}


function stripHtml(s){ return (s||"").replace(/<\/?[^>]+(>|$)/g,""); }
function appendAI(text){ const d=document.createElement("div"); d.className="q"; d.textContent=text; els.aiStream.appendChild(d); els.aiStream.scrollTop = els.aiStream.scrollHeight; }
function appendYou(text) {
  const d = document.createElement("div");
  d.className = "you";
  d.textContent = text;
  els.aiStream.appendChild(d);
  els.aiStream.scrollTop = els.aiStream.scrollHeight;
}

function pushAssistantText(text) {
  const t = stripHtml(text || "").trim();
  if (!t) return;
  if (t === lastAssistantText) return;
  
  lastAssistantText = t;
  interviewerTurns.push(t);
  appendAI(t);

  // AI just asked a question → now expecting candidate answer
  awaitingAnswer = true;

  els.analyzeBtn.disabled = false;
}



function extractAssistantText(msg) {
  const chunks = [];
  if (Array.isArray(msg.output)) {
    msg.output.forEach(o => { if (Array.isArray(o.content)) o.content.forEach(c => { const t=c.text||c.value||""; if(t) chunks.push(t); }); });
  }
  if (msg.response && Array.isArray(msg.response.output)) {
    msg.response.output.forEach(o => { if (Array.isArray(o.content)) o.content.forEach(c => { const t=c.text||c.value||""; if(t) chunks.push(t); }); });
  }
  if (msg.item) {
    const it = msg.item;
    if (Array.isArray(it.content)) {
      it.content.forEach(c => {
        const t = (c.transcript && (c.transcript.text || c.transcript)) || c.text || c.value || "";
        if (t) chunks.push(t);
      });
    }
    if (typeof it.text === "string") chunks.push(it.text);
    if (typeof it.transcript === "string") chunks.push(it.transcript);
    if (it.transcript && typeof it.transcript.text === "string") chunks.push(it.transcript.text);
  }
  if (!chunks.length && typeof msg.text === "string") chunks.push(msg.text);
  return stripHtml(chunks.join(" ").trim());
}

function handleEvent(ev) {
  if (typeof ev.data !== "string") return;

  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  // --- (A) Streaming assistant text (new + legacy) ---
  if (msg.type === "response.delta" && msg.delta?.type === "output_text") {
    pendingAIText += msg.delta.text || "";
    return;
  }

  if (msg.type === "response.completed" || msg.type === "response.output_text.completed") {
    const text = (pendingAIText || "").trim();
    pendingAIText = "";
    if (text) pushAssistantText(text);
    return;
  }

  if (msg.type === "response.output" && Array.isArray(msg.output)) {
    const txt = extractAssistantText(msg);
    if (txt) pushAssistantText(txt);
    return;
  }

  if (msg.type === "response.created" && msg.response && Array.isArray(msg.response.output)) {
    const txt = extractAssistantText(msg.response);
    if (txt) pushAssistantText(txt);
    return;
  }

  // --- (B) Student transcription (completed events) ---
  if (
    msg.type === "conversation.item.input_audio_transcription.completed" ||
    msg.type === "input_audio_transcription.completed" ||
    msg.type === "response.input_audio_transcription.completed"
  ) {
    const t = (msg.transcript || msg.text || "").trim();
    if (!t) return;

    //appendYou(t);

    if (interviewerTurns.length > candidateTurns.length) {
      candidateTurns.push(t);
    } else {
      candidateTurns.push(t);
    }

    els.analyzeBtn.disabled = false;
    return;
  }

  // --- (C) conversation.item.created (assistant + user) ---
  if (msg.type === "conversation.item.created" && msg.item) {
    if (msg.item.role === "assistant") {
      const txt = extractAssistantText(msg);
      if (txt) pushAssistantText(txt);
    } else if (msg.item.role === "user") {
      const t = extractAssistantText(msg);
      if (t) {
        appendYou(t);
        if (interviewerTurns.length > candidateTurns.length) candidateTurns.push(t);
        else candidateTurns.push(t);
        els.analyzeBtn.disabled = false;
      }
    }
    return;
  }

  // --- (D) Last-resort: anything that looks like assistant text ---
  if ((msg.type && String(msg.type).startsWith("response")) || msg.role === "assistant") {
    const txt = extractAssistantText(msg);
    if (txt) {
      pushAssistantText(txt);
      return;
    }
  }
}
async function initDeviceCheck() {
  const deviceCheckEl = document.getElementById("deviceCheck");
  const previewVideo = document.getElementById("devicePreviewVideo");
  const micInner = document.getElementById("micLevelBarInner");
  const statusEl = document.getElementById("deviceCheckStatus");

  if (!deviceCheckEl) return;
  deviceCheckEl.style.display = "block";

  // Clean up old preview stream if any
  if (devicePreviewStream) {
    devicePreviewStream.getTracks().forEach(t => t.stop());
    devicePreviewStream = null;
  }
  if (micLevelAnimId) {
    cancelAnimationFrame(micLevelAnimId);
    micLevelAnimId = null;
  }

  try {
    devicePreviewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: { echoCancellation: true }
    });

    if (previewVideo) {
      previewVideo.srcObject = devicePreviewStream;
    }

    // Simple mic level meter using Web Audio
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const source = ac.createMediaStreamSource(devicePreviewStream);
    micAnalyser = ac.createAnalyser();
    micAnalyser.fftSize = 256;
    micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
    source.connect(micAnalyser);

    const updateLevel = () => {
      if (!micAnalyser || !micDataArray) return;
      micAnalyser.getByteFrequencyData(micDataArray);
      let sum = 0;
      for (let i = 0; i < micDataArray.length; i++) sum += micDataArray[i];
      const avg = sum / micDataArray.length; // 0–255
      const pct = Math.min(100, Math.max(4, (avg / 255) * 100));
      if (micInner) micInner.style.width = pct + "%";
      micLevelAnimId = requestAnimationFrame(updateLevel);
    };
    updateLevel();

    if (statusEl) {
      statusEl.textContent = "Camera and microphone look good. You can now start the interview.";
    }
    els.startBtn.disabled = false;
  } catch (err) {
    console.error("Device preview failed:", err);
    if (statusEl) {
      statusEl.textContent =
        "Unable to access camera/mic. Please allow permissions in the browser and refresh the page.";
    }
  }
}

async function startInterview() {
  if (started) return;
  started = true;
  ensureRecordingUI();
  els.aiStream.innerHTML = ""; els.analysisBox.innerHTML = ""; els.questionNav.innerHTML = ""; els.overallScoreEl.textContent = ""; els.strengthsEl.innerHTML = ""; els.improvementsEl.innerHTML = ""; els.nextStepsEl.innerHTML = ""; els.suggestedCourse.innerHTML = ""; els.videoPlayer.src = "";

  interviewerTurns = []; candidateTurns = []; pendingAIText = ""; lastAssistantText = ""; recordedBlobs = []; recordingUrl = ""; analysisItems = []; currentIndex = 0;
  interviewRunning = true;
  if (devicePreviewStream) {
    devicePreviewStream.getTracks().forEach(t => t.stop());
    devicePreviewStream = null;
  }
  if (micLevelAnimId) {
    cancelAnimationFrame(micLevelAnimId);
    micLevelAnimId = null;
  }

  const topic = els.topic.value;
  const tokResp = await fetch("/session", {
    method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({topic})
  });
  if (!tokResp.ok) { appendAI("Failed to create session. Check server logs."); started=false; return; }
  const { token } = await tokResp.json();

  pc = new RTCPeerConnection();
  dc = pc.createDataChannel("oai-events");

  const sessionUpdate = {
    type: "session.update",
    session: {
      modalities: ["audio","text"],
      "turn_detection": {"type": "server_vad","threshold": 0.75,"min_speech_ms": 650,"silence_duration_ms": 1600,"prefix_padding_ms": 200},
      input_audio_transcription: { model: "whisper-1", language: "en" }
    }
  };

  dc.onopen = () => {
    dc.send(JSON.stringify(sessionUpdate));
    const opening = `Hello. Let's start the interview on ${topic}. Tell me about yourself and how it relates to ${topic}.`;
    const instr = [
      "You are an interviewer. RULES:",
      "- ONLY ask questions. NEVER provide answers, explanations, hints, or suggestions.",
      `- FIRST utterance MUST be exactly: ${opening}`,
      "- Ask one concise question per turn (1-2 sentences). After candidate answer, ask ONE follow-up based ONLY on their last answer.",
      "- If candidate interrupts, stop speaking immediately and wait for candidate to finish.",
      "- If candidate asks you a question, reply exactly: \"I’m here to ask questions. Please answer the interview question.\"",
      "- No praise, no fillers, no repetition.",
      "- For every spoken question, also output the same text as textual output."
    ].join(" ");
    dc.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"], instructions: instr } }));
  };

  dc.onmessage = (ev) => handleEvent(ev);

  pc.ondatachannel = (e) => {
    const ch = e.channel;
    ch.onopen = () => { ch.send(JSON.stringify(sessionUpdate)); ch.send(JSON.stringify({ type:"response.create", response:{ modalities:["audio","text"], instructions:"Please follow instructions." } })); };
    ch.onmessage = (ev) => handleEvent(ev);
  };

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true },
      video: false
    });
  } catch (e) {
    appendAI("Mic access required.");
    started = false;
    interviewRunning = false;
    return;
  }

  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: 640, height: 480, frameRate: 15 }
    });
    document.getElementById("webcamPreview").srcObject = camStream;
  } catch (e) {
    console.warn("No webcam:", e);
  }

  // Send mic to OpenAI
  if (micStream) {
    micStream.getTracks().forEach(t => pc.addTrack(t, micStream));
  }
  if (camStream) {
    // Webcam video is only for local recording; not sent to OpenAI
  }

  // ===== Web Audio mixing: mic + AI voice into one track =====
  audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  await audioContext.resume();

  mixedAudioDestination = audioContext.createMediaStreamDestination();

  // Mic → destination
  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(mixedAudioDestination);
  }

  // Final recorded stream
  mixedStream = new MediaStream();

  // Add mixed audio track
  mixedAudioDestination.stream.getAudioTracks().forEach(t => mixedStream.addTrack(t));

  // Add webcam video track
  if (camStream) {
    camStream.getVideoTracks().forEach(t => mixedStream.addTrack(t));
  }

  // ===== AI audio: when it arrives, mix into the same destination =====
  pc.ontrack = (e) => {
    const aiAudio = els.aiAudio;
    const remoteStream = e.streams[0];

    // Play AI interviewer voice to the user
    aiAudio.srcObject = remoteStream;
    aiAudio.autoplay = true;
    aiAudio.muted = false;

    const remoteAudioTrack = remoteStream.getAudioTracks()[0];
    if (remoteAudioTrack && audioContext && mixedAudioDestination) {
      const aiStream = new MediaStream([remoteAudioTrack]);
      const aiSource = audioContext.createMediaStreamSource(aiStream);
      aiSource.connect(mixedAudioDestination);
      console.log("🎤 Connected AI audio into mixedAudioDestination");
    }

    // Try to ensure playback
    aiAudio.play().catch(() => {});
    setTimeout(() => aiAudio.play().catch(() => {}), 300);
  };

  // ===== Start MediaRecorder on mixedStream (already has mic + video; AI added via mixing) =====
  recordedBlobs = [];
  try {
    mediaRecorder = new MediaRecorder(mixedStream, { mimeType: "video/webm;codecs=vp8,opus" });
  } catch (e) {
    try {
      mediaRecorder = new MediaRecorder(mixedStream);
    } catch (err) {
      console.error("MediaRecorder not supported:", err);
      mediaRecorder = null;
    }
  }

  if (mediaRecorder) {
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordedBlobs.push(ev.data);
    };
    mediaRecorder.start(1000);
    console.log("📹 MediaRecorder started on mixedStream (mic + AI + webcam)");
  }


  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);

  const sdpResp = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp", "OpenAI-Beta":"realtime=v1" }, body: offer.sdp
  });

  if (!sdpResp.ok) { appendAI("⚠️ OpenAI Realtime failed."); started=false; return; }

  const answer = { type: "answer", sdp: await sdpResp.text() };
  await pc.setRemoteDescription(answer);

  appendAI("Connected. Interviewer will speak first…");
  els.endBtn.disabled = false; // enable end button as soon as connected
}

async function endInterview() {
  if (!started) return;
  started = false;
  interviewRunning = false;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch(e){}
  }
  try { if (dc) dc.close(); } catch(e){}
  try { if (pc) pc.close(); } catch(e){}
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (camStream) camStream.getTracks().forEach(t => t.stop());

  appendAI("Session ended.");

  if (recordedBlobs.length) {
    const blob = new Blob(recordedBlobs, { type: "video/webm" });
    const fd = new FormData(); fd.append("file", blob, "interview.webm"); fd.append("topic", els.topic.value);
    els.analyzeStatus.textContent = "Uploading recording...";
    try {
      const r = await fetch("/upload_recording", { method: "POST", body: fd });
      const j = await r.json(); recordingUrl = j.url; els.analyzeStatus.textContent = "Upload complete."; 
    } catch (e) { console.error(e); els.analyzeStatus.textContent = "Upload failed (you can still analyze).";  }
  } else {
    
    els.analyzeStatus.textContent = "No recording captured.";

  }
}

function renderMainAnalysisFor(index) {
  const it = analysisItems[index];
  if (!it) {
    els.analysisBox.innerHTML = `<div style="padding:12px;color:#d6eaff">No analysis available for this question.</div>`;
    return;
  }
  els.analysisBox.innerHTML = `
    <div style="border:1px solid #cfe3ff;border-radius:10px;padding:16px;background:#fff;color:#071028">
      <div style="font-weight:700;margin-bottom:8px">Q${index+1}: ${it.question || "—"}</div>
      <div style="margin-bottom:8px"><strong>Your Answer:</strong> ${it.answer || "—"}</div>
      <div style="margin-bottom:8px"><strong>Expected:</strong> ${it.expected_answer || it.expected || "—"}</div>
      <div style="margin-bottom:8px"><strong>Score:</strong> ${(it.score!==undefined)?it.score:(it.item_score||"—")}</div>
      <div style="background:#eef7ff;padding:10px;border-radius:8px;margin-top:8px">
        <div style="font-weight:600;margin-bottom:6px">What you did well</div>
        <ul style="margin-left:18px;">${(it.what_you_did_well||[]).map(x=>`<li>${x}</li>`).join("")||"<li>—</li>"}</ul>
        <div style="font-weight:600;margin-top:8px;margin-bottom:6px">What could be better</div>
        <ul style="margin-left:18px;">${(it.what_could_be_better||[]).map(x=>`<li>${x}</li>`).join("")||"<li>—</li>"}</ul>
        <div style="font-weight:600;margin-top:8px;margin-bottom:6px">Missing Terminologies</div>
        <ul style="margin-left:18px;">${(it.missing_terminologies||[]).map(x=>`<li>${x}</li>`).join("")||"<li>—</li>"}</ul>
      </div>
    </div>
  `;
}

function renderQuestionNav() {
  els.questionNav.innerHTML = "";
  const count = analysisItems.length || interviewerTurns.length || 0;
  for (let i=0;i<count;i++){
    const btn = document.createElement("button");
    btn.textContent = `${i+1}`;
    btn.style.marginRight = "6px";
    btn.style.padding = "8px 10px";
    btn.style.borderRadius = "6px";
    btn.style.border = "1px solid #cfe3ff";
    btn.style.background = (i===currentIndex) ? "#d6ecff" : "#fff";
    btn.onclick = () => { currentIndex = i; renderMainAnalysisFor(i); renderQuestionNav(); };
    els.questionNav.appendChild(btn);
  }
}

function renderSummaryAndMedia(data) {
  els.overallScoreEl.textContent =
    `Overall Score: ${data.overall_score || 0}/10`;

  els.strengthsEl.innerHTML =
    `<strong>Strengths:</strong> ${(data.strengths || []).join(", ") || "—"}`;

  els.improvementsEl.innerHTML =
    `<strong>Improvements:</strong> ${(data.improvements || []).join(", ") || "—"}`;

  els.nextStepsEl.innerHTML =
    `<strong>Next steps:</strong> ${(data.next_steps || []).join(", ") || "—"}`;
    const nonTechBox = document.getElementById("nonTechSummary");
  if (nonTechBox) {
    const nt = data.non_technical || {};
    const efScore = (nt.english_fluency_score !== undefined && nt.english_fluency_score !== null)
      ? nt.english_fluency_score
      : "—";
    const confScore = (nt.confidence_score !== undefined && nt.confidence_score !== null)
      ? nt.confidence_score
      : "—";
    const attScore = (nt.attentiveness_score !== undefined && nt.attentiveness_score !== null)
      ? nt.attentiveness_score
      : "—";

    const efComment = nt.english_fluency_comment || "—";
    const confComment = nt.confidence_comment || "—";
    const attComment = nt.attentiveness_comment || "—";
    const others = (nt.other_observations || []).join(" • ");

    nonTechBox.innerHTML = `
      <strong>Communication & Behaviour</strong><br/>
      <strong>English fluency:</strong> ${efScore}/10 — ${efComment}<br/>
      <strong>Confidence:</strong> ${confScore}/10 — ${confComment}<br/>
      <strong>Attentiveness:</strong> ${attScore}/10 — ${attComment}
      ${others ? `<br/><strong>Other observations:</strong> ${others}` : ""}
    `;
  }


  if (els.summaryBox) {
    const summary =
      data.analysis ||
      data.analysis_summary ||
      data.summary ||
      data.final_summary ||
      "";
    els.summaryBox.textContent = summary || "—";
  }

  if (data.recording_url) {
    els.videoPlayer.src = data.recording_url;
  }

  if (data.suggested_course) {
    els.suggestedCourse.innerHTML = `
      <div style="background:#fff;border:1px solid #cfe3ff;padding:12px;border-radius:8px;color:#071028">
        <div style="font-weight:700">${data.suggested_course.title}</div>
        <a href="${data.suggested_course.url}" target="_blank">${data.suggested_course.url}</a>
      </div>`;
  }
}


async function runAnalysis() {
  els.analyzeBtn.disabled = true; els.analyzeStatus.textContent = "Analyzing…";
  try {
    const topic = els.topic.value;
    const r = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, interviewerTurns: interviewerTurns, candidateTurns: candidateTurns, recording_url: recordingUrl })
    });
    const data = await r.json();
    analysisItems = data.items || [];
    currentIndex = 0;
    renderQuestionNav();
    renderMainAnalysisFor(0);
    renderSummaryAndMedia(data);
  } catch (e) {
    console.error(e); els.analysisBox.innerHTML = "<div style='color:#fdd'>Analysis failed</div>";
  } finally { els.analyzeBtn.disabled = false; els.analyzeStatus.textContent = ""; }
}

document.addEventListener("DOMContentLoaded", () => {
  function setVideoForTopic(topicKey) {
    const map = {
      "Product Designer": "product_designer_intro.mp4",
      "PCB Designer": "pcb_intro.mp4",
      "Firmware / Software Developer (Embedded)": "firmware_developer_intro.mp4",
      "Integration Engineer": "integration_engineer_intro.mp4",
      "Domain Expert & V&V Engineer": "domain_expert_vnv_intro.mp4",
      "Mechanical Designer": "mechanical_designer_intro.mp4",
      "Procurement Specialist": "procurement_specialist_intro.mp4"
    };
    const fname = map[topicKey] || "default_intro.mp4";
    document.getElementById("introSrc").src = `/static/videos/${fname}`; document.getElementById("introVideo").load();
    document.getElementById("startBtn").disabled = true;
  }

  setVideoForTopic(els.topic.value);
  els.topic.addEventListener("change", (e) => setVideoForTopic(e.target.value));

  els.step1NextBtn.addEventListener("click", () => showStep(els.step2));
  els.step2BackBtn.addEventListener("click", () => showStep(els.step1));
    els.introVideo.addEventListener("ended", () => {
    // After watching intro completely, show instructions + device check
    if (!started) {
      initDeviceCheck();
      els.startBtn.disabled = false;
    }
  });

  els.introVideo.addEventListener("seeking", () => { if (!els.introVideo.ended) els.introVideo.currentTime = 0; });

  els.startBtn.addEventListener("click", (e) => { e.preventDefault(); startInterview(); showStep(els.step3); });
  els.step3BackBtn.addEventListener("click", () => showStep(els.step2));
  els.endBtn.addEventListener("click", () => endInterview());
  //els.goToAnalysisBtn.addEventListener("click", () => { showStep(els.step4); });
  els.analyzeBtn.addEventListener("click", async () => {
    els.analyzeStatus.textContent = "Analyzing… please wait…";
    els.analyzeBtn.disabled = true;

    await runAnalysis();           // wait until server returns full analysis

    showStep(document.getElementById("finalReport"));  
});                    // After results arrive, switch to analysis UI
});