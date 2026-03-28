require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express      = require('express');
const multer       = require('multer');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const ffmpeg       = require('fluent-ffmpeg');
const { execSync } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const app      = express();
const PORT     = 3001;
const GEMINI_KEY = process.env.tier_3_gemini_key;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const genAI       = new GoogleGenerativeAI(GEMINI_KEY);
const fileManager = new GoogleAIFileManager(GEMINI_KEY);

app.use(cors());
app.use(express.json());
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'outputs'), { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename:    (req, file, cb) => cb(null, `video_${Date.now()}.mp4`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Job store ─────────────────────────────────────────────────────────────────
// step: 0=received, 1=analyzing, 2=styling frame, 3=generating veo, 4=done, -1=error

const jobs = new Map();

function setStep(jobId, step, extra = {}) {
  jobs.set(jobId, { step, ...extra });
}

// ── Video info ────────────────────────────────────────────────────────────────

function getVideoInfo(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const stream = meta.streams.find(s => s.codec_type === 'video');
      resolve({ duration: meta.format.duration, width: stream.width, height: stream.height });
    });
  });
}

// ── Extract frames ────────────────────────────────────────────────────────────

function extractFrames(videoPath, outputDir, fps) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions('-vf', `fps=${fps}`)
      .output(path.join(outputDir, 'frame_%04d.jpg'))
      .on('end', () => {
        const files = fs.readdirSync(outputDir)
          .filter(f => f.match(/frame_\d+\.jpg$/))
          .sort()
          .map(f => path.join(outputDir, f));
        resolve(files);
      })
      .on('error', reject)
      .run();
  });
}

// ── Step A: Analyze full video ────────────────────────────────────────────────

async function analyzeVideo(videoPath, style) {
  console.log('Uploading video to Gemini...');
  const uploadResult = await fileManager.uploadFile(videoPath, {
    mimeType: 'video/mp4',
    displayName: path.basename(videoPath),
  });
  let file = uploadResult.file;
  while (file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 2000));
    file = await fileManager.getFile(file.name);
  }
  if (file.state === 'FAILED') throw new Error('Gemini failed to process video');

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const [narrationRes, motionRes, audioRes] = await Promise.all([
    model.generateContent([
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
      'Write a vivid 2-3 sentence narration of this video as a movie scene.',
    ]),
    model.generateContent([
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
      `Analyze this video for use as a Veo AI video generation prompt in "${style}" style.

Describe in detail:
1. Every person visible: exact skin tone, hair, clothing, position, what they are doing
2. The setting: architecture, objects, layout
3. All motion and actions throughout the video: what moves, how, in what direction
4. Camera movement: pan, static, zoom, etc.
5. Duration and pacing of actions

Then write a single Veo prompt that recreates these exact motions and people in "${style}" style.
The prompt must describe the action/motion over time, not just a static scene.
Preserve every person's physical details (skin tone, hair, clothing).
Include "${style}" visual elements (lighting, colors, atmosphere).

Reply with ONLY the final Veo prompt. 200-300 words.`,
    ]),
    model.generateContent([
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
      `Transcribe this video's audio exactly.
- Quote all speech word-for-word with speaker labels if multiple people
- Describe tone/emotion (e.g. laughing, whispering, shouting)
- Note significant background sounds, music, or ambient noise
- Note silence if there is none
Be concise and precise.`,
    ]),
  ]);

  const transcription = audioRes.response.text().trim();
  const basePrompt    = motionRes.response.text().trim();
  const motionPrompt  = transcription
    ? `${basePrompt}\n\nAudio to reproduce: ${transcription}`
    : basePrompt;

  return {
    narration: narrationRes.response.text().trim(),
    motionPrompt,
    transcription,
  };
}

// ── Step B: Build Imagen prompt for first frame ───────────────────────────────

