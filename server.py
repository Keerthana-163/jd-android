

import os
import json
import shutil
import random
from uuid import uuid4
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

from openai import OpenAI

# -----------------------------
# ENV + CLIENT
# -----------------------------
load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY missing")

client = OpenAI(api_key=OPENAI_API_KEY)

PORT = int(os.getenv("PORT", "8011"))
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "gpt-4o-realtime-preview")
ANALYSIS_MODEL = os.getenv("ANALYSIS_MODEL", "gpt-4o-mini")

# -----------------------------
# APP + STATIC SETUP
# -----------------------------
app = FastAPI()
Path("static").mkdir(exist_ok=True)
Path("static/recordings").mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# -----------------------------
# TOPIC MAPPING
# -----------------------------
TOPIC_MAP = {
    "Product Designer": "product_designer",
    "PCB Designer": "pcb",
    "Firmware / Software Developer (Embedded)": "firmware_developer",
    "Integration Engineer": "integration_engineer",
    "Domain Expert & V&V Engineer": "domain_expert_vnv",
    "Mechanical Designer": "mechanical_designer",
    "Procurement Specialist": "procurement_specialist",
}

# -----------------------------
# SUGGESTED COURSES
# -----------------------------
SUGGESTED_COURSES = {
    "Product Designer": {
        "title": "Gyannidhi — Product Designer Course",
        "url": "https://gyannidhi.in/product-designer",
    },
    "PCB Designer": {
        "title": "Gyannidhi — PCB Designer Course",
        "url": "https://gyannidhi.in/pcb-designer",
    },
    "Firmware / Software Developer (Embedded)": {
        "title": "Gyannidhi — Embedded Firmware Course",
        "url": "https://gyannidhi.in/embedded",
    },
    "Integration Engineer": {
        "title": "Gyannidhi — Integration Engineer Course",
        "url": "https://gyannidhi.in/integration",
    },
    "Domain Expert & V&V Engineer": {
        "title": "Gyannidhi — V&V Course",
        "url": "https://gyannidhi.in/vnv",
    },
    "Mechanical Designer": {
        "title": "Gyannidhi — Mechanical Designer Course",
        "url": "https://gyannidhi.in/mechanical",
    },
    "Procurement Specialist": {
        "title": "Gyannidhi — Procurement Specialist Course",
        "url": "https://gyannidhi.in/procurement",
    },
}

# -----------------------------
# DATA DIRECTORY
# -----------------------------
DATA_DIR = Path("data")


# ============================
# HELPERS
# ============================

def _trim(s: str, lim: int = 220) -> str:
    s = (s or "").strip()
    return s if len(s) <= lim else s[:lim] + "…"


def load_bundle(topic: str) -> dict:
    key = TOPIC_MAP.get(topic)
    if not key:
        return {"course": {}, "quiz": {}}

    def read(path: Path):
        if path.exists():
            with path.open("r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    return {
        "course": read(DATA_DIR / f"{key}.course.json"),
        "quiz": read(DATA_DIR / f"{key}.quiz.json")
    }


def compact_course_context(topic: str,
                           per_competency: int = 3,
                           max_quiz_sections: int = 8,
                           max_quiz_stems_per_section: int = 6) -> str:

    bundle = load_bundle(topic)
    course = bundle.get("course", {})
    quiz = bundle.get("quiz", {})

    rnd = random.Random(42)

    # compact course data
    snippets = []
    for comp in course.get("competencies", []):
        subskills = comp.get("subskills", [])
        if len(subskills) > per_competency:
            chosen = rnd.sample(subskills, per_competency)
        else:
            chosen = subskills

        snippets.append({
            "id": comp.get("id", ""),
            "name": comp.get("name", ""),
            "subskills": chosen,
            "responsibilities": comp.get("responsibilities", [])[:5],
            "red_flags": comp.get("red_flags", [])[:4]
        })

    # quiz clues
    quiz_clues = []
    if isinstance(quiz, dict):
        items = list(quiz.items())
        rnd.shuffle(items)
        for sec_name, qs in items[:max_quiz_sections]:
            stems = list(qs)[:max_quiz_stems_per_section]
            quiz_clues.append({
                "section": sec_name,
                "stems": [_trim(x) for x in stems]
            })

    # probe templates
    probes = course.get("probe_templates") or [
        {"id": "define", "pattern": "Define {subskill} in this product context."},
        {"id": "why", "pattern": "Why is {subskill} important for {competency}?"},
        {"id": "steps", "pattern": "List the key steps concisely."},
        {"id": "checks", "pattern": "What checks confirm correctness?"},
        {"id": "instrument", "pattern": "Which instrument verifies this, and what indicates success?"}
    ]

    payload = {
        "topic": topic,
        "coverage": {
            "policy": "breadth_then_depth_without_repetition",
            "per_competency_questions": 2
        },
        "content_snippets": snippets,
        "quiz_clues": quiz_clues,
        "probe_templates": probes
    }

    return json.dumps(payload, separators=(",", ":"))


