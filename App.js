import { useState, useRef, useEffect } from 'react';
import {
  Text, View, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Image, Dimensions, SafeAreaView, Animated, Keyboard,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useVideoPlayer, VideoView } from 'expo-video';
import { StatusBar } from 'expo-status-bar';

const BACKEND_URL = 'https://nippily-goosepimply-lilah.ngrok-free.dev';
const { width: SW } = Dimensions.get('window');

const CLIP_STATUS = [
  'Uploading your video…',
  'Reading the scene…',
  'Applying the style…',
  'Generating your video…',
];
const EDIT_STATUS = [
  'Uploading your clips…',
  'Reading clips…',
  'Finding music…',
  'Stitching your edit…',
];
// Progress target per backend step (0=uploading, 1=analyze, 2=style, 3=generate, 4=done)
const STEP_PROGRESS = [0.08, 0.28, 0.62, 0.84, 1.0];

const STYLES = [
  { id: 'cyberpunk', label: 'Cyberpunk', bg: '#211535' },
  { id: 'noir',      label: 'Noir',      bg: '#1c1c1c' },
  { id: 'comic',     label: 'Comic',     bg: '#b8521e' },
  { id: 'warm',      label: 'Warm Film', bg: '#7e4020' },
  { id: 'vhs',       label: 'VHS',       bg: '#12362a' },
  { id: 'anime',     label: 'Anime',     bg: '#3a1650' },
];

const C = {
  bg:        '#080808',
  surface:   '#111111',
  elevated:  '#1a1a1a',
  border:    '#252525',
  text:      '#efefef',
  textMid:   '#787878',
  textFaint: '#3a3a3a',
  accent:    '#5fc8ff',
  done:      '#5fc8ff',
  record:    '#e05555',
};

const CARD_W = (SW - 40 - 12) / 2;
const CLIP_W = (SW - 40 - 12) / 2;

