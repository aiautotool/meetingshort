import { useEffect, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { createRealtimeLocalTranscriber, transcribeLocalAudio } from './transcription';
import { localWavPath } from './recording-path';

const STORAGE_KEY = '@meeting_intelligence/meetings';
const PEOPLE = ['KCT', 'Nam', 'Linh', 'Huy'];

const durationLabel = (seconds = 0) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const dateLabel = (iso) => new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const initials = (text) => (text || '?').slice(0, 2).toUpperCase();

export default function App() {
  const [meetings, setMeetings] = useState([]);
  const [tab, setTab] = useState('meetings');
  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [activeMeeting, setActiveMeeting] = useState(null);
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [liveSegments, setLiveSegments] = useState([]);
  const [liveError, setLiveError] = useState('');
  const timerRef = useRef(null);
  const realtimeRef = useRef(null);
  const liveSegmentsRef = useRef([]);
  const soundRef = useRef(null);
  const recordingPathRef = useRef(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => saved && setMeetings(JSON.parse(saved))).catch(() => {});
    return () => {
      clearInterval(timerRef.current);
      realtimeRef.current?.stop?.().catch(() => {});
      soundRef.current?.remove?.();
    };
  }, []);

  function persist(next) {
    setMeetings(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }

  function updateMeeting(id, patch) {
    setMeetings((current) => {
      const next = current.map((item) => item.id === id ? { ...item, ...patch } : item);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
    setActiveMeeting((current) => current?.id === id ? { ...current, ...patch } : current);
  }

  async function transcribeMeeting(meeting) {
    updateMeeting(meeting.id, { transcriptionStatus: 'processing', transcriptionProgress: 0, transcriptionError: null });
    try {
      const result = await transcribeLocalAudio(meeting.uri, (progress) => updateMeeting(meeting.id, { transcriptionProgress: progress }));
      const transcript = result.segments.map((segment, index) => ({
        id: `${meeting.id}-${index}`,
        startMs: segment.t0 * 10,
        endMs: segment.t1 * 10,
        speaker: PEOPLE[index % PEOPLE.length],
        text: segment.text.trim(),
      })).filter((segment) => segment.text);
      updateMeeting(meeting.id, { transcriptionStatus: 'completed', transcriptionProgress: 100, transcript, transcriptText: result.result.trim() });
    } catch (error) {
      updateMeeting(meeting.id, { transcriptionStatus: 'failed', transcriptionError: error instanceof Error ? error.message : 'Không thể hoàn tất transcript.' });
    }
  }

  async function beginRecording() {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return Alert.alert('Cần quyền microphone', 'Hãy cấp quyền microphone để tạo transcript realtime.');
    const id = String(Date.now());
    const rawPath = localWavPath(id);
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: true });
      setLiveSegments([]); liveSegmentsRef.current = []; setLiveError(''); setElapsed(0); setPaused(false);
      const realtime = await createRealtimeLocalTranscriber({
        audioPath: rawPath,
        onTranscript: (event) => {
          const offset = event.sliceIndex * 20000;
          const rows = (event.data.segments?.length ? event.data.segments : [{ text: event.data.result, t0: 0, t1: 0 }])
            .map((segment, index) => ({ id: `live-${event.sliceIndex}-${index}`, startMs: offset + (segment.t0 * 10), speaker: PEOPLE[(event.sliceIndex + index) % PEOPLE.length], text: segment.text.trim(), provisional: true }))
            .filter((segment) => segment.text);
          liveSegmentsRef.current = [...liveSegmentsRef.current.filter((item) => !item.id.startsWith(`live-${event.sliceIndex}-`)), ...rows];
          setLiveSegments([...liveSegmentsRef.current]);
        },
        onError: setLiveError,
      });
      recordingPathRef.current = `file://${rawPath}`;
      realtimeRef.current = realtime;
      await realtime.start();
      setRecording(true); setComposerOpen(false);
      timerRef.current = setInterval(() => setElapsed((value) => value + 1), 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Không thể khởi tạo transcript realtime:', error);
      setLiveError(message);
      Alert.alert('Không thể bắt đầu transcript', message || 'Thiết bị không thể khởi tạo luồng audio PCM.');
    }
  }

  function togglePause() {
    // The PCM stream only has stop/start; keep the UI honest and avoid creating a broken WAV on pause.
    Alert.alert('Ghi âm liên tục', 'Realtime transcript cần luồng âm thanh liên tục. Hãy bấm Dừng để kết thúc cuộc họp.');
  }

  async function stopRecording() {
    if (!recording) return;
    clearInterval(timerRef.current);
    const id = String(Date.now());
    try {
      await realtimeRef.current?.stop();
      const item = {
        id, title: title.trim() || 'Cuộc họp chưa đặt tên', createdAt: new Date().toISOString(), duration: elapsed,
        uri: recordingPathRef.current, transcript: liveSegmentsRef.current, transcriptText: liveSegmentsRef.current.map((item) => item.text).join(' '),
        transcriptionStatus: 'processing', transcriptionProgress: 0,
      };
      persist([item, ...meetings]);
      setRecording(false); setTitle(''); setPaused(false); setElapsed(0); setActiveMeeting(item);
      // Realtime text is already visible during recording. This final local pass only
      // corrects the tail of the sentence and timestamps after the mic is stopped.
      transcribeMeeting(item);
    } catch (error) {
      Alert.alert('Không thể lưu bản ghi', 'Audio cục bộ chưa được hoàn tất. Hãy thử ghi lại.');
    } finally {
      realtimeRef.current = null;
    }
  }

  async function playAudio(meeting) {
    try {
      soundRef.current?.remove?.();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const player = createAudioPlayer({ uri: meeting.uri });
      player.play(); soundRef.current = player;
    } catch { Alert.alert('Không thể phát audio', 'File audio không còn trên thiết bị này.'); }
  }

  function removeMeeting(meeting) {
    Alert.alert('Xoá cuộc họp?', 'Audio và transcript cục bộ sẽ bị xoá.', [{ text: 'Huỷ', style: 'cancel' }, { text: 'Xoá', style: 'destructive', onPress: async () => {
      if (meeting.uri) await FileSystem.deleteAsync(meeting.uri, { idempotent: true }).catch(() => {});
      persist(meetings.filter((item) => item.id !== meeting.id)); setActiveMeeting(null);
    } }]);
  }

  return <SafeAreaView style={styles.safe}>
    <StatusBar barStyle="light-content" />
    <KeyboardAvoidingView style={styles.keyboardAvoider} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
    {recording ? <Recorder title={title.trim() || 'Cuộc họp mới'} elapsed={elapsed} paused={paused} segments={liveSegments} error={liveError} onPause={togglePause} onStop={stopRecording} />
      : activeMeeting ? <MeetingDetails meeting={activeMeeting} onBack={() => setActiveMeeting(null)} onPlay={() => playAudio(activeMeeting)} onDelete={() => removeMeeting(activeMeeting)} />
        : <><Main tab={tab} meetings={meetings} onOpen={setActiveMeeting} onRecord={() => setComposerOpen(true)} /><Nav tab={tab} onChange={setTab} /></>}
    {!recording && !activeMeeting && <Pressable style={styles.fab} onPress={() => setComposerOpen(true)}><Text style={styles.fabText}>＋</Text></Pressable>}
    </KeyboardAvoidingView>
    <Modal visible={composerOpen} transparent animationType="slide" onRequestClose={() => setComposerOpen(false)}><KeyboardAvoidingView style={styles.keyboardAvoider} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><View style={styles.overlay}><View style={styles.sheet}><View style={styles.handle} /><Text style={styles.sheetTitle}>Bắt đầu cuộc họp</Text><Text style={styles.muted}>Transcript realtime chạy hoàn toàn trên iPhone.</Text><TextInput value={title} onChangeText={setTitle} autoFocus placeholder="Tên cuộc họp" placeholderTextColor="#71849B" style={styles.input} /><Pressable style={styles.primary} onPress={beginRecording}><Text style={styles.primaryText}>●  Ghi âm & transcript realtime</Text></Pressable><Pressable style={styles.textButton} onPress={() => setComposerOpen(false)}><Text style={styles.cancelText}>Huỷ</Text></Pressable></View></View></KeyboardAvoidingView></Modal>
  </SafeAreaView>;
}

