# Morfit

AI-powered video transformation app. Record or upload a video on iPhone and Morfit transforms it into a fully AI-generated styled clip — cyberpunk, noir, anime, and more — using Google's Imagen 4 and Veo 3.

## What it does

**Clip Morfer** — Upload or record a short video. Morfit analyzes the scene with Gemini, generates a styled reference frame with Imagen 4, then uses Veo 3 to produce a fully AI-rendered video that preserves your motion and people.

**Edit Maker** — Drop multiple clips and describe a vibe. Morfit finds matching music, applies color grading, cuts with dynamic transitions, and stitches everything into a shareable edit.

**Library** — Browse all your generated clips and edits, play them back, and save to your camera roll.

## Tech stack

| Layer | Stack |
|---|---|
| Frontend | React Native / Expo SDK 55 |
| Backend | Node.js / Express |
| AI — scene analysis | Gemini 2.5 Flash (video + vision) |
| AI — styled frame | Imagen 4 (`imagen-4.0-generate-001`) |
| AI — video generation | Veo 3 Fast (`veo-3.0-fast-generate-001`) |
| Music | yt-dlp → bundled tracks → Jamendo |
| Video processing | ffmpeg (fluent-ffmpeg) |
| Tunnel | ngrok |

## Pipeline

```
Upload video
    ↓
Gemini analyzes full video → motion prompt + transcription
Gemini Vision on first frame → Imagen prompt          (parallel)
    ↓
Imagen 4 generates styled reference frame
    ↓
Veo 3 image-to-video: styled frame + motion prompt → AI video
    ↓
Result served to app
```

## Setup

### Requirements

- Node.js 18+
- ffmpeg installed (`brew install ffmpeg`)
- ngrok account + CLI
- Google AI Studio API key (Gemini / Imagen / Veo access)
- yt-dlp for music (`brew install yt-dlp`)

### Environment

Create `.env` in the project root:

```
tier_3_gemini_key=YOUR_GEMINI_API_KEY
JAMENDO_CLIENT_ID=YOUR_JAMENDO_CLIENT_ID
```

### Run

```bash
# Terminal 1 — backend + ngrok (auto-patches BACKEND_URL in App.js)
./start.sh

# Terminal 2 — Expo dev server
npx expo start

# First time or after native changes
npx expo run:ios --device
```

> Requires a physical iPhone. Not compatible with Expo Go.

## Constraints

- Veo clips are 4–8 seconds (hard API limit)
- Max upload: 500MB
- Edit Maker supports up to 10 clips
- Music starts ~30% into the track (past the intro, near the first chorus)