# ============================
# GROUNDING INSTRUCTIONS
# (Mixed: your wording + corrected rules)
# ============================

def topic_instructions(topic: str, context_text: str) -> str:
    return f"""
You are a professional, Indian-English male technical interviewer for the role "{topic}".
Your job is to conduct a structured, realistic, end-to-end interview based ONLY on the 
competencies, subskills, responsibilities, red flags, and quiz clues provided in the Context JSON.
-during the interview,
STRICT RULES
- Speak ONLY in English.
- NEVER switch topics. If the student asks for another topic, say:
  "We'll continue with the selected topic {topic} as required."
- NEVER praise the student. Avoid: great, nice, excellent, good job, wonderful.
- NEVER teach, guide, or provide hints.
- NEVER answer your own questions.
- NEVER repeat your questions.
- NEVER use templates repeatedly.
- Never say fillers like “okay”, “good”, “alright”, “understood”.

OPENING (MANDATORY)
Your first turn MUST say exactly:
"Hello. Let's start the interview on {topic}. Tell me about yourself and how it relates to {topic}."

INTERVIEW STYLE
- Keep each question short (1–2 sentences).
- Ask ONLY 1 question per turn.
- Wait for silence (server VAD) before asking the next question.
- Every question MUST be a follow-up question based on the student's last answer.
- DO NOT quote context JSON; paraphrase naturally.
- If the student asks YOU a question, say:
  "I’m here to ask questions. Please answer the interview question."
- If the student interrupts, stop speaking immediately.

QUESTION PHASES
Phase 1 (Basic):
- First question = simple introduction.
- Explore fundamental understanding.

Phase 2 (Intermediate):
- Ask ~4 questions about practical subskills, reasoning, steps, checks, constraints,
  diagrams, workflows, tools, instruments.

Phase 3 (Advanced):
- Ask scenario/problem-solving questions.
- Use probe templates naturally.

COVERAGE
- Cover ALL competencies (~2 questions per competency).
- Cover quiz clue sections if relevant.
- Do NOT ask the same concept twice unless the answer was weak.

TOPIC LOCK
- Interview must remain strictly on "{topic}".

AFTER EVERY ANSWER
- NO evaluation.
- NO praise.
- NO teaching.
- Simply ask the next follow-up question.

CLOSING
When coverage is complete or silence for 10 seconds:
- Give a brief closing with:
  * 2 strengths (general)
  * 1 improvement area (general)
- Do NOT leak answers.

OUTPUT MIRROR
- For every spoken question, ALSO output the same text as textual output.
- No extra comments in spoken output.

---- Context JSON (DO NOT read aloud) ----
{context_text}
""".strip()


# ============================
# ROUTES
# ============================

@app.get("/")
async def index():
    return FileResponse("static/index.html")


# ------------------------------------
# /session  → creates interview session
# ------------------------------------
@app.post("/session")
async def create_session(payload: dict):
    topic = payload.get("topic", "").strip()
    if topic not in TOPIC_MAP:
        raise HTTPException(status_code=400, detail="Invalid topic")

    context_text = compact_course_context(topic)
    instructions = topic_instructions(topic, context_text)

    body = {
        "model": REALTIME_MODEL,
        "voice": "alloy",
        "modalities": ["audio", "text"],
        "turn_detection": {"type": "server_vad", "silence_duration_ms": 800},
        "instructions": instructions,
        "input_audio_format": "pcm16",
        "input_audio_transcription": {"model": "whisper-1", "language": "en"}
    }

    import requests
    url = "https://api.openai.com/v1/realtime/sessions"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
    }

    r = requests.post(url, headers=headers, json=body, timeout=20)
    if not r.ok:
        raise HTTPException(status_code=500, detail=f"OpenAI error {r.status_code}: {r.text}")

    data = r.json()
    token = (
        (data.get("client_secret") or {}).get("value")
        or data.get("value")
        or data.get("client_secret")
    )

    if not token:
        raise HTTPException(status_code=500, detail="Ephemeral token missing")

    return {"token": token}