function Main({ tab, meetings, onOpen, onRecord }) {
  if (tab === 'people') return <People />;
  if (tab === 'projects') return <Projects />;
  if (tab === 'search') return <Search meetings={meetings} onOpen={onOpen} />;
  return <View style={styles.page}><View style={styles.topRow}><Text style={styles.pageTitle}>Cuộc họp</Text><Pressable onPress={onRecord}><Text style={styles.squareIcon}>▣</Text></Pressable></View><View style={styles.searchBox}><Text style={styles.searchGlyph}>⌕</Text><Text style={styles.searchHint}>Tìm kiếm cuộc họp</Text></View><View style={styles.filters}><Text style={styles.filterOn}>Tất cả</Text><Text style={styles.filter}>Hôm nay</Text><Text style={styles.filter}>Tuần này</Text><Text style={styles.filter}>Dự án</Text></View><Text style={styles.dayLabel}>GẦN ĐÂY</Text><MeetingList meetings={meetings} onOpen={onOpen} /></View>;
}

function MeetingList({ meetings, onOpen }) {
  if (!meetings.length) return <View style={styles.empty}><Text style={styles.emptyIcon}>◉</Text><Text style={styles.emptyTitle}>Chưa có cuộc họp</Text><Text style={styles.muted}>Bấm + để ghi âm và nhận transcript ngay khi đang nói.</Text></View>;
  return <FlatList data={meetings} keyExtractor={(item) => item.id} contentContainerStyle={styles.list} renderItem={({ item }) => <Pressable style={styles.meetingRow} onPress={() => onOpen(item)}><View style={styles.meetingInfo}><Text style={styles.meetingTitle}>{item.title}</Text><Text style={styles.meetingMeta}>{dateLabel(item.createdAt)} · {durationLabel(item.duration)}</Text><AvatarGroup /></View><View style={[styles.status, item.transcriptionStatus === 'completed' ? styles.statusDone : styles.statusLive]}><Text style={styles.statusText}>{item.transcriptionStatus === 'completed' ? 'Đã tóm tắt' : item.transcriptionStatus === 'failed' ? 'Cần xử lý lại' : 'Đang xử lý'}</Text></View></Pressable>} />;
}