async function buildFirstFramePrompt(framePath, style, model) {
  const imageData = fs.readFileSync(framePath).toString('base64');
  const result = await model.generateContent([
    { inlineData: { mimeType: 'image/jpeg', data: imageData } },
    `Create an Imagen prompt to redraw this exact frame in "${style}" style.

Describe every detail:
- Each person: exact skin tone, hair color/style, clothing (color, type), position, expression
- Setting: every object, architecture, textures
- Lighting and composition

Write a single image generation prompt that recreates this EXACT scene in "${style}" style.
Preserve all people's appearances faithfully. 150-200 words.
Reply with ONLY the prompt.`,
  ]);
  return result.response.text().trim();
}

// ── Step C: Generate styled first frame with Imagen ──────────────────────────

async function generateStyledFrame(prompt, aspectRatio) {
  const response = await fetch(
    `${API_BASE}/models/imagen-4.0-generate-001:predict?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances:  [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio },
      }),
    }
  );
  const data = await response.json();
  if (!data.predictions?.[0]?.bytesBase64Encoded) {
    throw new Error('Imagen error: ' + JSON.stringify(data).slice(0, 200));
  }
  return data.predictions[0].bytesBase64Encoded;
}

// ── Step D: Veo image-to-video ────────────────────────────────────────────────

async function generateVeoVideo(styledFrameB64, motionPrompt, aspectRatio) {
  console.log('Sending styled frame + motion prompt to Veo...');
  const response = await fetch(
    `${API_BASE}/models/veo-3.0-fast-generate-001:predictLongRunning?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{
          prompt: motionPrompt,
          image: { bytesBase64Encoded: styledFrameB64, mimeType: 'image/jpeg' },
        }],
        parameters: { aspectRatio },
      }),
    }
  );

  const opData = await response.json();
  if (!opData.name) throw new Error('Veo no operation returned: ' + JSON.stringify(opData).slice(0, 200));
  console.log('Veo operation:', opData.name);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`${API_BASE}/${opData.name}?key=${GEMINI_KEY}`);
    const result  = await pollRes.json();
    console.log(`Poll ${i + 1}: done=${result.done}`);
    if (!result.done) continue;

    if (result.error) throw new Error('Veo error: ' + result.error.message);

    const filtered = result.response?.generateVideoResponse?.raiMediaFilteredCount;
    if (filtered && filtered > 0) {
      const reasons = result.response?.generateVideoResponse?.raiMediaFilteredReasons;
      throw new Error('Veo RAI filtered: ' + JSON.stringify(reasons));
    }

    const uri = result.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    const b64 = result.response?.predictions?.[0]?.bytesBase64Encoded;

    if (uri) {
      const downloadUrl = uri.includes('?') ? `${uri}&key=${GEMINI_KEY}` : `${uri}?alt=media&key=${GEMINI_KEY}`;
      const vr = await fetch(downloadUrl);
      if (!vr.ok) throw new Error('Video download failed: ' + vr.status);
      return Buffer.from(await vr.arrayBuffer());
    }
    if (b64) return Buffer.from(b64, 'base64');

    throw new Error('Veo returned no video: ' + JSON.stringify(result).slice(0, 300));
  }
  throw new Error('Veo timed out');
}

// ── Pipeline (runs async after upload) ───────────────────────────────────────