# ------------------------------------
# /upload_recording
# ------------------------------------
@app.post("/upload_recording")
async def upload_recording(file: UploadFile = File(...), topic: str = Form("")):
    try:
        ext = Path(file.filename).suffix or ".webm"
        name = f"{uuid4().hex}{ext}"
        dest = Path("static/recordings") / name

        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        return {"url": f"/static/recordings/{name}"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------
# /analyze → OLD ANALYSIS + NEW SUMMARY
# ------------------------------------
@app.post("/analyze")
async def analyze(request: Dict):
    topic = (request.get("topic") or "").strip()

    Q = request.get("interviewerTurns") or []
    A = request.get("candidateTurns") or []
    recording_url = request.get("recording_url", "")

    qa_pairs = []
    for i in range(max(len(Q), len(A))):
        qa_pairs.append({
            "question": Q[i] if i < len(Q) else "",
            "answer": A[i] if i < len(A) else ""
        })

    # Prompt for OLD ANALYSIS + NEW SUMMARY
    system_msg = "You are a concise objective evaluator. Output ONLY valid JSON."

    user_prompt = f"""
You are given Q/A pairs from an interview for topic "{topic}".

IMPORTANT:
- You DO NOT have access to the actual video or audio, only the text Q/A content.
- Estimate soft skills purely from the textual answers (structure, relevance, completeness, tone).
- Never mention that you "cannot see the video" or "cannot hear the audio". Just give your best estimate.

Produce JSON with the following top-level keys:

- items[] list:
    - question
    - answer
    - expected_answer (2–5 lines)
    - score (0–10)
    - what_you_did_well (list of bullet strings)
    - what_could_be_better (list of bullet strings)
    - missing_terminologies (list of domain terms that were missing or weak)

- overall_score (0–10)  // technical performance
- strengths (list of short bullet strings)
- improvements (list of short bullet strings)
- next_steps (list of short bullet strings)
- analysis_summary (short paragraph, 3–6 sentences)
- recording_url (echo this back exactly)

- non_technical:
    - english_fluency_score (0–10, higher is better)
    - english_fluency_comment (1–3 sentences)
    - confidence_score (0–10, higher is better)
    - confidence_comment (1–3 sentences)
    - attentiveness_score (0–10, higher means they stayed on-topic and responded to the actual questions)
    - attentiveness_comment (1–3 sentences)
    - other_observations (list of short bullet strings about communication/behaviour)

Q/A pairs:
{json.dumps(qa_pairs, indent=2)}

Recording URL (for reference only, do not analyse video): {recording_url}
"""


    try:
        resp = client.chat.completions.create(
            model=ANALYSIS_MODEL,
            messages=[
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.0,
            max_tokens=1600,
        )

        raw = resp.choices[0].message.content.strip()
        try:
            data = json.loads(raw)
        except Exception:
            import re
            m = re.search(r"(\{.*\})", raw, flags=re.S)
            if not m:
                raise RuntimeError("Model returned non-JSON output.")
            data = json.loads(m.group(1))

        items = data.get("items", [])
        overall_score = data.get("overall_score", 0)
        strengths = data.get("strengths", [])
        improvements = data.get("improvements", [])
        next_steps = data.get("next_steps", [])
        analysis_summary = (
            data.get("analysis_summary")
            or data.get("analysis")
            or data.get("summary")
            or data.get("final_summary")
            or ""
        )
        recording_echo = data.get("recording_url", recording_url)
        non_technical = data.get("non_technical", {})


        suggested = SUGGESTED_COURSES.get(topic, {
            "title": f"Gyannidhi — {topic} Course",
            "url": "https://gyannidhi.in"
        })

        return {
            "overall_score": overall_score,
            "items": items,
            "strengths": strengths,
            "improvements": improvements,
            "next_steps": next_steps,
            "analysis": analysis_summary,
            "recording_url": recording_echo,
            "suggested_course": suggested,
            "non_technical": non_technical,
        }

    except Exception as e:
        print("ANALYSIS ERROR:", e)
        return {
            "overall_score": 0,
            "items": [],
            "strengths": [],
            "improvements": [],
            "next_steps": [],
            "analysis": "Analysis failed.",
            "recording_url": "",
            "suggested_course": SUGGESTED_COURSES.get(
                topic, {"title": "Gyannidhi Course", "url": "https://gyannidhi.in"}
            ),
            "non_technical": {},
            
        }
