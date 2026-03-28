import { useState } from 'react';
import { Text, View, StyleSheet, ScrollView, TouchableOpacity, TextInput } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useVideoPlayer, VideoView } from 'expo-video';
import { StatusBar } from 'expo-status-bar';

const BACKEND_URL = 'https://nippily-goosepimply-lilah.ngrok-free.dev';

const STYLES = ['cyberpunk', 'noir', 'comic', 'warm', 'vhs'];

export default function App() {
  const [status, setStatus] = useState('idle');
  const [narration, setNarration] = useState('');
  const [videoUrl, setVideoUrl] = useState(null);
  const [style, setStyle] = useState('cyberpunk');

  const player = useVideoPlayer(videoUrl, p => {
    p.loop = true;
    if (videoUrl) p.play();
  });

  async function pickAndUpload() {
    setNarration('');
    setVideoUrl(null);

    const { status: mediaStatus } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (mediaStatus !== 'granted') {
      setStatus('error: permissions denied');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'videos',
      videoMaxDuration: 30,
    });

    if (result.canceled) {
      setStatus('idle');
      return;
    }

    await uploadVideo(result.assets[0].uri);
  }

  async function recordAndUpload() {
    setStatus('recording');
    setNarration('');
    setVideoUrl(null);

    const { status: camStatus } = await ImagePicker.requestCameraPermissionsAsync();
    const { status: mediaStatus } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (camStatus !== 'granted' || mediaStatus !== 'granted') {
      setStatus('error: permissions denied');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: 'videos',
      videoMaxDuration: 30,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    });

    if (result.canceled) {
      setStatus('idle');
      return;
    }

    await uploadVideo(result.assets[0].uri);
  }

  async function uploadVideo(uri) {
    setStatus('uploading');

    const formData = new FormData();
    formData.append('video', { uri, name: 'video.mp4', type: 'video/mp4' });
    formData.append('style', style);

    try {
      const json = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = 360000; // 6 min — Veo generation takes 60-120s + upload
        xhr.open('POST', `${BACKEND_URL}/upload`);
        xhr.onload = () => resolve(JSON.parse(xhr.responseText));
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Timed out'));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setStatus(`uploading ${pct}%`);
          }
        };
        xhr.send(formData);
      });

      console.log('Response:', json);

      if (json.success) {
        setNarration(json.narration || '');
        if (json.transformedVideoUrl) {
          setVideoUrl(`${BACKEND_URL}${json.transformedVideoUrl}`);
          setStatus('done');
        } else {
          setStatus('done (no video): ' + (json.error || ''));
        }
      } else {
        setStatus('error: ' + json.error);
      }
    } catch (err) {
      console.error('Upload error:', err);
      setStatus('error: ' + err.message);
    }
  }

  const isLoading = status.startsWith('uploading') || status === 'recording';

  return (
    <ScrollView contentContainerStyle={styles.center}>

      {/* Style picker */}
      <Text style={styles.label}>Choose a style</Text>
      <View style={styles.styleRow}>
        {STYLES.map(s => (
          <TouchableOpacity
            key={s}
            style={[styles.styleChip, style === s && styles.styleChipActive]}
            onPress={() => setStyle(s)}
          >
            <Text style={[styles.styleChipText, style === s && styles.styleChipTextActive]}>
              {s}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <TextInput
        style={styles.input}
        placeholder="or type any style (e.g. horror, dreamlike...)"
        placeholderTextColor="#aaa"
        value={STYLES.includes(style) ? '' : style}
        onChangeText={setStyle}
      />

      <View style={styles.buttonRow}>
        <TouchableOpacity style={[styles.btn, isLoading && styles.btnDisabled]} onPress={recordAndUpload} disabled={isLoading}>
          <Text style={styles.btnText}>Record</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, isLoading && styles.btnDisabled]} onPress={pickAndUpload} disabled={isLoading}>
          <Text style={styles.btnText}>Upload</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.status}>{status}</Text>

      {videoUrl ? (
        <VideoView
          player={player}
          style={styles.video}
          allowsFullscreen
          allowsPictureInPicture
        />
      ) : null}

      {narration ? (
        <View style={styles.narrationBox}>
          <Text style={styles.narrationLabel}>GEMINI NARRATION</Text>
          <Text style={styles.narration}>{narration}</Text>
        </View>
      ) : null}

      <StatusBar style="auto" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  label: { fontSize: 13, fontWeight: '600', color: '#333' },
  styleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  styleChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: '#ccc', backgroundColor: '#f5f5f5' },
  styleChipActive: { backgroundColor: '#1a1a2e', borderColor: '#1a1a2e' },
  styleChipText: { fontSize: 13, color: '#555' },
  styleChipTextActive: { color: '#fff', fontWeight: '600' },
  status: { fontSize: 14, color: '#555' },
  video: { width: '100%', height: 300, borderRadius: 12, backgroundColor: '#000' },
  narrationBox: { backgroundColor: '#f0f4ff', borderRadius: 12, padding: 16, width: '100%' },
  narrationLabel: { fontSize: 11, fontWeight: 'bold', color: '#888', marginBottom: 6, letterSpacing: 1 },
  narration: { fontSize: 15, lineHeight: 24, color: '#222' },
  input: { width: '100%', borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 10, fontSize: 14, color: '#333' },
  buttonRow: { flexDirection: 'row', gap: 12 },
  btn: { flex: 1, backgroundColor: '#1a1a2e', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