async function runPipeline(jobId, videoPath, style, ts) {
  const framesDir  = path.join(__dirname, 'outputs', `frames_${ts}`);
  const outputPath = path.join(__dirname, 'outputs', `transformed_${ts}.mp4`);
  fs.mkdirSync(framesDir, { recursive: true });

  let videoInfo;
  try {
    videoInfo = await getVideoInfo(videoPath);
    console.log(`${videoInfo.duration.toFixed(1)}s ${videoInfo.width}x${videoInfo.height}`);
  } catch (err) {
    setStep(jobId, -1, { error: 'Could not read video: ' + err.message });
    return;
  }

  const aspectRatio = videoInfo.width < videoInfo.height ? '9:16' : '16:9';

  // Step 1: Analyze
  setStep(jobId, 1);
  let framePaths, narration, motionPrompt;
  try {
    [[framePaths], { narration, motionPrompt }] = await Promise.all([
      extractFrames(videoPath, framesDir, 1).then(f => [f]),
      analyzeVideo(videoPath, style),
    ]);
    console.log('Analysis done.');
  } catch (err) {
    setStep(jobId, -1, { error: 'Analysis failed: ' + err.message });
    return;
  }

  // Step 2: Style frame
  setStep(jobId, 2);
  let styledFrameB64;
  try {
    console.log('Generating styled reference frame with Imagen...');
    const model       = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const framePrompt = await buildFirstFramePrompt(framePaths[0], style, model);
    styledFrameB64    = await generateStyledFrame(framePrompt, aspectRatio);
    console.log('Styled frame ready.');
  } catch (err) {
    setStep(jobId, -1, { error: 'Imagen frame failed: ' + err.message });
    return;
  }

  // Step 3: Veo
  setStep(jobId, 3);
  let videoBuffer;
  try {
    videoBuffer = await generateVeoVideo(styledFrameB64, motionPrompt, aspectRatio);
    fs.writeFileSync(outputPath, videoBuffer);
    console.log('Veo video saved:', outputPath, `(${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    console.error('Veo error:', err.message);
    setStep(jobId, -1, { error: 'Veo failed: ' + err.message });
    return;
  }

  // Cleanup frames
  framePaths.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.rmdirSync(framesDir); } catch {}

  // Step 4: Done
  setStep(jobId, 4, {
    result: {
      narration,
      style,
      transformedVideoUrl: `/outputs/transformed_${ts}.mp4`,
    },
  });
}

// ── Edit pipeline: ffmpeg stitch ──────────────────────────────────────────────

// One transition per cut — picks from a vibe-matched pool, cycling through variety
function getTransitions(count, vibe) {
  const v = (vibe || '').toLowerCase();
  let pool;
  if (v.match(/glitch|hack|cyber|tech/))            pool = ['pixelize', 'fadeblack', 'wipeleft'];
  else if (v.match(/fast|hype|fire|energy|lit/))    pool = ['wipeleft', 'wiperight', 'slideleft', 'slideright'];
  else if (v.match(/dream|chill|soft|calm|lo.?fi/)) pool = ['dissolve', 'fade', 'fadegrays'];
  else if (v.match(/retro|vhs|vintage|80s/))        pool = ['fadeblack', 'pixelize', 'fade'];
  else                                               pool = ['fade', 'dissolve', 'wipeleft', 'fadeblack'];
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}

// Color grade filter string based on vibe
function getColorGrade(vibe) {
  const v = (vibe || '').toLowerCase();
  if (v.match(/hype|fire|energy|fast|lit|hard/))
    return 'eq=saturation=1.4:contrast=1.15,vignette';
  if (v.match(/chill|soft|calm|lo.?fi|dream/))
    return 'eq=saturation=0.85:brightness=0.04:contrast=0.95,vignette=angle=PI/4';
  if (v.match(/retro|vhs|vintage|80s/))
    return 'eq=saturation=1.3:contrast=1.1:gamma_r=1.1:gamma_b=0.9,vignette';
  if (v.match(/cinematic|epic|film|dark|moody/))
    return 'eq=contrast=1.1:saturation=0.9,vignette';
  return 'eq=contrast=1.05:saturation=1.1';
}

// Decide how much of a clip to keep — skip shaky opening, cap at maxDur
function computeTrim(info, maxDur = 8) {
  if (info.duration <= maxDur) return { start: 0, duration: info.duration };
  const start = Math.min(1.5, info.duration * 0.1); // skip first ~10% (setup/shake)
  return { start, duration: maxDur };
}

// ── Music selection ───────────────────────────────────────────────────────────

// Parse vibe string for a specific artist or song to search for.
// Returns a yt-dlp search query string, or null if none found.
function parseArtistSong(vibe) {
  const v = vibe || '';
  let m;
  // "song: X" or "artist: X"
  m = v.match(/song:\s*([^,\n]+)/i);  if (m) return m[1].trim() + ' official audio';
  m = v.match(/artist:\s*([^,\n]+)/i); if (m) return m[1].trim() + ' music';
  // "Artist - Song"
  m = v.match(/^([^,\n]+?)\s+-\s+([^,\n]+)/);
  if (m) return `${m[1].trim()} ${m[2].trim()} audio`;
  // "in the style of X" / "like X" / "X vibe"
  m = v.match(/(?:in the style of|like|inspired by)\s+([a-zA-Z0-9\s]+?)(?:\s*,|$)/i);
  if (m) return m[1].trim() + ' background music';
  return null;
}

function findYtdlp() {
  const candidates = [
    'yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    `${process.env.HOME}/.local/bin/yt-dlp`,
  ];
  for (const bin of candidates) {
    try { execSync(`"${bin}" --version`, { stdio: 'ignore' }); return bin; }
    catch { /* try next */ }
  }
  return null;
}

// Lyria 2 via Vertex AI.
// Requires: npm install google-auth-library  +  GOOGLE_CLOUD_PROJECT in .env
// + gcloud auth application-default login (or service account key)
async function generateLyriaMusic(prompt, durationSecs) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error('GOOGLE_CLOUD_PROJECT not set');
  // google-auth-library is not installed by default — add it first
  const { GoogleAuth } = require('google-auth-library');
  const auth  = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const token = await auth.getAccessToken();
  const res = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/lyria-002:predict`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        instances:  [{ prompt, durationSeconds: Math.min(30, Math.ceil(durationSecs)) }],
        parameters: { sampleCount: 1 },
      }),
    }
  );
  const data = await res.json();
  if (!data.predictions?.[0]?.bytesBase64Encoded) throw new Error('Lyria no audio: ' + JSON.stringify(data).slice(0, 200));
  return Buffer.from(data.predictions[0].bytesBase64Encoded, 'base64');
}