function Recorder({ title, elapsed, paused, segments, error, onPause, onStop }) {
  const visible = segments.slice(-4);
  return <View style={styles.recordingPage}><View style={styles.recordTop}><Text style={styles.close}>×</Text><Text style={styles.recordTopTitle}>Đang ghi âm</Text><Text>◌</Text></View><Text style={styles.recordName}>{title}</Text><Text style={styles.recordMeta}>● Đang ghi · Realtime on-device</Text><Text style={styles.clock}>{durationLabel(elapsed)}</Text><Text style={styles.wave}>▁▃▆▇▃▁▅▇▆▂▁▅▇▃▁</Text><View style={styles.livePanel}><View style={styles.liveHead}><Text style={styles.liveTitle}>Transcript realtime</Text><Text style={styles.liveBadge}>LIVE</Text></View>{visible.length ? visible.map((segment) => <View key={segment.id} style={styles.liveLine}><Avatar name={segment.speaker} /><Text style={styles.liveText} numberOfLines={2}>{segment.text}</Text></View>) : <Text style={styles.waiting}>Đang lắng nghe… lời nói sẽ xuất hiện tại đây.</Text>}{error ? <Text style={styles.error}>{error}</Text> : null}</View><View style={styles.recordActions}><Pressable style={styles.pauseButton} onPress={onPause}><Text style={styles.pauseText}>{paused ? '▶' : 'Ⅱ'}</Text><Text style={styles.actionLabel}>Tạm dừng</Text></Pressable><Pressable style={styles.stopCircle} onPress={onStop}><Text style={styles.stopSquare}>■</Text></Pressable><View style={styles.pauseButton}><Text style={styles.pauseText}>⌑</Text><Text style={styles.actionLabel}>Đánh dấu</Text></View></View></View>;
}

