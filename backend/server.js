require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const app = express();
const PORT = 3001;
const GEMINI_KEY = process.env.tier_3_gemini_key;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const fileManager = new GoogleAIFileManager(GEMINI_KEY);

app.use(cors());
app.use(express.json());
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'outputs'), { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, `video_${Date.now()}.mp4`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Video info ───────────────────────────────────────────────────────────────

function getVideoInfo(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const stream = meta.streams.find(s => s.codec_type === 'video');
      resolve({ duration: meta.format.duration, width: stream.width, height: stream.height });
    });
  });
}

// ── Extract frames ───────────────────────────────────────────────────────────

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

// ── Step A: Analyze full video with Gemini (narration + motion description) ──

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

  const [narrationRes, motionRes] = await Promise.all([
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
  ]);

  return {
    narration: narrationRes.response.text().trim(),
    motionPrompt: motionRes.response.text().trim(),
  };
}

// ── Step B: Build Imagen prompt for first frame ──────────────────────────────

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
        instances: [{ prompt }],
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

async function generateVeoVideo(styledFrameB64, motionPrompt, aspectRatio, duration) {
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
        parameters: { aspectRatio, durationSeconds: duration },
      }),
    }
  );

  const opData = await response.json();
  if (!opData.name) throw new Error('Veo no operation returned: ' + JSON.stringify(opData).slice(0, 200));
  console.log('Veo operation:', opData.name);

  // Poll up to 5 minutes
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`${API_BASE}/${opData.name}?key=${GEMINI_KEY}`);
    const result = await pollRes.json();
    console.log(`Poll ${i + 1}: done=${result.done}`);
    if (!result.done) continue;

    if (result.error) throw new Error('Veo error: ' + result.error.message);

    // Check for RAI filter
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

// ── Main route ────────────────────────────────────────────────────────────────

app.post('/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file received' });

  const videoPath = req.file.path;
  const style = req.body.style || 'cyberpunk';
  const ts = Date.now();
  const framesDir = path.join(__dirname, 'outputs', `frames_${ts}`);
  const outputPath = path.join(__dirname, 'outputs', `transformed_${ts}.mp4`);

  fs.mkdirSync(framesDir, { recursive: true });

  console.log('\n=== New request ===');
  console.log('Video:', videoPath, '| Style:', style);

  // Get video info
  let videoInfo;
  try {
    videoInfo = await getVideoInfo(videoPath);
    console.log(`${videoInfo.duration.toFixed(1)}s ${videoInfo.width}x${videoInfo.height}`);
  } catch (err) {
    return res.json({ success: false, error: 'Could not read video: ' + err.message });
  }

  const aspectRatio = videoInfo.width < videoInfo.height ? '9:16' : '16:9';

  // Extract just the first frame + analyze full video in parallel
  let framePaths, narration, motionPrompt;
  try {
    [[framePaths], { narration, motionPrompt }] = await Promise.all([
      extractFrames(videoPath, framesDir, 1).then(f => [f]), // 1fps, just need first frame
      analyzeVideo(videoPath, style),
    ]);
    console.log('Analysis done. Motion prompt ready.');
  } catch (err) {
    return res.json({ success: false, error: 'Analysis failed: ' + err.message });
  }

  // Generate styled first frame with Imagen
  let styledFrameB64;
  try {
    console.log('Generating styled reference frame with Imagen...');
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const framePrompt = await buildFirstFramePrompt(framePaths[0], style, model);
    console.log('Frame prompt:', framePrompt.slice(0, 100) + '...');
    styledFrameB64 = await generateStyledFrame(framePrompt, aspectRatio);
    console.log('Styled frame ready.');
  } catch (err) {
    return res.json({ success: false, error: 'Imagen frame failed: ' + err.message });
  }

  // Veo: styled image → full video with motion
  let videoBuffer;
  try {
    const veoDuration = Math.min(8, Math.max(4, Math.round(videoInfo.duration)));
    videoBuffer = await generateVeoVideo(styledFrameB64, motionPrompt, aspectRatio, veoDuration);
    fs.writeFileSync(outputPath, videoBuffer);
    console.log('Veo video saved:', outputPath, `(${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    console.error('Veo error:', err.message);
    // Fallback: return the styled frame as a still image if Veo fails
    return res.json({ success: false, narration, error: 'Veo failed: ' + err.message });
  }

  // Cleanup
  framePaths.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.rmdirSync(framesDir); } catch {}

  res.json({
    success: true,
    narration,
    style,
    transformedVideoUrl: `/outputs/transformed_${ts}.mp4`,
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Morfit backend running on http://0.0.0.0:${PORT}`);
});