export default function App() {
  const [screen, setScreen]             = useState('home');
  const [mode, setMode]                 = useState('clip');
  const [capturedUri, setCapturedUri]   = useState(null);
  const [style, setStyle]               = useState('cyberpunk');
  const [customStyle, setCustomStyle]   = useState('');
  const [editClips, setEditClips]       = useState([]);
  const [editVibe, setEditVibe]         = useState('');
  const [uploadPct, setUploadPct]       = useState(0);
  const [jobId, setJobId]               = useState(null);
  const [backendStep, setBackendStep]   = useState(0);
  const [result, setResult]             = useState(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [styleError, setStyleError]     = useState('');

  const pollingRef = useRef(false);

  const slideAnim    = useRef(new Animated.Value(0)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const modalAnim    = useRef(new Animated.Value(400)).current;
  const tabAnim      = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  const previewPlayer     = useVideoPlayer(capturedUri, p => { p.loop = true; p.volume = 0; });
  const originalPlayer    = useVideoPlayer(result?.originalUri ?? null, p => { p.loop = true; });
  const transformedPlayer = useVideoPlayer(result?.videoUrl    ?? null, p => { p.loop = true; });

  useEffect(() => {
    if (screen === 'style' && capturedUri) previewPlayer.play();
    else previewPlayer.pause?.();
  }, [screen, capturedUri]);

  useEffect(() => {
    if (screen !== 'result') return;
    if (showOriginal) { originalPlayer.play(); transformedPlayer.pause?.(); }
    else              { transformedPlayer.play(); originalPlayer.pause?.(); }
  }, [screen, showOriginal]);

  // ── Navigation ─────────────────────────────────────────────────────────────

  function goTo(newScreen, direction = 'forward') {
    slideAnim.setValue(direction === 'forward' ? SW : -SW);
    setScreen(newScreen);
    Animated.spring(slideAnim, { toValue: 0, tension: 60, friction: 11, useNativeDriver: true }).start();
  }

  function openModal() {
    Animated.parallel([
      Animated.timing(backdropAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.spring(modalAnim, { toValue: 0, tension: 55, friction: 12, useNativeDriver: true }),
    ]).start();
  }

  function closeModal(cb) {
    Animated.parallel([
      Animated.timing(backdropAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.spring(modalAnim, { toValue: 400, tension: 60, friction: 12, useNativeDriver: true }),
    ]).start(cb);
  }

  function switchTab(toOriginal) {
    setShowOriginal(toOriginal);
    Animated.spring(tabAnim, { toValue: toOriginal ? 1 : 0, tension: 80, friction: 10, useNativeDriver: false }).start();
  }

  // ── Progress (step-based) ───────────────────────────────────────────────────

  useEffect(() => {
    if (screen !== 'processing') return;
    const target = STEP_PROGRESS[backendStep] ?? 0;
    Animated.timing(progressAnim, { toValue: target, duration: 700, useNativeDriver: false }).start();
  }, [backendStep, screen]);

  // ── Recording ───────────────────────────────────────────────────────────────

  async function handleRecord() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return;
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: 'videos', videoMaxDuration: 30 });
    if (!res.canceled) { setCapturedUri(res.assets[0].uri); goTo('style'); }
  }

  async function handlePickFromLibrary() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'videos', videoMaxDuration: 30 });
    if (!res.canceled) { setCapturedUri(res.assets[0].uri); goTo('style'); }
  }

  async function handleAddClips() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'videos',
      allowsMultipleSelection: true,
      videoMaxDuration: 60,
    });
    if (!res.canceled) {
      setEditClips(prev => {
        const next = [...prev, ...res.assets.map(a => ({ uri: a.uri }))];
        return next.slice(0, 10);
      });
    }
  }

  // shared polling

  async function pollJob(id, jobMode) {
    pollingRef.current = true;
    while (pollingRef.current) {
      await new Promise(r => setTimeout(r, 3000));
      if (!pollingRef.current) break;
      try {
        const res = await fetch(`${BACKEND_URL}/status/${id}`);
        const job = await res.json();
        setBackendStep(job.step);
        if (job.step === 4) {
          pollingRef.current = false;
          const finalResult = {
            videoUrl: `${BACKEND_URL}${job.result.transformedVideoUrl}`,
            originalUri: jobMode === 'clip' ? capturedUri : null,
          };
          Animated.timing(progressAnim, { toValue: 1.0, duration: 600, useNativeDriver: false }).start(() => {
            closeModal(() => {
              setResult(finalResult);
              setShowOriginal(false);
              tabAnim.setValue(0);
              goTo('result');
            });
          });
          break;
        }
        if (job.step === -1 || job.error) {
          pollingRef.current = false;
          progressAnim.stopAnimation();
          const backScreen = jobMode === 'edit' ? 'editPrompt' : 'style';
          closeModal(() => { setScreen(backScreen); setStyleError(job.error || 'Something went wrong'); });
          break;
        }
      } catch { /* network blip */ }
    }
  }

  // ── Clip Transform ──────────────────────────────────────────────────────────

  async function handleTransform() {
    const activeStyle = customStyle.trim() || style;
    setStyleError(''); setUploadPct(0); setJobId(null); setBackendStep(0);
    progressAnim.setValue(0);
    setScreen('processing'); openModal();

    const formData = new FormData();
    formData.append('video', { uri: capturedUri, name: 'video.mp4', type: 'video/mp4' });
    formData.append('style', activeStyle);

    let id;
    try {
      id = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = 120000;
        xhr.open('POST', `${BACKEND_URL}/upload`);
        xhr.onload = () => {
          const data = JSON.parse(xhr.responseText);
          data.jobId ? resolve(data.jobId) : reject(new Error(data.error || 'Upload failed'));
        };
        xhr.onerror   = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        xhr.upload.onprogress = e => { if (e.lengthComputable) setUploadPct(Math.round(e.loaded / e.total * 100)); };
        xhr.send(formData);
      });
    } catch (err) {
      progressAnim.stopAnimation();
      closeModal(() => { setScreen('style'); setStyleError(err.message); });
      return;
    }

    setJobId(id);
    await pollJob(id, 'clip');
  }

  // ── Edit Maker ──────────────────────────────────────────────────────────────

  async function handleMakeEdit() {
    if (editClips.length === 0) return;
    Keyboard.dismiss();
    setStyleError(''); setUploadPct(0); setJobId(null); setBackendStep(0);
    progressAnim.setValue(0);
    setScreen('processing'); openModal();

    const formData = new FormData();
    editClips.forEach((clip, i) => {
      formData.append('clips', { uri: clip.uri, name: `clip${i}.mp4`, type: 'video/mp4' });
    });
    formData.append('vibe', editVibe.trim());

    let id;
    try {
      id = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = 360000;
        xhr.open('POST', `${BACKEND_URL}/edit`);
        xhr.onload = () => {
          const data = JSON.parse(xhr.responseText);
          data.jobId ? resolve(data.jobId) : reject(new Error(data.error || 'Upload failed'));
        };
        xhr.onerror   = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        xhr.upload.onprogress = e => { if (e.lengthComputable) setUploadPct(Math.round(e.loaded / e.total * 100)); };
        xhr.send(formData);
      });
    } catch (err) {
      progressAnim.stopAnimation();
      closeModal(() => { setScreen('editPrompt'); setStyleError(err.message); });
      return;
    }

    setJobId(id);
    await pollJob(id, 'edit');
  }

  // ── Reset ───────────────────────────────────────────────────────────────────

  function handleReset() {
    pollingRef.current = false;
    progressAnim.stopAnimation();
    backdropAnim.setValue(0); modalAnim.setValue(400); tabAnim.setValue(0); progressAnim.setValue(0);
    setCapturedUri(null); setResult(null); setJobId(null);
    setBackendStep(0); setStyleError(''); setCustomStyle('');
    setStyle('cyberpunk');
    setEditClips([]); setEditVibe(''); setMode('clip');
    goTo('home', 'back');
  }

  // ── Animated screen layer ─────────────────────────────────────────────────────

  const TAB_W = (SW - 32 - 6) / 2;
  const tabIndicatorX = tabAnim.interpolate({ inputRange: [0, 1], outputRange: [3, TAB_W + 3] });
  const STATUS_MSGS = mode === 'edit' ? EDIT_STATUS : CLIP_STATUS;
  const statusMsg = !jobId
    ? STATUS_MSGS[0]
    : STATUS_MSGS[Math.min(backendStep, STATUS_MSGS.length - 1)];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="light" />

      <Animated.View style={{ flex: 1, transform: [{ translateX: slideAnim }] }}>

        {/* ── Home ── */}
        {screen === 'home' && (
          <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
            <View style={s.homePad}>
              <View style={s.homeHeader}>
                <Text style={s.homeWordmark}>MORFIT</Text>
                <Text style={s.homeSub}>What do you want to make?</Text>
              </View>

              <TouchableOpacity
                style={s.modeCard}
                activeOpacity={0.85}
                onPress={() => { setMode('clip'); goTo('clipChoice'); }}
              >
                <Text style={s.modeLabel}>Clip Generator</Text>
                <Text style={s.modeDesc}>Record or upload a video and transform it into a fully AI-generated styled clip.</Text>
                <Text style={s.modeCta}>Get started  →</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[s.modeCard, s.modeCardAccent]}
                activeOpacity={0.85}
                onPress={() => { setMode('edit'); goTo('editUpload'); }}
              >
                <Text style={s.modeLabel}>Edit Maker</Text>
                <Text style={s.modeDesc}>Drop multiple clips and let AI cut them into one fire edit.</Text>
                <Text style={s.modeCta}>Get started  →</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        )}

        {/* ── Clip Choice screen ── */}
        {screen === 'clipChoice' && (
          <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
            <View style={s.choiceWrap}>
              <TouchableOpacity onPress={() => goTo('home', 'back')}>
                <Text style={s.backLink}>Back</Text>
              </TouchableOpacity>
              <Text style={s.choiceTitle}>Clip Generator</Text>
              <Text style={s.choiceSub}>Transform a video into a fully AI-generated styled clip.</Text>
              <View style={s.choiceCenter}>
                <TouchableOpacity style={s.recordCircle} onPress={handleRecord} activeOpacity={0.8}>
                  <Text style={s.recordCircleLabel}>Record</Text>
                </TouchableOpacity>
                <View style={s.choiceOrRow}>
                  <View style={s.choiceOrLine} /><Text style={s.choiceOrText}>or</Text><View style={s.choiceOrLine} />
                </View>
                <TouchableOpacity style={s.uploadChoiceBtn} onPress={handlePickFromLibrary} activeOpacity={0.8}>
                  <Text style={s.uploadChoiceText}>Upload from Library</Text>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        )}

        {/* ── Style screen ── */}
        {(screen === 'style' || (screen === 'processing' && mode === 'clip')) && (
          <SafeAreaView style={s.bg}>
            <ScrollView contentContainerStyle={s.stylePad} keyboardShouldPersistTaps="handled">

              {capturedUri && (
                <VideoView
                  player={previewPlayer}
                  style={s.thumb}
                  contentFit="cover"
                  nativeControls={false}
                />
              )}

              {styleError ? <Text style={s.errorText}>{styleError}</Text> : null}

              <Text style={s.sectionLabel}>Choose a style</Text>
              <View style={s.styleGrid}>
                {STYLES.map(st => {
                  const active = style === st.id && !customStyle;
                  return (
                    <TouchableOpacity
                      key={st.id}
                      style={[s.styleCard, { backgroundColor: st.bg }, active && s.styleCardActive]}
                      onPress={() => { setStyle(st.id); setCustomStyle(''); }}
                      activeOpacity={0.8}
                    >
                      {active && <Text style={s.styleCardCheck}>✓</Text>}
                      <Text style={s.styleCardLabel}>{st.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <TextInput
                style={s.input}
                placeholder="or describe your own style..."
                placeholderTextColor={C.textFaint}
                value={customStyle}
                onChangeText={setCustomStyle}
              />

              <TouchableOpacity style={s.primaryBtn} onPress={handleTransform}>
                <Text style={s.primaryBtnText}>Transform</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => goTo('clipChoice', 'back')}>
                <Text style={s.ghost}>Start over</Text>
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        )}

        {/* ── Edit Upload screen ── */}
        {screen === 'editUpload' && (
          <SafeAreaView style={s.bg}>
            <ScrollView contentContainerStyle={s.stylePad} keyboardShouldPersistTaps="handled">
              <View style={s.rowHeader}>
                <TouchableOpacity onPress={() => goTo('home', 'back')}>
                  <Text style={s.backLink}>Back</Text>
                </TouchableOpacity>
                <Text style={s.sectionLabel}>Edit Maker</Text>
              </View>

              {editClips.length === 0 ? (
                <View style={s.emptyClips}>
                  <Text style={s.emptyClipsTitle}>No clips yet</Text>
                  <Text style={s.ghost}>Tap below to select videos</Text>
                </View>
              ) : (
                <View style={s.clipGrid}>
                  {editClips.map((clip, i) => (
                    <View key={i} style={s.clipItem}>
                      <Image source={{ uri: clip.uri }} style={s.clipThumb} resizeMode="cover" />
                      <TouchableOpacity
                        style={s.clipRemoveBtn}
                        onPress={() => setEditClips(prev => prev.filter((_, j) => j !== i))}
                      >
                        <Text style={s.clipRemoveText}>✕</Text>
                      </TouchableOpacity>
                      <View style={s.clipNumBadge}>
                        <Text style={s.clipNumText}>{i + 1}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}

              <TouchableOpacity
                style={s.outlineBtn}
                onPress={handleAddClips}
                disabled={editClips.length >= 10}
              >
                <Text style={s.outlineBtnText}>
                  {editClips.length === 0 ? 'Add clips' : `Add more  (${editClips.length}/10)`}
                </Text>
              </TouchableOpacity>

              {editClips.length > 0 && (
                <TouchableOpacity style={s.primaryBtn} onPress={() => goTo('editPrompt')}>
                  <Text style={s.primaryBtnText}>Next</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </SafeAreaView>
        )}

        {/* ── Edit Prompt screen ── */}
        {(screen === 'editPrompt' || (screen === 'processing' && mode === 'edit')) && (
          <SafeAreaView style={s.bg}>
            <ScrollView contentContainerStyle={s.stylePad} keyboardShouldPersistTaps="handled">
              <View style={s.rowHeader}>
                <TouchableOpacity onPress={() => goTo('editUpload', 'back')}>
                  <Text style={s.backLink}>Back</Text>
                </TouchableOpacity>
                <Text style={s.sectionLabel}>{editClips.length} clip{editClips.length !== 1 ? 's' : ''} selected</Text>
              </View>

              {styleError ? <Text style={s.errorText}>{styleError}</Text> : null}

              <Text style={s.sectionLabel}>Describe the vibe</Text>
              <TextInput
                style={[s.input, { height: 110, textAlignVertical: 'top', paddingTop: 12 }]}
                placeholder="fast cuts, neon lighting, hip hop energy... or name an artist/song"
                placeholderTextColor={C.textFaint}
                value={editVibe}
                onChangeText={setEditVibe}
                multiline
                onSubmitEditing={Keyboard.dismiss}
              />

              <TouchableOpacity style={s.primaryBtn} onPress={handleMakeEdit}>
                <Text style={s.primaryBtnText}>Make Edit</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={handleReset}>
                <Text style={s.ghost}>Start over</Text>
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        )}

        {/* ── Result screen ── */}
        {screen === 'result' && (
          <SafeAreaView style={s.bg}>
            <ScrollView contentContainerStyle={s.resultPad}>

              {mode === 'clip' && result?.originalUri ? (
                <>
                  <View style={s.tabBar}>
                    <Animated.View style={[s.tabIndicator, { width: TAB_W, transform: [{ translateX: tabIndicatorX }] }]} />
                    <TouchableOpacity style={s.tabBtn} onPress={() => switchTab(false)}>
                      <Text style={[s.tabText, !showOriginal && s.tabTextActive]}>Transformed</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.tabBtn} onPress={() => switchTab(true)}>
                      <Text style={[s.tabText, showOriginal && s.tabTextActive]}>Original</Text>
                    </TouchableOpacity>
                  </View>
                  {showOriginal
                    ? <VideoView player={originalPlayer}    style={s.video} allowsFullscreen allowsPictureInPicture />
                    : <VideoView player={transformedPlayer} style={s.video} allowsFullscreen allowsPictureInPicture />
                  }
                </>
              ) : (
                <VideoView player={transformedPlayer} style={s.video} allowsFullscreen allowsPictureInPicture />
              )}

              <TouchableOpacity style={s.outlineBtn} onPress={handleReset}>
                <Text style={s.outlineBtnText}>Make another</Text>
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        )}

      </Animated.View>

      {/* ── Processing modal overlay ── */}
      {screen === 'processing' && (
        <>
          <Animated.View style={[s.backdrop, { opacity: backdropAnim }]} />
          <Animated.View style={[s.modalSheet, { transform: [{ translateY: modalAnim }] }]}>
            <View style={s.modalHandle} />
            <Text style={s.modalTitle}>{mode === 'edit' ? 'Making your edit' : 'Transforming'}</Text>
            {mode === 'clip' && (
              <Text style={s.modalStyle}>{(customStyle.trim() || style).toUpperCase()}</Text>
            )}
            <Text style={s.progressMsg}>{'> ' + statusMsg}</Text>
            <View style={s.progressTrack}>
              <Animated.View style={[s.progressFill, {
                width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
              }]} />
            </View>
          </Animated.View>
        </>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: C.bg },

  // Clip Choice
  choiceWrap:        { flex: 1, padding: 24, paddingTop: 12 },
  choiceTitle:       { fontSize: 28, fontWeight: '700', color: C.text, marginTop: 16 },
  choiceSub:         { fontSize: 14, color: C.textMid, lineHeight: 22, marginTop: 6 },
  choiceCenter:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 32 },
  recordCircle:      { width: 140, height: 140, borderRadius: 70, backgroundColor: C.record, alignItems: 'center', justifyContent: 'center', shadowColor: C.record, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.5, shadowRadius: 24 },
  recordCircleLabel: { fontSize: 17, fontWeight: '700', color: '#fff', letterSpacing: 0.5 },
  choiceOrRow:       { flexDirection: 'row', alignItems: 'center', gap: 12, width: '65%' },
  choiceOrLine:      { flex: 1, height: 1, backgroundColor: C.border },
  choiceOrText:      { fontSize: 13, color: C.textMid },
  uploadChoiceBtn:   { borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 48, backgroundColor: C.surface },
  uploadChoiceText:  { fontSize: 15, fontWeight: '600', color: C.text },

  // Home
  homePad:      { flex: 1, padding: 24, gap: 16 },
  homeHeader:   { marginBottom: 8 },
  homeWordmark: { fontSize: 12, fontWeight: '700', color: C.text, letterSpacing: 4 },
  homeSub:      { fontSize: 26, fontWeight: '700', color: C.text, marginTop: 10, lineHeight: 32 },
  modeCard:     { flex: 1, borderRadius: 18, backgroundColor: C.surface, padding: 24, gap: 10, borderWidth: 1, borderColor: C.border },
  modeCardAccent: { borderColor: C.accent + '40' },
  modeLabel:    { fontSize: 20, fontWeight: '700', color: C.text },
  modeDesc:     { fontSize: 14, color: C.textMid, lineHeight: 22 },
  modeCta:      { fontSize: 13, color: C.textMid, marginTop: 4 },

  // Style screen
  stylePad:        { padding: 20, gap: 20, paddingBottom: 52 },
  thumb:           { width: SW - 40, height: (SW - 40) * 0.56, borderRadius: 14, backgroundColor: C.surface },
  sectionLabel:    { fontSize: 11, fontWeight: '600', color: C.textMid, letterSpacing: 1.5, textTransform: 'uppercase' },
  errorText:       { fontSize: 13, color: '#ff6b6b', backgroundColor: '#1e0f0f', borderRadius: 10, padding: 12 },
  styleGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  styleCard:       { width: CARD_W, height: 112, borderRadius: 14, justifyContent: 'flex-end', padding: 14, overflow: 'hidden' },
  styleCardActive: { borderWidth: 2, borderColor: '#ffffff' },
  styleCardCheck:  { position: 'absolute', top: 10, right: 12, color: '#fff', fontSize: 14, fontWeight: '700' },
  styleCardLabel:  { fontSize: 14, fontWeight: '600', color: '#fff' },
  input:           { borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 14, fontSize: 14, color: C.text, backgroundColor: C.surface },
  primaryBtn:      { backgroundColor: C.text, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  primaryBtnText:  { color: '#080808', fontWeight: '700', fontSize: 16 },
  ghost:           { fontSize: 14, color: C.textMid, textAlign: 'center' },
  outlineBtn:      { borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingVertical: 15, alignItems: 'center', backgroundColor: C.surface },
  outlineBtnText:  { fontSize: 15, color: C.text },
  backLink:        { fontSize: 14, color: C.textMid, fontWeight: '500' },

  // Edit upload
  rowHeader:      { flexDirection: 'row', alignItems: 'center', gap: 14 },
  emptyClips:     { height: 160, borderRadius: 14, borderWidth: 1, borderColor: C.border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: C.surface },
  emptyClipsTitle:{ fontSize: 16, fontWeight: '600', color: C.textMid },
  clipGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  clipItem:       { width: CLIP_W, height: CLIP_W * 0.75, borderRadius: 10, position: 'relative' },
  clipThumb:      { width: '100%', height: '100%', borderRadius: 10, backgroundColor: C.surface },
  clipRemoveBtn:  { position: 'absolute', top: -8, right: -8, width: 22, height: 22, borderRadius: 11, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  clipRemoveText: { fontSize: 10, color: C.text, fontWeight: '700' },
  clipNumBadge:   { position: 'absolute', bottom: 6, left: 8, backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  clipNumText:    { fontSize: 11, color: C.text, fontWeight: '600' },

  // Processing modal
  backdrop:     { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
  modalSheet:   { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: C.elevated, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 28, paddingTop: 14, paddingBottom: 52, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.4, shadowRadius: 20, elevation: 20 },
  modalHandle:  { width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginBottom: 28 },
  modalTitle:   { fontSize: 22, fontWeight: '700', color: C.text, letterSpacing: -0.3 },
  modalStyle:   { fontSize: 11, color: C.accent, letterSpacing: 2.5, marginTop: 4 },
  progressMsg:  { fontSize: 13, color: C.textMid, marginTop: 24, marginBottom: 14, fontFamily: undefined },
  progressTrack:{ height: 2, backgroundColor: C.border, borderRadius: 1, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: C.accent, borderRadius: 1 },

  // Result
  resultPad:     { padding: 16, gap: 16, paddingBottom: 52 },
  tabBar:        { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 14, padding: 3, position: 'relative', height: 46 },
  tabIndicator:  { position: 'absolute', top: 3, bottom: 3, backgroundColor: C.elevated, borderRadius: 11, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 4 },
  tabBtn:        { flex: 1, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  tabText:       { fontSize: 13, fontWeight: '600', color: C.textMid },
  tabTextActive: { color: C.text },
  video:         { width: '100%', height: 300, borderRadius: 14, backgroundColor: C.surface },
  narrationCard: { backgroundColor: C.surface, borderRadius: 14, padding: 18, borderWidth: 1, borderColor: C.border },
  narrationLabel:{ fontSize: 10, fontWeight: '700', color: C.textMid, marginBottom: 10, letterSpacing: 1.5 },
  narrationBody: { fontSize: 15, lineHeight: 26, color: C.textMid },
});