// Returns path to a music file, or null if nothing found.
async function findMusic(vibe, totalDur, ts) {
  // 1. yt-dlp — specific artist/song from vibe string
  const query  = parseArtistSong(vibe);
  const ytdlp  = findYtdlp();
  if (query && ytdlp) {
    const out = path.join(__dirname, 'uploads', `music_${ts}.mp3`);
    try {
      execSync(
        `"${ytdlp}" -x --audio-format mp3 --audio-quality 5 --no-playlist -o "${out}" "ytsearch1:${query}"`,
        { timeout: 60000, stdio: 'pipe' }
      );
      if (fs.existsSync(out)) { console.log(`Music: yt-dlp "${query}"`); return out; }
    } catch (err) { console.warn('yt-dlp failed:', err.message); }
  } else if (query) {
    console.log('Music: yt-dlp not found — install with: brew install yt-dlp');
  }

  // 2. Pre-bundled tracks in backend/music/
  const musicDir = path.join(__dirname, 'music');
  if (fs.existsSync(musicDir)) {
    const vibeKey = (vibe || '').toLowerCase();
    const trackMap = { hype: /fast|hype|fire|energy|lit/, chill: /chill|calm|soft|lo.?fi/, cinematic: /cinematic|epic|dramatic/, retro: /retro|vhs|vintage/ };
    for (const [name, re] of Object.entries(trackMap)) {
      const f = path.join(musicDir, `${name}.mp3`);
      if (re.test(vibeKey) && fs.existsSync(f)) { console.log(`Music: bundled ${name}.mp3`); return f; }
    }
    const def = path.join(musicDir, 'default.mp3');
    if (fs.existsSync(def)) { console.log('Music: bundled default.mp3'); return def; }
  }

  // 3. Lyria 2 via Vertex AI (needs google-auth-library + GOOGLE_CLOUD_PROJECT)
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    try {
      const prompt = `Instrumental background music for a video edit. Vibe: ${vibe || 'energetic, cinematic'}. No vocals.`;
      const buf = await generateLyriaMusic(prompt, totalDur);
      const out = path.join(__dirname, 'uploads', `music_${ts}.mp3`);
      fs.writeFileSync(out, buf);
      console.log('Music: generated via Lyria');
      return out;
    } catch (err) { console.warn('Lyria failed:', err.message); }
  }

  console.log('Music: none found, edit will be silent');
  return null;
}