function MeetingDetails({ meeting, onBack, onPlay, onDelete }) {
  const processing = meeting.transcriptionStatus === 'processing';
  return <FlatList style={styles.page} data={meeting.transcript || []} keyExtractor={(item) => item.id} ListHeaderComponent={<><View style={styles.detailTop}><Pressable onPress={onBack}><Text style={styles.back}>‹</Text></Pressable><Text style={styles.detailTitle}>Chi tiết cuộc họp</Text><Text>•••</Text></View><Text style={styles.detailName}>{meeting.title}</Text><Text style={styles.meetingMeta}>◷ {dateLabel(meeting.createdAt)} · {durationLabel(meeting.duration)}</Text><Text style={styles.meetingMeta}>⌖ HQ - Phòng họp A</Text><View style={styles.tabs}><Text style={styles.tabOn}>Tổng quan</Text><Text style={styles.tabText}>Transcript</Text><Text style={styles.tabText}>AI Note</Text><Text style={styles.tabText}>Task</Text></View><Text style={styles.sectionTitle}>Tóm tắt bởi AI</Text><Text style={styles.summaryText}>{meeting.transcriptText || 'Transcript realtime sẽ hiển thị trong lúc ghi âm.'}</Text><Text style={styles.sectionTitle}>Transcript</Text>{processing && <View style={styles.processing}><Text style={styles.processingTitle}>Đang hoàn tất transcript cục bộ</Text><Text style={styles.muted}>Realtime đã hiển thị ngay khi nói. Whisper đang rà lại phần cuối · {Math.round(meeting.transcriptionProgress || 0)}%</Text></View>}{meeting.transcriptionStatus === 'failed' && <Text style={styles.error}>{meeting.transcriptionError}</Text>}<Pressable style={styles.listenButton} onPress={onPlay}><Text style={styles.listenText}>▶  Phát bản ghi</Text></Pressable></>} ListFooterComponent={<Pressable style={styles.deleteButton} onPress={onDelete}><Text style={styles.deleteText}>Xoá cuộc họp</Text></Pressable>} renderItem={({ item }) => <View style={styles.transcriptRow}><Avatar name={item.speaker || 'KCT'} /><View style={styles.transcriptBody}><View style={styles.transcriptMeta}><Text style={styles.speaker}>{item.speaker || 'KCT'}</Text><Text style={styles.time}>{durationLabel(Math.floor(item.startMs / 1000))}</Text></View><Text style={styles.transcriptText}>{item.text}</Text></View></View>} />;
}

