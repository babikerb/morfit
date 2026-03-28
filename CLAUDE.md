# Morfit – Reality Editor

AI-powered video transformation app. Record or upload a video on iPhone → backend transforms it into a fully AI-generated styled video (cyberpunk, noir, anime, etc.) using Google's Imagen + Veo.

## Architecture

**Frontend**: React Native / Expo SDK 55 canary (`npx expo run:ios --device` — NOT compatible with Expo Go)
**Backend**: Node.js/Express on port 3001, tunneled via ngrok

### Pipeline (backend/server.js)
1. Upload video via multipart/form-data (multer, 500MB limit)
2. `getVideoInfo` — ffprobe reads duration, width, height
3. `extractFrames` — ffmpeg extracts frames at 1fps (only first frame used)
4. `analyzeVideo` — uploads full video to Gemini Files API (`gemini-2.5-flash`), gets:
   - **narration**: 2–3 sentence movie-scene description
   - **motionPrompt**: detailed Veo prompt preserving people's appearances + motion
5. `buildFirstFramePrompt` — Gemini Vision on first frame → Imagen prompt
6. `generateStyledFrame` — Imagen 4 (`imagen-4.0-generate-001`) REST `predict` endpoint → styled reference frame (base64)
7. `generateVeoVideo` — Veo 3 Fast (`veo-3.0-fast-generate-001`) `predictLongRunning`:
   - Input: styled frame (image-to-video) + motion prompt
   - Duration: clamped to 4–8s (Veo hard limit), matches original video length
   - Polls every 5s up to 5 min
   - Downloads video from `generatedSamples[0].video.uri` + `&key=GEMINI_KEY`

### Key constraints
- Veo duration: 4–8 seconds only (hard API limit)
- Gemini model: `gemini-2.5-flash` (2.0-flash is deprecated)
- Imagen endpoint: `predict` (not `generateImages`), returns `predictions[0].bytesBase64Encoded`
- Veo URI already contains `?alt=media` — append `&key=` not `?alt=media&key=`
- ffmpeg build lacks libfreetype (`drawtext` unavailable) and some filters — keep ffmpeg usage minimal

## Running the app

```bash
# Terminal 1 — start backend + ngrok + auto-update App.js with tunnel URL
./start.sh

# Terminal 2 — start Expo dev server
npx expo start

# Build to device (first time or after native changes)
npx expo run:ios --device
```

## Environment
- `.env` in project root (not committed): `tier_3_gemini_key=...`
- ngrok free tier — URL changes each restart, `start.sh` auto-patches `BACKEND_URL` in `App.js`

## Frontend (App.js)
- Style chips: cyberpunk, noir, comic, warm, vhs + free-text input for custom styles
- Two buttons: **Record** (camera) and **Upload** (library picker)
- XHR with 6-minute timeout (Veo generation takes 60–120s + upload time)
- Shows transformed video (expo-video, looping) + Gemini narration card

## Edit Maker — music pipeline

Clip audio is always stripped. Music is found via this priority chain (`findMusic` in server.js):

1. **yt-dlp** (if installed) — user names an artist/song in the vibe field → searches YouTube and pulls the audio. Detection patterns: `"artist: X"`, `"song: X"`, `"X - Y"`, `"in the style of X"`, `"like X"`. Install: `brew install yt-dlp`
2. **Bundled tracks** — drop mp3s in `backend/music/`: `hype.mp3`, `chill.mp3`, `cinematic.mp3`, `retro.mp3`, `default.mp3`
3. **Lyria 2** (Google's AI music model, Vertex AI) — needs:
   - `npm install google-auth-library` in backend
   - `GOOGLE_CLOUD_PROJECT=your-project-id` in `.env`
   - `gcloud auth application-default login` (or service account key)
   - Model: `lyria-002` via `us-central1-aiplatform.googleapis.com`
   - Called in `generateLyriaMusic()` in server.js — already stubbed, just needs deps
4. **Silent** — no music if none of the above works

> "nanobanana" — investigate what model/service this refers to and add as option 4

## What still needs to be done
- [ ] Handle videos longer than 8s — either warn user or trim before sending
- [ ] Show original video preview before/after transformation (clip gen)
- [ ] Clean up old outputs on the backend (disk fills up over time)
- [ ] Add more styles or let user describe a full scene transformation
- [ ] make ui a hybrid of dark and light theme
- [ ] add library feature that allows ppl to see videos uploaded along with outputs that are binded to the videos that were uploaded
- [ ] Install yt-dlp on server machine for music search to work
- [ ] Set up Lyria via Vertex AI (see music pipeline above)