// ── Stitch: clip audio stripped, color grade + varied transitions + fade in/out + music ──

// trims = [{start, duration}, ...] one per clip
function stitchClips(videoPaths, trims, infos, vibe, musicFile, outputPath) {
  return new Promise((resolve, reject) => {
    const T           = 0.5;
    const N           = videoPaths.length;
    const transitions = getTransitions(N - 1, vibe);
    const colorGrade  = getColorGrade(vibe);
    const trimDurs    = trims.map(t => t.duration);
    const totalDur    = trimDurs.reduce((s, d) => s + d, 0) - Math.max(0, N - 1) * T;

    const targetW = infos[0].width  % 2 === 0 ? infos[0].width  : infos[0].width  - 1;
    const targetH = infos[0].height % 2 === 0 ? infos[0].height : infos[0].height - 1;

    // Build command: each clip input with seek+duration for trimming
    let cmd = ffmpeg();
    videoPaths.forEach((p, i) => {
      cmd = cmd.input(p).inputOptions([`-ss ${trims[i].start}`, `-t ${trims[i].duration}`]);
    });
    if (musicFile) cmd = cmd.input(musicFile);
    const musicIdx = N;

    const filters   = [];
    const fadeInDur = 0.4;
    const fadeOutSt = Math.max(0, totalDur - fadeInDur).toFixed(3);

    if (N === 1) {
      // Single clip: grade + fade in/out + optional music
      filters.push(
        `[0:v]setpts=PTS-STARTPTS,` +
        `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
        `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,${colorGrade},` +
        `fade=t=in:st=0:d=${fadeInDur},fade=t=out:st=${fadeOutSt}:d=${fadeInDur}[vout]`
      );
      if (musicFile) {
        filters.push(`[${musicIdx}:a]aloop=loop=-1:size=2e+09,volume=0.5,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
      }
      const mapOpts = ['-map [vout]'];
      const encOpts = ['-c:v libx264', '-crf 22', '-preset fast', '-movflags +faststart'];
      if (musicFile) { mapOpts.push('-map [aout]'); encOpts.push('-c:a aac', '-ar 44100'); }
      cmd.complexFilter(filters).outputOptions([...mapOpts, ...encOpts])
        .output(outputPath).on('end', resolve).on('error', reject).run();
      return;
    }

    // Normalize each clip: reset timestamps + scale + color grade
    for (let i = 0; i < N; i++) {
      filters.push(
        `[${i}:v]setpts=PTS-STARTPTS,` +
        `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
        `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,${colorGrade}[nv${i}]`
      );
    }

    // xfade chain — different transition per cut
    let prevV = 'nv0', sumDur = 0;
    for (let i = 1; i < N; i++) {
      sumDur += trimDurs[i - 1];
      const offset = Math.max(0.1, sumDur - i * T).toFixed(3);
      const tr  = transitions[i - 1];
      const out = i === N - 1 ? 'vxfade' : `xv${i}`;
      filters.push(`[${prevV}][nv${i}]xfade=transition=${tr}:duration=${T}:offset=${offset}[${out}]`);
      prevV = out;
    }

    // Fade in at start + fade out at end on the assembled video
    filters.push(
      `[vxfade]fade=t=in:st=0:d=${fadeInDur},fade=t=out:st=${fadeOutSt}:d=${fadeInDur}[vout]`
    );

    const mapOpts = ['-map [vout]'];
    const encOpts = ['-c:v libx264', '-crf 22', '-preset fast', '-movflags +faststart'];

    if (musicFile) {
      filters.push(`[${musicIdx}:a]aloop=loop=-1:size=2e+09,volume=0.5,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
      mapOpts.push('-map [aout]');
      encOpts.push('-c:a aac', '-ar 44100');
    }

    cmd.complexFilter(filters).outputOptions([...mapOpts, ...encOpts])
      .output(outputPath).on('end', resolve).on('error', reject).run();
  });
}

async function runEditPipeline(jobId, videoPaths, vibe, ts) {
  const outputPath = path.join(__dirname, 'outputs', `edit_${ts}.mp4`);

  // Step 1: Get clip info + generate caption in parallel
  setStep(jobId, 1);
  let infos, narration;
  try {
    [infos, narration] = await Promise.all([
      Promise.all(videoPaths.map(p => getVideoInfo(p))),
      (async () => {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const res = await model.generateContent(
          `Write a short energetic 1-2 sentence caption for a video edit made from ${videoPaths.length} clip${videoPaths.length !== 1 ? 's' : ''}${vibe ? ` with the vibe: "${vibe}"` : ''}. Be hype and brief.`
        );
        return res.response.text().trim();
      })().catch(() => `${videoPaths.length} clips${vibe ? ` — ${vibe}` : ''}`),
    ]);
    console.log(`Edit: ${videoPaths.length} clips ready, computing trims`);
  } catch (err) {
    setStep(jobId, -1, { error: 'Could not read clips: ' + err.message });
    return;
  }

  // Compute trim ranges: skip shaky openings, cap long clips at 8s
  const trims = infos.map(info => computeTrim(info, 8));
  trims.forEach((t, i) => console.log(`  Clip ${i + 1}: ${infos[i].duration.toFixed(1)}s → keep ${t.start.toFixed(1)}s–${(t.start + t.duration).toFixed(1)}s`));

  // Step 2: Find music (yt-dlp → bundled files → Lyria → silent)
  setStep(jobId, 2);
  const totalRawDur = trims.reduce((s, t) => s + t.duration, 0);
  const musicFile   = await findMusic(vibe, totalRawDur, ts);

  // Step 3: Stitch with color grade + varied transitions + fade in/out + music
  setStep(jobId, 3);
  try {
    await stitchClips(videoPaths, trims, infos, vibe, musicFile, outputPath);
    console.log('Edit: done', outputPath);
  } catch (err) {
    console.error('Stitch error:', err.message);
    setStep(jobId, -1, { error: 'Stitch failed: ' + err.message });
    return;
  }

  // Cleanup
  videoPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
  if (musicFile && musicFile.includes('uploads')) { try { fs.unlinkSync(musicFile); } catch {} }

  setStep(jobId, 4, {
    result: {
      narration,
      style: vibe || 'cinematic',
      transformedVideoUrl: `/outputs/edit_${ts}.mp4`,
    },
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const videoPath = req.file.path;
  const style     = req.body.style || 'cyberpunk';
  const ts        = Date.now();
  const jobId     = `job_${ts}`;

  console.log('\n=== New job:', jobId, '| Style:', style);

  // Acknowledge immediately
  setStep(jobId, 0);
  res.json({ jobId });

  // Run pipeline in background
  runPipeline(jobId, videoPath, style, ts).catch(err => {
    console.error('Pipeline crash:', err);
    setStep(jobId, -1, { error: err.message });
  });
});

app.post('/edit', upload.array('clips', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No clips received' });

  const vibe  = req.body.vibe || '';
  const ts    = Date.now();
  const jobId = `job_${ts}`;

  console.log('\n=== New edit job:', jobId, '| Clips:', req.files.length, '| Vibe:', vibe);

  setStep(jobId, 0);
  res.json({ jobId });

  runEditPipeline(jobId, req.files.map(f => f.path), vibe, ts).catch(err => {
    console.error('Edit pipeline crash:', err);
    setStep(jobId, -1, { error: err.message });
  });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Morfit backend running on http://0.0.0.0:${PORT}`);
});