function Search({ meetings, onOpen }) { const [query, setQuery] = useState(''); const found = meetings.filter((item) => `${item.title} ${item.transcriptText || ''}`.toLowerCase().includes(query.toLowerCase())); return <View style={styles.page}><Text style={styles.pageTitle}>Tìm kiếm</Text><TextInput value={query} onChangeText={setQuery} placeholder="Tìm transcript hoặc cuộc họp" style={styles.input} />{query ? <MeetingList meetings={found} onOpen={onOpen} /> : <Text style={[styles.muted, { marginTop: 22 }]}>Tìm cả tên cuộc họp và transcript đã lưu trên máy.</Text>}</View>; }
function Avatar({ name }) { return <View style={styles.avatar}><Text style={styles.avatarText}>{initials(name)}</Text></View>; }
function AvatarGroup() { return <View style={styles.avatars}>{PEOPLE.slice(0, 4).map((name) => <Avatar key={name} name={name} />)}</View>; }
function People() { return <View style={styles.page}><View style={styles.topRow}><Text style={styles.pageTitle}>People</Text><Text style={styles.add}>＋ Thêm</Text></View><Text style={[styles.muted, { marginBottom: 18 }]}>Quản lý giọng nói và thông tin người tham gia.</Text>{PEOPLE.concat('Khách hàng').map((name, index) => <View style={styles.personRow} key={name}><Avatar name={name} /><View style={{ flex: 1 }}><Text style={styles.meetingTitle}>{name}</Text><Text style={styles.meetingMeta}>{index ? 'Voice profile' : 'Admin · 12 cuộc họp'}</Text></View><Text style={styles.voice}>⌁⌁⌁</Text></View>)}</View>; }
function Projects() { const rows = [['Mobile App', '12 cuộc họp', '#5CC8FF'], ['Backend System', '18 cuộc họp', '#9A62E8'], ['Website Redesign', '8 cuộc họp', '#F49A4B'], ['Marketing Campaign', '6 cuộc họp', '#5BCB9B']]; return <View style={styles.page}><Text style={styles.pageTitle}>Dự án</Text><View style={styles.searchBox}><Text style={styles.searchGlyph}>⌕</Text><Text style={styles.searchHint}>Tìm dự án</Text></View>{rows.map(([name, meta, color]) => <View style={styles.projectRow} key={name}><View style={[styles.projectIcon, { backgroundColor: color }]}><Text style={{ color: 'white' }}>▣</Text></View><View style={{ flex: 1 }}><Text style={styles.meetingTitle}>{name}</Text><Text style={styles.meetingMeta}>{meta}</Text></View><Text style={styles.chevron}>›</Text></View>)}<Pressable style={styles.newProject}><Text style={styles.add}>＋ Tạo dự án mới</Text></Pressable></View>; }
function Nav({ tab, onChange }) { return <View style={styles.nav}>{[['meetings', '▣', 'Cuộc họp'], ['search', '⌕', 'Tìm kiếm'], ['people', '♧', 'AI Hỏi đáp'], ['projects', '◫', 'Dự án']].map(([key, icon, text]) => <Pressable key={key} onPress={() => onChange(key)} style={styles.navItem}><Text style={[styles.navIcon, tab === key && styles.navOn]}>{icon}</Text><Text style={[styles.navText, tab === key && styles.navOn]}>{text}</Text></Pressable>)}</View>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' }, page: { flex: 1, paddingHorizontal: 20, paddingTop: 14 }, topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, pageTitle: { color: '#111827', fontSize: 28, fontWeight: '800' }, squareIcon: { color: '#202C4B', fontSize: 22 }, searchBox: { height: 40, borderRadius: 10, backgroundColor: '#F4F6FA', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginTop: 16 }, searchGlyph: { color: '#8A93A5', fontSize: 22 }, searchHint: { color: '#9DA5B5', fontSize: 12, marginLeft: 8 }, filters: { flexDirection: 'row', gap: 8, marginTop: 12 }, filter: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 13, backgroundColor: '#F4F6FA', color: '#5D6575', fontSize: 11 }, filterOn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 13, backgroundColor: '#3576E7', color: 'white', fontSize: 11, fontWeight: '700' }, dayLabel: { color: '#7D8798', fontSize: 10, fontWeight: '800', marginTop: 20, marginBottom: 8 }, list: { paddingBottom: 115 }, meetingRow: { minHeight: 86, borderBottomWidth: 1, borderBottomColor: '#EEF0F4', paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 8 }, meetingInfo: { flex: 1 }, meetingTitle: { color: '#172033', fontSize: 14, fontWeight: '700' }, meetingMeta: { color: '#788397', fontSize: 11, marginTop: 4 }, avatars: { flexDirection: 'row', marginTop: 7 }, avatar: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#F3B28F', borderWidth: 1.5, borderColor: 'white', alignItems: 'center', justifyContent: 'center', marginRight: -4 }, avatarText: { fontSize: 7, color: '#552E1E', fontWeight: '800' }, status: { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 4 }, statusDone: { backgroundColor: '#E1F5E9' }, statusLive: { backgroundColor: '#FFF3DB' }, statusText: { color: '#3E8D68', fontSize: 9, fontWeight: '700' }, empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 25 }, emptyIcon: { fontSize: 44, color: '#3576E7' }, emptyTitle: { fontSize: 17, fontWeight: '800', color: '#172033', marginTop: 10 }, muted: { color: '#798397', fontSize: 13, lineHeight: 19 }, fab: { position: 'absolute', width: 52, height: 52, borderRadius: 26, backgroundColor: '#E94F58', bottom: 28, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', elevation: 5, shadowColor: '#B42035', shadowOpacity: .22, shadowRadius: 10 }, fabText: { color: 'white', fontSize: 28, fontWeight: '300' }, nav: { height: 65, borderTopWidth: 1, borderColor: '#EEF0F4', backgroundColor: 'white', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' }, navItem: { alignItems: 'center', minWidth: 62 }, navIcon: { fontSize: 17, color: '#9AA3B2' }, navText: { fontSize: 9, color: '#9AA3B2', marginTop: 2 }, navOn: { color: '#3576E7', fontWeight: '800' }, overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(20,28,44,.28)' }, sheet: { backgroundColor: 'white', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingBottom: 36 }, handle: { width: 34, height: 4, borderRadius: 2, backgroundColor: '#D7DCE4', alignSelf: 'center', marginBottom: 18 }, sheetTitle: { fontSize: 22, color: '#172033', fontWeight: '800' }, input: { borderWidth: 1, borderColor: '#E2E6EC', borderRadius: 11, padding: 14, marginTop: 16, fontSize: 15 }, primary: { backgroundColor: '#E94F58', borderRadius: 12, padding: 15, alignItems: 'center', marginTop: 12 }, primaryText: { color: 'white', fontWeight: '800' }, textButton: { alignItems: 'center', paddingTop: 17 }, recordingPage: { flex: 1, backgroundColor: '#FFF', padding: 20 }, recordTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, close: { fontSize: 30, color: '#273142', fontWeight: '200' }, recordTopTitle: { fontWeight: '800', color: '#172033' }, recordName: { marginTop: 28, color: '#172033', fontSize: 17, fontWeight: '800' }, recordMeta: { color: '#7A8496', fontSize: 11, marginTop: 7 }, clock: { textAlign: 'center', fontSize: 34, fontWeight: '300', color: '#182234', marginTop: 22 }, wave: { textAlign: 'center', fontSize: 35, letterSpacing: 1, color: '#E94F58', marginTop: 11 }, livePanel: { backgroundColor: '#F8FAFD', borderWidth: 1, borderColor: '#EDF0F5', borderRadius: 14, padding: 13, marginTop: 17, minHeight: 150 }, liveHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }, liveTitle: { color: '#172033', fontWeight: '800' }, liveBadge: { color: '#E94F58', fontSize: 10, fontWeight: '800', backgroundColor: '#FFE8EA', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 }, liveLine: { flexDirection: 'row', gap: 8, paddingVertical: 5 }, liveText: { flex: 1, color: '#394458', fontSize: 12, lineHeight: 17 }, waiting: { color: '#8C96A5', fontSize: 12, marginTop: 26, textAlign: 'center' }, error: { color: '#C52C38', fontSize: 12, marginTop: 7 }, recordActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', marginTop: 'auto', paddingBottom: 18 }, pauseButton: { alignItems: 'center', width: 64 }, pauseText: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: '#E0E5ED', textAlign: 'center', textAlignVertical: 'center', color: '#283447' }, actionLabel: { marginTop: 5, fontSize: 10, color: '#555F70' }, stopCircle: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#E94F58', justifyContent: 'center', alignItems: 'center', shadowColor: '#E94F58', shadowOpacity: .3, shadowRadius: 8 }, stopSquare: { color: 'white', fontSize: 22 }, detailTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, back: { fontSize: 32, lineHeight: 32, color: '#172033' }, detailTitle: { color: '#172033', fontWeight: '800' }, detailName: { color: '#172033', fontSize: 20, fontWeight: '800', marginTop: 22 }, tabs: { flexDirection: 'row', gap: 20, borderBottomWidth: 1, borderColor: '#EDF0F5', marginTop: 19 }, tabOn: { color: '#3576E7', paddingBottom: 10, borderBottomWidth: 2, borderColor: '#3576E7', fontSize: 11, fontWeight: '800' }, tabText: { color: '#606B7E', paddingBottom: 11, fontSize: 11 }, sectionTitle: { color: '#172033', fontSize: 15, fontWeight: '800', marginTop: 18, marginBottom: 9 }, summaryText: { color: '#445064', fontSize: 13, lineHeight: 19 }, processing: { padding: 12, backgroundColor: '#EEF5FF', borderRadius: 10, marginBottom: 7 }, processingTitle: { color: '#2869CE', fontWeight: '800', fontSize: 13, marginBottom: 4 }, listenButton: { borderColor: '#3576E7', borderWidth: 1, borderRadius: 10, padding: 11, alignItems: 'center', marginBottom: 5 }, listenText: { color: '#3576E7', fontWeight: '800' }, transcriptRow: { flexDirection: 'row', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderColor: '#F0F2F5' }, transcriptBody: { flex: 1 }, transcriptMeta: { flexDirection: 'row', gap: 8 }, speaker: { color: '#263348', fontSize: 12, fontWeight: '800' }, time: { color: '#A0A8B5', fontSize: 11 }, transcriptText: { color: '#3A465A', fontSize: 13, lineHeight: 18, marginTop: 3 }, deleteButton: { alignItems: 'center', padding: 22 }, deleteText: { color: '#D73747', fontWeight: '700' }, personRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, borderBottomWidth: 1, borderColor: '#EEF0F4' }, voice: { color: '#6F7EED' }, add: { color: '#3576E7', fontSize: 13, fontWeight: '700' }, projectRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderColor: '#EDF0F5' }, projectIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, chevron: { fontSize: 24, color: '#AAB2C0' }, newProject: { backgroundColor: '#F3F7FF', padding: 14, alignItems: 'center', borderRadius: 11, marginTop: 25 },
});

