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

## What still needs to be done
- [ ] Better loading UX: step-by-step progress ("Analyzing...", "Styling frame...", "Generating video...") instead of a single status string
- [ ] Handle videos longer than 8s — either warn user or trim before sending
- [ ] Show original video preview before/after transformation
- [ ] Error recovery: if Veo fails, show an error msg
- [ ] Clean up old outputs on the backend (disk fills up over time)
- [ ] Add more styles or let user describe a full scene transformation
- [ ] Sound/audio: Veo 3 supports audio generation — explore enabling it
- [ ] Add whole new feature upload alot of clips and be like make me a fire edit as a cool feature (not using filter or another feature)
- [ ] make ui a hybrid of dark and light theme
- [ ] add library feature that allows ppl to see videos uploaded along with outputs that are binded to the videos that were uploaded
- [ ] think about ways to add another track to the edit functionality - tracks are nanobanana, lyra and veo (i cant use veo to edit)
- [ ] make it get rid of the audio in all the clips so that it could put music ontop aybe use google music to search for music (if they name a specific artist then put it or a specific song)