// Dark AI Meeting visual system, based on the supplied reference: near-black
// navy surfaces, glass cards, electric cyan navigation and magenta recording.
Object.assign(styles, StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#050A13' },
  page: { flex: 1, paddingHorizontal: 20, paddingTop: 14, backgroundColor: '#050A13' },
  pageTitle: { color: '#F3F8FF', fontSize: 28, fontWeight: '800' },
  squareIcon: { color: '#7CEBFF', fontSize: 22 },
  searchBox: { height: 42, borderRadius: 10, backgroundColor: '#0C1625', borderWidth: 1, borderColor: '#14263B', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginTop: 16 },
  searchGlyph: { color: '#7E91A9', fontSize: 22 }, searchHint: { color: '#70829A', fontSize: 12, marginLeft: 8 },
  filter: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 13, backgroundColor: '#0B1523', borderWidth: 1, borderColor: '#16273A', color: '#A5B2C4', fontSize: 11 },
  filterOn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 13, backgroundColor: '#07364D', borderWidth: 1, borderColor: '#00C8F5', color: '#71EDFF', fontSize: 11, fontWeight: '700' },
  dayLabel: { color: '#6C7A90', fontSize: 10, fontWeight: '800', marginTop: 20, marginBottom: 8 },
  meetingRow: { minHeight: 91, borderWidth: 1, borderColor: '#122238', borderRadius: 11, backgroundColor: '#091320', padding: 11, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  meetingTitle: { color: '#EAF4FF', fontSize: 14, fontWeight: '700' }, meetingMeta: { color: '#778AA2', fontSize: 11, marginTop: 4 },
  avatar: { width: 23, height: 23, borderRadius: 12, backgroundColor: '#27445A', borderWidth: 1.5, borderColor: '#0B1827', alignItems: 'center', justifyContent: 'center', marginRight: -4 }, avatarText: { fontSize: 7, color: '#AFF4FF', fontWeight: '800' },
  statusDone: { backgroundColor: '#063D35', borderWidth: 1, borderColor: '#0D695A' }, statusLive: { backgroundColor: '#202051', borderWidth: 1, borderColor: '#414195' }, statusText: { color: '#55E9C5', fontSize: 9, fontWeight: '700' },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: '#EAF4FF', marginTop: 10 }, emptyIcon: { fontSize: 44, color: '#04D7FF' }, muted: { color: '#7B8EA6', fontSize: 13, lineHeight: 19 },
  fab: { position: 'absolute', width: 57, height: 57, borderRadius: 16, transform: [{ rotate: '45deg' }], backgroundColor: '#063B59', borderWidth: 1, borderColor: '#09D9FF', bottom: 27, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', shadowColor: '#00D5FF', shadowOpacity: .55, shadowRadius: 13, elevation: 8 }, fabText: { color: '#84F1FF', fontSize: 28, fontWeight: '300', transform: [{ rotate: '-45deg' }] },
  nav: { height: 65, borderTopWidth: 1, borderColor: '#12243A', backgroundColor: '#07111E', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' }, navIcon: { fontSize: 17, color: '#73859C' }, navText: { fontSize: 9, color: '#73859C', marginTop: 2 }, navOn: { color: '#54E4FF', fontWeight: '800' },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,4,11,.68)' }, sheet: { backgroundColor: '#091421', borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: '#183149', padding: 22, paddingBottom: 36 }, handle: { width: 34, height: 4, borderRadius: 2, backgroundColor: '#2B4A64', alignSelf: 'center', marginBottom: 18 }, sheetTitle: { fontSize: 22, color: '#F2F8FF', fontWeight: '800' }, input: { borderWidth: 1, borderColor: '#1B334B', color: '#EAF4FF', backgroundColor: '#0B1726', borderRadius: 11, padding: 14, marginTop: 16, fontSize: 15 }, primary: { backgroundColor: '#007FAE', borderColor: '#38E5FF', borderWidth: 1, borderRadius: 12, padding: 15, alignItems: 'center', marginTop: 12 }, textButton: { alignItems: 'center', paddingTop: 17 },
  recordingPage: { flex: 1, backgroundColor: '#030811', padding: 20 }, recordTopTitle: { fontWeight: '800', color: '#DFF7FF' }, close: { fontSize: 30, color: '#DFF7FF', fontWeight: '200' }, recordName: { marginTop: 28, color: '#F3FAFF', fontSize: 17, fontWeight: '800' }, recordMeta: { color: '#78A0BB', fontSize: 11, marginTop: 7 }, clock: { textAlign: 'center', fontSize: 34, fontWeight: '300', color: '#F0F7FF', marginTop: 22 }, wave: { textAlign: 'center', fontSize: 35, letterSpacing: 1, color: '#E656FF', marginTop: 11, textShadowColor: '#00E8FF', textShadowRadius: 7 },
  livePanel: { backgroundColor: '#081421', borderWidth: 1, borderColor: '#143653', borderRadius: 14, padding: 13, marginTop: 17, minHeight: 150 }, liveTitle: { color: '#DDF8FF', fontWeight: '800' }, liveBadge: { color: '#FF72E7', fontSize: 10, fontWeight: '800', backgroundColor: '#32142F', borderWidth: 1, borderColor: '#7F2976', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 }, liveText: { flex: 1, color: '#BDCDDF', fontSize: 12, lineHeight: 17 }, waiting: { color: '#6F86A1', fontSize: 12, marginTop: 26, textAlign: 'center' },
  pauseText: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: '#1D3A55', backgroundColor: '#0A1625', textAlign: 'center', textAlignVertical: 'center', color: '#BDEBFF' }, actionLabel: { marginTop: 5, fontSize: 10, color: '#8AA0B8' }, stopCircle: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#E54859', borderWidth: 1, borderColor: '#FF8B9A', justifyContent: 'center', alignItems: 'center', shadowColor: '#FF3651', shadowOpacity: .55, shadowRadius: 11 },
  detailTitle: { color: '#E8F6FF', fontWeight: '800' }, detailName: { color: '#F3FAFF', fontSize: 20, fontWeight: '800', marginTop: 22 }, back: { fontSize: 32, lineHeight: 32, color: '#D9F6FF' }, tabs: { flexDirection: 'row', gap: 20, borderBottomWidth: 1, borderColor: '#163047', marginTop: 19 }, tabOn: { color: '#45E3FF', paddingBottom: 10, borderBottomWidth: 2, borderColor: '#00D6FF', fontSize: 11, fontWeight: '800' }, tabText: { color: '#8496AA', paddingBottom: 11, fontSize: 11 }, sectionTitle: { color: '#E8F6FF', fontSize: 15, fontWeight: '800', marginTop: 18, marginBottom: 9 }, summaryText: { color: '#AFC0D2', fontSize: 13, lineHeight: 19 }, processing: { padding: 12, backgroundColor: '#08243A', borderWidth: 1, borderColor: '#0E577C', borderRadius: 10, marginBottom: 7 }, processingTitle: { color: '#59E4FF', fontWeight: '800', fontSize: 13, marginBottom: 4 },
  listenButton: { borderColor: '#16CAE8', borderWidth: 1, backgroundColor: '#082437', borderRadius: 10, padding: 11, alignItems: 'center', marginBottom: 5 }, listenText: { color: '#6CEBFF', fontWeight: '800' }, transcriptRow: { flexDirection: 'row', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderColor: '#11243A' }, speaker: { color: '#D9F6FF', fontSize: 12, fontWeight: '800' }, time: { color: '#6E849C', fontSize: 11 }, transcriptText: { color: '#B5C8DB', fontSize: 13, lineHeight: 18, marginTop: 3 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, borderBottomWidth: 1, borderColor: '#11243A' }, voice: { color: '#BA75FF', textShadowColor: '#6E2BFF', textShadowRadius: 6 }, add: { color: '#54E4FF', fontSize: 13, fontWeight: '700' }, projectRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, marginTop: 8, backgroundColor: '#091422', borderWidth: 1, borderColor: '#132941', borderRadius: 11 }, chevron: { fontSize: 24, color: '#5D7895' }, newProject: { backgroundColor: '#082A43', borderWidth: 1, borderColor: '#115778', padding: 14, alignItems: 'center', borderRadius: 11, marginTop: 25 }, error: { color: '#FF8091', fontSize: 12, marginTop: 7 }, deleteText: { color: '#FF7184', fontWeight: '700' },
}));

Object.assign(styles, StyleSheet.create({
  keyboardAvoider: { flex: 1 },
  cancelText: { color: '#83EFFF', fontWeight: '700' },
}));
