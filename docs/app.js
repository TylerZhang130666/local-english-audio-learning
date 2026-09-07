const $ = function (id) { return document.getElementById(id); };
const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 25;
const DB_NAME = 'listen-learn-pages';
const DB_VERSION = 1;

let currentFile = null;
let currentKey = '';
let audioUrl = '';
let doc = null;
let dirty = false;
let stopAt = null;
let scrubbing = false;
let lastActive = null;
let transcribing = false;
let cancelRequested = false;
let worker = null;
let modelReady = false;
let selectedDevice = navigator.gpu ? 'webgpu' : 'wasm';
let modelWait = null;
let requestCounter = 0;
const pendingChunks = new Map();

function formatTime(value, srt) {
  const milliseconds = Math.max(0, Math.round((Number(value) || 0) * 1000));
  const seconds = Math.floor(milliseconds / 1000);
  const clock = [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60
  ].map(function (part) { return String(part).padStart(2, '0'); }).join(':');
  return srt ? clock + ',' + String(milliseconds % 1000).padStart(3, '0') : clock;
}

function setStatus(message) {
  $('status').textContent = message;
}

function openDb() {
  return new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function () {
      const database = request.result;
      if (!database.objectStoreNames.contains('docs')) database.createObjectStore('docs');
      if (!database.objectStoreNames.contains('recordings')) database.createObjectStore('recordings');
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

async function dbGet(storeName, key) {
  const database = await openDb();
  try {
    return await new Promise(function (resolve, reject) {
      const transaction = database.transaction(storeName);
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  } finally {
    database.close();
  }
}

async function dbPut(storeName, key, value) {
  const database = await openDb();
  try {
    await new Promise(function (resolve, reject) {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = function () { reject(transaction.error); };
    });
  } finally {
    database.close();
  }
}

function fileKey(file) {
  return [file.name, file.size, file.lastModified || 0].join('::');
}

function newSegment(start, end, text) {
  return {
    id: 0,
    start: Math.max(0, start),
    end: Math.max(start + 0.05, end),
    text: text.trim(),
    original: text.trim(),
    note: '',
    highlight: false,
    favorite: false,
    listening: false,
    speaking: false,
    mastered: false,
    meaning: '',
    my_response: '',
    focus_stress: '',
    focus_weak: '',
    focus_links: '',
    mismatch_words: []
  };
}

function normalizeSegment(segment, index) {
  const defaults = newSegment(segment.start || 0, segment.end || (segment.start || 0) + 1, segment.text || '');
  const result = Object.assign(defaults, segment);
  result.id = index;
  result.mismatch_words = Array.isArray(result.mismatch_words) ? result.mismatch_words : [];
  return result;
}

async function selectFile(file) {
  if (!file) return;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  currentFile = file;
  currentKey = fileKey(file);
  audioUrl = URL.createObjectURL(file);
  $('audio').src = audioUrl;
  $('audio').load();
  $('title').textContent = file.name;
  $('transcribe').disabled = false;
  $('addBookmark').disabled = false;
  $('progress').hidden = true;
  dirty = false;
  stopAt = null;
  doc = await dbGet('docs', currentKey);
  if (doc) {
    doc.segments = (doc.segments || []).map(normalizeSegment);
    setStatus('已从当前浏览器恢复逐字稿。可以继续播放和编辑。');
  } else {
    setStatus('录音已就绪。点击“开始浏览器英文转录”。');
  }
  $('save').disabled = true;
  $('export').disabled = !doc;
  renderBookmarks();
  render();
}

$('audioFile').addEventListener('change', function () {
  selectFile($('audioFile').files[0]).catch(function (error) { setStatus(error.message); });
});

$('loadExample').addEventListener('click', async function () {
  try {
    setStatus('正在加载公开英文示例…');
    const response = await fetch('./assets/example_jfk.wav');
    if (!response.ok) throw new Error('示例加载失败');
    const blob = await response.blob();
    await selectFile(new File([blob], 'example_jfk.wav', { type: 'audio/wav', lastModified: 0 }));
  } catch (error) {
    setStatus(error.message);
  }
});

function ensureWorker() {
  if (worker) return;
  worker = new Worker('./whisper-worker.js?v=20260907-1', { type: 'module' });
  worker.onmessage = function (event) {
    const message = event.data || {};
    if (message.type === 'model-progress') {
      const progress = Number.isFinite(message.progress) ? Math.round(message.progress) : null;
      setStatus('正在准备浏览器语音模型' + (message.file ? ' · ' + message.file : '') + (progress === null ? '…' : ' · ' + progress + '%'));
      $('progress').hidden = false;
      if (progress !== null) $('progress').value = Math.min(12, progress * 0.12);
      return;
    }
    if (message.type === 'ready') {
      modelReady = true;
      if (modelWait) {
        modelWait.resolve();
        modelWait = null;
      }
      return;
    }
    if (message.type === 'chunk-result') {
      const pending = pendingChunks.get(message.requestId);
      if (pending) {
        pendingChunks.delete(message.requestId);
        pending.resolve(message);
      }
      return;
    }
    if (message.type === 'error') {
      const pending = pendingChunks.get(message.requestId);
      if (pending) {
        pendingChunks.delete(message.requestId);
        pending.reject(new Error(message.message));
      } else if (modelWait) {
        modelWait.reject(new Error(message.message));
        modelWait = null;
      }
    }
  };
  worker.onerror = function (event) {
    const error = new Error(event.message || '浏览器语音模型启动失败');
    if (modelWait) {
      modelWait.reject(error);
      modelWait = null;
    }
  };
}

function resetWorker() {
  if (worker) worker.terminate();
  worker = null;
  modelReady = false;
  modelWait = null;
  pendingChunks.clear();
}

function loadModel(device) {
  ensureWorker();
  if (modelReady) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    modelWait = { resolve: resolve, reject: reject };
    worker.postMessage({ type: 'load', device: device });
  });
}

function transcribeChunk(samples) {
  const requestId = ++requestCounter;
  return new Promise(function (resolve, reject) {
    pendingChunks.set(requestId, { resolve: resolve, reject: reject });
    worker.postMessage({ type: 'transcribe', requestId: requestId, audio: samples.buffer }, [samples.buffer]);
  });
}

function resamplePart(audioBuffer, startSeconds, durationSeconds) {
  const sourceRate = audioBuffer.sampleRate;
  const channelCount = audioBuffer.numberOfChannels;
  const startFrame = Math.floor(startSeconds * sourceRate);
  const availableFrames = Math.max(0, Math.min(
    Math.floor(durationSeconds * sourceRate),
    audioBuffer.length - startFrame
  ));
  const outputLength = Math.max(1, Math.floor(availableFrames * SAMPLE_RATE / sourceRate));
  const output = new Float32Array(outputLength);
  const channels = [];
  for (let channel = 0; channel < channelCount; channel++) channels.push(audioBuffer.getChannelData(channel));
  const ratio = sourceRate / SAMPLE_RATE;
  for (let i = 0; i < outputLength; i++) {
    const position = startFrame + i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, audioBuffer.length - 1);
    const fraction = position - left;
    let sample = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      sample += channels[channel][left] * (1 - fraction) + channels[channel][right] * fraction;
    }
    output[i] = sample / channelCount;
  }
  return output;
}

async function runTranscription() {
  if (!currentFile || transcribing) return;
  transcribing = true;
  cancelRequested = false;
  $('transcribe').disabled = true;
  $('cancel').hidden = false;
  $('progress').hidden = false;
  $('progress').value = 0;
  const segments = [];
  let context = null;
  try {
    setStatus('正在准备浏览器语音模型。首次使用需要下载模型…');
    try {
      await loadModel(selectedDevice);
    } catch (error) {
      if (selectedDevice !== 'webgpu') throw error;
      resetWorker();
      selectedDevice = 'wasm';
      $('device').textContent = 'WebGPU 初始化失败，已切换兼容模式';
      setStatus('WebGPU 不可用，正在切换到兼容模式…');
      await loadModel(selectedDevice);
    }
    if (cancelRequested) throw new Error('已中止');

    $('progress').value = 13;
    setStatus('正在浏览器中解码录音。长录音会占用较多内存…');
    const arrayBuffer = await currentFile.arrayBuffer();
    context = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    const duration = audioBuffer.duration;
    const totalParts = Math.ceil(duration / CHUNK_SECONDS);

    for (let part = 0; part < totalParts; part++) {
      if (cancelRequested) throw new Error('已中止');
      const start = part * CHUNK_SECONDS;
      const length = Math.min(CHUNK_SECONDS, duration - start);
      setStatus('正在转录第 ' + (part + 1) + ' / ' + totalParts + ' 段 · ' + formatTime(start) + ' / ' + formatTime(duration));
      const samples = resamplePart(audioBuffer, start, length);
      const result = await transcribeChunk(samples);
      const chunks = result.chunks || [];
      if (chunks.length) {
        chunks.forEach(function (chunk) {
          const text = String(chunk.text || '').trim();
          if (!text) return;
          const stamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [0, length];
          const relativeStart = Number.isFinite(stamp[0]) ? stamp[0] : 0;
          const relativeEnd = Number.isFinite(stamp[1]) ? stamp[1] : Math.min(length, relativeStart + 5);
          segments.push(newSegment(start + relativeStart, Math.min(duration, start + relativeEnd), text));
        });
      } else if (String(result.text || '').trim()) {
        segments.push(newSegment(start, start + length, result.text));
      }
      $('progress').value = 15 + 85 * (part + 1) / totalParts;
    }

    segments.sort(function (a, b) { return a.start - b.start; });
    segments.forEach(function (segment, index) { segment.id = index; });
    doc = {
      name: currentFile.name,
      key: currentKey,
      model: 'onnx-community/whisper-tiny.en',
      created_at: new Date().toISOString(),
      segments: segments
    };
    await saveToBrowser(false);
    $('export').disabled = false;
    setStatus(segments.length ? '转录完成，共 ' + segments.length + ' 句。结果已保存到当前浏览器。' : '转录完成，但没有检测到清晰的英语语音。');
    render();
  } catch (error) {
    setStatus(error.message === '已中止' ? '转录已中止，未覆盖原有逐字稿。' : '转录失败：' + error.message);
  } finally {
    if (context) context.close().catch(function () {});
    transcribing = false;
    $('transcribe').disabled = !currentFile;
    $('cancel').hidden = true;
    $('progress').hidden = true;
  }
}

$('transcribe').addEventListener('click', runTranscription);
$('cancel').addEventListener('click', function () {
  cancelRequested = true;
  $('cancel').disabled = true;
  setStatus('将在当前短片段完成后中止…');
  setTimeout(function () { $('cancel').disabled = false; }, 1200);
});

function changed() {
  dirty = true;
  $('save').disabled = false;
  $('saveStatus').textContent = '有未保存修改 · 点击“保存到浏览器”';
}

async function saveToBrowser(showMessage) {
  if (!doc || !currentKey) return;
  await dbPut('docs', currentKey, doc);
  dirty = false;
  $('save').disabled = true;
  if (showMessage !== false) $('saveStatus').textContent = '已保存到当前浏览器 · ' + new Date().toLocaleTimeString();
}

$('save').addEventListener('click', function () {
  saveToBrowser(true).catch(function (error) { $('saveStatus').textContent = error.message; });
});

const WEAK_WORDS = new Set('a an the and or but as at by for from if in into of on to with is am are was were be been being do does did have has had can could will would shall should may might must i me my we us our you your he him his she her it its they them their this that these those there then than so not'.split(' '));

function wordsOf(text) {
  return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
}

function normalizedWord(word) {
  return String(word || '').toLowerCase().replace(/^[^a-z]+|[^a-z'-]+$/g, '');
}

function focusSuggestions(text) {
  const words = wordsOf(text);
  const unique = [];
  words.forEach(function (word) {
    const clean = normalizedWord(word);
    if (clean && !WEAK_WORDS.has(clean) && !unique.some(function (item) { return item.clean === clean; })) {
      unique.push({ word: word, clean: clean, index: unique.length });
    }
  });
  const count = Math.min(4, Math.max(2, Math.ceil(words.length / 6)));
  const strong = unique.sort(function (a, b) {
    return b.clean.length - a.clean.length || a.index - b.index;
  }).slice(0, count).sort(function (a, b) { return a.index - b.index; }).map(function (item) { return item.word; });
  const weak = words.filter(function (word) { return WEAK_WORDS.has(normalizedWord(word)); }).slice(0, 8);
  const links = [];
  for (let i = 0; i < words.length - 1; i++) {
    const left = normalizedWord(words[i]);
    const right = normalizedWord(words[i + 1]);
    if (/[bcdfghjklmnpqrstvwxyz]$/.test(left) && /^[aeiou]/.test(right)) {
      links.push(words[i] + '‿' + words[i + 1]);
    }
  }
  return {
    strong: strong,
    weak: Array.from(new Set(weak)),
    links: links.slice(0, 4)
  };
}

function createStudyField(label, value, placeholder, oninput, rows) {
  const wrap = document.createElement('label');
  wrap.className = 'study-field';
  wrap.append(document.createTextNode(label));
  const input = rows > 1 ? document.createElement('textarea') : document.createElement('input');
  input.value = value || '';
  input.placeholder = placeholder;
  if (rows > 1) input.rows = rows;
  input.addEventListener('input', function () { oninput(input.value); });
  wrap.append(input);
  return wrap;
}

function statusMatches(segment, filter) {
  if (filter === 'all') return true;
  if (filter === 'pronunciation') return segment.mismatch_words.length > 0;
  return Boolean(segment[filter]);
}

function toggleStatus(segment, key) {
  segment[key] = !segment[key];
  if (key === 'mastered' && segment.mastered) {
    segment.listening = false;
    segment.speaking = false;
    segment.mismatch_words = [];
  } else if (key !== 'mastered' && segment[key]) {
    segment.mastered = false;
  }
  changed();
  render();
}

function buildStudyBody(segment, body) {
  const suggestion = focusSuggestions(segment.text);
  const strong = (segment.focus_stress || suggestion.strong.join(', ')).split(/[,，/]+/).map(normalizedWord).filter(Boolean);
  const focus = document.createElement('section');
  focus.className = 'study-block';
  const heading = document.createElement('h4');
  heading.textContent = '🎧 Listening Focus';
  focus.append(heading);
  const sentence = document.createElement('div');
  sentence.className = 'focus-sentence';
  const pieces = segment.text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|[^A-Za-z]+/g) || [];
  pieces.forEach(function (piece) {
    if (!/[A-Za-z]/.test(piece)) {
      sentence.append(document.createTextNode(piece));
      return;
    }
    const button = document.createElement('button');
    button.textContent = strong.includes(normalizedWord(piece)) ? piece.toUpperCase() : piece;
    button.className = strong.includes(normalizedWord(piece)) ? 'focus-strong' : 'focus-word';
    button.title = '点击查看 IPA 和录音';
    button.addEventListener('click', function () { openWord(piece, segment); });
    sentence.append(button);
  });
  focus.append(sentence);
  focus.append(
    createStudyField('建议重读词', segment.focus_stress || suggestion.strong.join(', '), '每句保留 2–4 个', function (value) { segment.focus_stress = value; changed(); }),
    createStudyField('建议弱读词', segment.focus_weak || suggestion.weak.join(', '), '如 we have to', function (value) { segment.focus_weak = value; changed(); }),
    createStudyField('可能连读', segment.focus_links || suggestion.links.join(', '), '如 check‿if', function (value) { segment.focus_links = value; changed(); })
  );

  const pronunciation = document.createElement('section');
  pronunciation.className = 'study-block';
  const pronunciationHeading = document.createElement('h4');
  pronunciationHeading.textContent = '🔊 Pronunciation Focus';
  const pronunciationHelp = document.createElement('p');
  pronunciationHelp.textContent = '点击上方任意单词查看 IPA、重音、标准发音和你的录音。';
  const mismatch = document.createElement('p');
  mismatch.className = 'mismatch-list';
  mismatch.textContent = segment.mismatch_words.length ? '⚠ 已标记：' + segment.mismatch_words.join(', ') : '尚未标记 Pronunciation mismatch';
  pronunciation.append(pronunciationHeading, pronunciationHelp, mismatch);

  const output = document.createElement('section');
  output.className = 'study-block output-block';
  const outputHeading = document.createElement('h4');
  outputHeading.textContent = '🧠 Meaning & 🗣 My Response';
  output.append(outputHeading);
  output.append(
    createStudyField('中文含义', segment.meaning, '这句话在当前会议中的意思', function (value) { segment.meaning = value; changed(); }, 2),
    createStudyField('My Response', segment.my_response, '如果对方对我说这句话，我会怎样回答？', function (value) { segment.my_response = value; changed(); }, 3)
  );
  body.append(focus, pronunciation, output);
}

function render() {
  const container = $('segments');
  container.replaceChildren();
  $('count').textContent = doc ? doc.segments.length + ' 句' : '';
  if (!doc) {
    $('filterSummary').textContent = '👂 0 · 🔊 0 · 🗣 0 · ✅ 0';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '选择录音后开始浏览器转录。';
    container.append(empty);
    return;
  }
  doc.segments = doc.segments.map(normalizeSegment);
  $('filterSummary').textContent =
    '👂 ' + doc.segments.filter(function (item) { return item.listening; }).length +
    ' · 🔊 ' + doc.segments.filter(function (item) { return item.mismatch_words.length; }).length +
    ' · 🗣 ' + doc.segments.filter(function (item) { return item.speaking; }).length +
    ' · ✅ ' + doc.segments.filter(function (item) { return item.mastered; }).length;

  const query = $('search').value.toLowerCase();
  const filter = $('filter').value;
  let shown = 0;
  doc.segments.forEach(function (segment) {
    if (!statusMatches(segment, filter)) return;
    const haystack = [segment.text, segment.note, segment.meaning, segment.my_response, segment.mismatch_words.join(' ')].join(' ').toLowerCase();
    if (query && !haystack.includes(query)) return;
    shown++;
    const card = document.createElement('section');
    card.id = 'segment-' + segment.id;
    card.dataset.id = segment.id;
    card.className = 'sentence' +
      (segment.highlight ? ' highlight' : '') +
      (segment.listening ? ' listening' : '') +
      (segment.mismatch_words.length ? ' pronunciation-issue' : '') +
      (segment.mastered ? ' mastered' : '');

    const head = document.createElement('div');
    head.className = 'sentence-head';
    const jump = document.createElement('button');
    jump.className = 'timestamp';
    jump.textContent = '▶ ' + formatTime(segment.start);
    jump.addEventListener('click', function () {
      stopAt = null;
      $('audio').currentTime = segment.start;
      $('audio').play().catch(function (error) { setStatus(error.message); });
    });
    head.append(jump);
    const tags = document.createElement('div');
    tags.className = 'tags';
    [
      ['listening', '👂 听不懂'],
      ['speaking', '🗣 不会说'],
      ['mastered', '✅ 已掌握'],
      ['favorite', '⭐ 收藏'],
      ['highlight', '🟨 待学习']
    ].forEach(function (definition) {
      const button = document.createElement('button');
      const key = definition[0];
      button.textContent = definition[1];
      button.setAttribute('aria-pressed', segment[key]);
      button.addEventListener('click', function () { toggleStatus(segment, key); });
      tags.append(button);
    });
    const solo = document.createElement('button');
    solo.className = 'solo';
    solo.textContent = '🎧 只听本句';
    solo.addEventListener('click', function () {
      stopAt = segment.end;
      $('audio').currentTime = segment.start;
      $('audio').play().catch(function (error) { setStatus(error.message); });
    });
    tags.append(solo);
    head.append(tags);
    card.append(head);

    const label = document.createElement('label');
    label.className = 'edit-label';
    label.textContent = '✎ 英文文本 · 点击修改';
    label.htmlFor = 'transcript-' + segment.id;
    const textarea = document.createElement('textarea');
    textarea.id = 'transcript-' + segment.id;
    textarea.className = 'text';
    textarea.rows = Math.max(2, Math.ceil(segment.text.length / 75));
    textarea.value = segment.text;
    textarea.addEventListener('input', function () { segment.text = textarea.value; changed(); });
    card.append(label, textarea);

    const suggestion = focusSuggestions(segment.text);
    const preview = document.createElement('p');
    preview.className = 'focus-preview';
    preview.textContent = '建议重读：' + (segment.focus_stress || suggestion.strong.join(' / ') || '—') +
      (segment.mismatch_words.length ? '　⚠ 发音：' + segment.mismatch_words.join(', ') : '');
    card.append(preview);

    const details = document.createElement('details');
    details.className = 'study-details';
    const summary = document.createElement('summary');
    summary.textContent = '展开：发音 + 听力重点 / Meaning / My Response';
    const body = document.createElement('div');
    body.className = 'study-body';
    details.append(summary, body);
    details.addEventListener('toggle', function () {
      if (details.open && !body.childElementCount) buildStudyBody(segment, body);
    });
    card.append(details);
    const notes = createStudyField('学习笔记', segment.note, '含义、使用场景或我想模仿的表达', function (value) { segment.note = value; changed(); }, 2);
    notes.classList.add('compact-note');
    card.append(notes);
    container.append(card);
  });
  if (!shown) container.textContent = '没有符合当前筛选条件的句子。';
}

$('search').addEventListener('input', render);
$('filter').addEventListener('change', render);

function syncSeek() {
  const audio = $('audio');
  if (!scrubbing && Number.isFinite(audio.currentTime)) $('seek').value = audio.currentTime;
  $('elapsed').textContent = formatTime(audio.currentTime);
  $('duration').textContent = formatTime(audio.duration);
}

$('audio').addEventListener('loadedmetadata', function () {
  $('seek').max = Number.isFinite($('audio').duration) ? $('audio').duration : 0;
  $('seek').disabled = !$('audio').duration;
  syncSeek();
});
$('audio').addEventListener('timeupdate', function () {
  syncSeek();
  if (stopAt !== null && $('audio').currentTime >= stopAt - 0.05) {
    $('audio').pause();
    stopAt = null;
  }
  followTranscript();
});
$('seek').addEventListener('input', function () {
  scrubbing = true;
  $('elapsed').textContent = formatTime($('seek').value);
  followTranscript(Number($('seek').value));
});
$('seek').addEventListener('change', function () {
  $('audio').currentTime = Number($('seek').value);
  scrubbing = false;
  followTranscript();
});

function followTranscript(at) {
  if (!doc) return;
  const position = Number.isFinite(at) ? at : $('audio').currentTime;
  let active = null;
  for (let i = 0; i < doc.segments.length; i++) {
    if (position >= doc.segments[i].start && position < doc.segments[i].end) {
      active = doc.segments[i];
      break;
    }
  }
  if (!active) return;
  document.querySelectorAll('.sentence.active').forEach(function (element) { element.classList.remove('active'); });
  const row = $('segment-' + active.id);
  if (row) {
    row.classList.add('active');
    if (!$('audio').paused && lastActive !== active.id && !document.activeElement.matches('textarea,input')) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  lastActive = active.id;
}

$('back').addEventListener('click', function () { $('audio').currentTime = Math.max(0, $('audio').currentTime - 5); });
$('forward').addEventListener('click', function () {
  if (Number.isFinite($('audio').duration)) $('audio').currentTime = Math.min($('audio').duration, $('audio').currentTime + 5);
});
$('speed').addEventListener('change', function () { $('audio').playbackRate = Number($('speed').value); });

let boostContext = null;
let boostSource = null;
let boostGain = null;
let boostLimiter = null;
async function applyBoost() {
  const amount = Number($('boost').value);
  $('boostValue').textContent = amount + '×';
  try {
    if (!boostContext && amount > 1) {
      const Context = window.AudioContext || window.webkitAudioContext;
      boostContext = new Context();
      boostSource = boostContext.createMediaElementSource($('audio'));
      boostGain = boostContext.createGain();
      boostLimiter = boostContext.createDynamicsCompressor();
      boostLimiter.threshold.value = -3;
      boostLimiter.ratio.value = 20;
      boostSource.connect(boostGain);
      boostGain.connect(boostLimiter);
      boostLimiter.connect(boostContext.destination);
    }
    if (boostContext) {
      boostGain.gain.setTargetAtTime(amount, boostContext.currentTime, 0.03);
      if (boostContext.state === 'suspended') await boostContext.resume();
    }
    $('boostStatus').textContent = amount > 1 ? '已增强至 ' + amount + '×；若出现失真，请降低倍数。' : '原始音量。';
  } catch (error) {
    $('boostStatus').textContent = '音量增强未启用：' + error.message;
  }
}
$('boost').addEventListener('input', applyBoost);

function bookmarkStorageKey() {
  return 'listen-learn-bookmarks::' + currentKey;
}
function getBookmarks() {
  try { return JSON.parse(localStorage.getItem(bookmarkStorageKey()) || '[]'); } catch (error) { return []; }
}
function storeBookmarks(items) {
  localStorage.setItem(bookmarkStorageKey(), JSON.stringify(items));
}
function renderBookmarks() {
  const container = $('bookmarkList');
  container.replaceChildren();
  if (!currentKey) return;
  const items = getBookmarks();
  items.forEach(function (item, index) {
    const row = document.createElement('div');
    row.className = 'bookmark';
    const jump = document.createElement('button');
    jump.textContent = '▶ ' + formatTime(item.time);
    jump.addEventListener('click', function () { $('audio').currentTime = item.time; $('audio').play(); });
    const note = document.createElement('input');
    note.placeholder = '标记备注';
    note.value = item.note || '';
    note.addEventListener('change', function () { items[index].note = note.value; storeBookmarks(items); });
    const remove = document.createElement('button');
    remove.textContent = '移除';
    remove.addEventListener('click', function () { items.splice(index, 1); storeBookmarks(items); renderBookmarks(); });
    row.append(jump, remove, note);
    container.append(row);
  });
}
$('addBookmark').addEventListener('click', function () {
  if (!currentKey) return;
  const items = getBookmarks();
  items.push({ time: $('audio').currentTime || 0, note: '' });
  items.sort(function (a, b) { return a.time - b.time; });
  storeBookmarks(items);
  renderBookmarks();
});

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type: type || 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

$('export').addEventListener('click', function () {
  if (!doc) return;
  const format = $('format').value;
  const base = doc.name.replace(/\.[^.]+$/, '');
  if (format === 'json') {
    downloadFile(base + '.listen-learn.json', JSON.stringify(doc, null, 2), 'application/json;charset=utf-8');
    return;
  }
  let content = '';
  if (format === 'srt') {
    content = doc.segments.map(function (segment, index) {
      return (index + 1) + '\n' + formatTime(segment.start, true) + ' --> ' + formatTime(segment.end, true) + '\n' + segment.text + '\n';
    }).join('\n');
  } else {
    content = (format === 'md' ? '# ' : '') + doc.name + '\n\n' + doc.segments.map(function (segment) {
      const flags =
        (segment.listening ? '[听不懂] ' : '') +
        (segment.speaking ? '[不会说] ' : '') +
        (segment.mastered ? '[已掌握] ' : '') +
        (segment.mismatch_words.length ? '[发音:' + segment.mismatch_words.join(', ') + '] ' : '');
      return (format === 'md' ? '## ' : '') + '[' + formatTime(segment.start) + '] ' + flags + '\n' + segment.text +
        (segment.meaning ? '\n\n含义：' + segment.meaning : '') +
        (segment.my_response ? '\n\nMy Response：' + segment.my_response : '') +
        (segment.note ? '\n\n笔记：' + segment.note : '');
    }).join('\n\n');
  }
  downloadFile(base + '.' + format, '\ufeff' + content);
});

const IPA_PHONES = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ',
  EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', IH: 'ɪ', IY: 'iː', OW: 'oʊ',
  OY: 'ɔɪ', UH: 'ʊ', UW: 'uː', B: 'b', CH: 'tʃ', D: 'd',
  DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ', K: 'k',
  L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p', R: 'r', S: 's',
  SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ'
};
const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
const VALID_ONSETS = new Set([
  'B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'SH', 'T', 'TH', 'V', 'W', 'Y', 'Z', 'ZH',
  'B L', 'B R', 'D R', 'F L', 'F R', 'G L', 'G R', 'K L', 'K R', 'P L', 'P R', 'T R', 'V R', 'TH R', 'SH R',
  'S L', 'S M', 'S N', 'S P', 'S T', 'S K', 'S W', 'CH R', 'JH R', 'K W', 'G W',
  'F Y', 'V Y', 'K Y', 'P Y', 'T Y', 'B Y', 'D Y', 'G Y', 'HH Y', 'M Y', 'N Y', 'R Y', 'S Y', 'Z Y', 'TH Y'
]);
const IPA_HELP = {
  'iː': ['长音 /iː/', '嘴角略向两侧展开，舌位高而靠前，并保持声音长度。', 'see, field'],
  'ɪ': ['短音 /ɪ/', '舌位比 /iː/ 稍低并更放松，发音要短。', 'sit, little'],
  'ɛ': ['/ɛ/', '嘴自然张开，舌位在前部中间。', 'check, bed'],
  'æ': ['/æ/', '下颌打开，舌前部压低，不要读成“爱”。', 'sample, map'],
  'ɑ': ['/ɑ/', '嘴张开，舌位低而靠后。', 'hot, model'],
  'ɔ': ['/ɔ/', '双唇略圆，舌位靠后。', 'thought, all'],
  'ʌ': ['/ʌ/', '短促放松，舌位居中偏后。', 'but, study'],
  'ə': ['弱读 /ə/', '最放松的中央元音，短而轻，常出现在非重读音节。', 'about, feasible'],
  'ɚ': ['卷舌弱音 /ɚ/', '先发放松的 /ə/，同时轻微卷舌。', 'teacher, better'],
  'ɝ': ['重读卷舌音 /ɝ/', '保持中央元音并卷舌，声音比 /ɚ/ 更清楚。', 'word, learn'],
  'ʊ': ['/ʊ/', '双唇略圆，短促放松。', 'good, could'],
  'uː': ['长音 /uː/', '双唇收圆，舌位高而靠后，保持长度。', 'food, group'],
  'eɪ': ['双元音 /eɪ/', '从 /e/ 平滑滑向 /ɪ/。', 'day, data'],
  'oʊ': ['双元音 /oʊ/', '从中后元音滑向 /ʊ/，双唇逐渐收圆。', 'go, soil'],
  'aɪ': ['双元音 /aɪ/', '从开口元音平滑滑向 /ɪ/。', 'time, right'],
  'aʊ': ['双元音 /aʊ/', '从开口元音滑向圆唇的 /ʊ/。', 'how, out'],
  'ɔɪ': ['双元音 /ɔɪ/', '从圆唇的 /ɔ/ 滑向 /ɪ/。', 'soil, point'],
  'θ': ['清辅音 /θ/', '舌尖轻放在上下齿之间，让气流通过，不振动声带。', 'think, method'],
  'ð': ['浊辅音 /ð/', '位置与 /θ/ 相同，同时振动声带。', 'this, that'],
  'ʃ': ['/ʃ/', '双唇略圆，舌前部靠近齿龈后方，让气流摩擦。', 'should, pressure'],
  'ʒ': ['/ʒ/', '位置接近 /ʃ/，同时振动声带。', 'measure, vision'],
  'tʃ': ['/tʃ/', '先短暂阻断气流，再释放为 /ʃ/。', 'check, feature'],
  'dʒ': ['/dʒ/', '浊音，先阻断再释放为 /ʒ/。', 'job, adjust'],
  'ŋ': ['/ŋ/', '舌后部贴近软腭，气流从鼻腔通过，结尾不要再加 /g/。', 'thing, sampling'],
  'r': ['美式 /r/', '舌尖抬起但不碰上颚，双唇略收。', 'right, around'],
  'l': ['/l/', '舌尖碰上齿龈；词尾时舌后部也会抬起。', 'look, field']
};

let pronunciationDictionary = null;
let pronunciationPromise = null;
let wordContext = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingUrl = '';

function phoneBase(phone) {
  return phone.replace(/[012]$/, '');
}

function arpabetToIpa(phones) {
  const vowelPositions = [];
  phones.forEach(function (phone, index) {
    if (VOWELS.has(phoneBase(phone))) vowelPositions.push(index);
  });
  if (!vowelPositions.length) return { ipa: '', stresses: [] };
  const syllables = [];
  vowelPositions.forEach(function (vowelAt, number) {
    let onsetAt = 0;
    if (number > 0) {
      const previousVowel = vowelPositions[number - 1];
      const between = phones.slice(previousVowel + 1, vowelAt).map(phoneBase);
      let onsetLength = 0;
      for (let length = between.length; length > 0; length--) {
        if (VALID_ONSETS.has(between.slice(-length).join(' '))) {
          onsetLength = length;
          break;
        }
      }
      const codaLength = between.length - onsetLength;
      syllables[syllables.length - 1].push.apply(
        syllables[syllables.length - 1],
        phones.slice(previousVowel + 1, previousVowel + 1 + codaLength)
      );
      onsetAt = vowelAt - onsetLength;
    }
    syllables.push(phones.slice(onsetAt, vowelAt + 1));
  });
  syllables[syllables.length - 1].push.apply(
    syllables[syllables.length - 1],
    phones.slice(vowelPositions[vowelPositions.length - 1] + 1)
  );
  const stresses = [];
  const rendered = syllables.map(function (syllable) {
    let stress = 0;
    syllable.forEach(function (phone) {
      const match = phone.match(/[012]$/);
      if (match) stress = Number(match[0]);
    });
    stresses.push(stress);
    let text = '';
    syllable.forEach(function (phone) {
      const base = phoneBase(phone);
      if (base === 'AH' && /0$/.test(phone)) text += 'ə';
      else if (base === 'ER' && /0$/.test(phone)) text += 'ɚ';
      else text += IPA_PHONES[base] || '';
    });
    return (stress === 1 ? 'ˈ' : stress === 2 ? 'ˌ' : '') + text;
  });
  return { ipa: '/' + rendered.join('.') + '/', stresses: stresses };
}

async function loadPronunciationDictionary() {
  if (pronunciationDictionary) return pronunciationDictionary;
  if (pronunciationPromise) return pronunciationPromise;
  pronunciationPromise = (async function () {
    $('wordIpa').textContent = '首次查询正在载入离线词典…';
    const response = await fetch('./assets/cmudict.dict');
    if (!response.ok) throw new Error('发音词典加载失败');
    const text = await response.text();
    const dictionary = new Map();
    text.split(/\r?\n/).forEach(function (line) {
      if (!line || line.startsWith(';;;')) return;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) return;
      const word = parts.shift().replace(/\(\d+\)$/, '').toLowerCase();
      if (!dictionary.has(word)) dictionary.set(word, parts);
    });
    pronunciationDictionary = dictionary;
    return dictionary;
  })();
  return pronunciationPromise;
}

async function pronunciationFor(word) {
  const dictionary = await loadPronunciationDictionary();
  const clean = normalizedWord(word);
  const phones = dictionary.get(clean);
  if (!phones) return { found: false, word: clean };
  const converted = arpabetToIpa(phones);
  const primaryIndex = converted.stresses.indexOf(1);
  return {
    found: true,
    word: clean,
    ipa: converted.ipa,
    syllables: converted.stresses.length,
    primary_stress: primaryIndex >= 0 ? primaryIndex + 1 : null,
    phones: phones.map(function (phone) {
      const base = phoneBase(phone);
      return {
        arpabet: base,
        ipa: base === 'AH' && /0$/.test(phone) ? 'ə' : base === 'ER' && /0$/.test(phone) ? 'ɚ' : IPA_PHONES[base] || ''
      };
    })
  };
}

function showIpaHelp(symbol) {
  const help = IPA_HELP[symbol] || ['音标 /' + symbol + '/', '先听系统示范，再录下自己的发音进行对比。', ''];
  $('ipaHelp').replaceChildren();
  const title = document.createElement('strong');
  title.textContent = help[0];
  const explanation = document.createElement('p');
  explanation.textContent = help[1];
  const example = document.createElement('small');
  example.textContent = help[2] ? '例词：' + help[2] : '';
  $('ipaHelp').append(title, explanation, example);
}

function updateMismatchButton() {
  if (!wordContext) return;
  const marked = wordContext.segment.mismatch_words.includes(wordContext.word);
  $('mismatchWord').textContent = marked ? '✓ 已标记 Pronunciation mismatch' : '⚠ 标记 Pronunciation mismatch';
  $('mismatchWord').setAttribute('aria-pressed', marked);
}

async function openWord(word, segment) {
  wordContext = { recordingId: currentKey, segment: segment, word: normalizedWord(word) };
  $('wordTitle').textContent = wordContext.word;
  $('wordIpa').textContent = '正在查找离线词典…';
  $('wordMeta').textContent = '';
  $('ipaSymbols').replaceChildren();
  $('ipaHelp').textContent = '点击音标查看发音提示。';
  $('wordDialog').showModal();
  try {
    const result = await pronunciationFor(wordContext.word);
    if (!result.found) {
      $('wordIpa').textContent = '离线词典未收录';
      $('wordMeta').textContent = '专业缩写、专名或转写错误可能无法查询，请先核对拼写。';
    } else {
      $('wordIpa').textContent = result.ipa;
      $('wordMeta').textContent = result.syllables + ' 个音节 · 主重音：' +
        (result.primary_stress ? '第 ' + result.primary_stress + ' 音节' : '未标注') + ' · 美式词典';
      result.phones.forEach(function (phone) {
        if (!phone.ipa) return;
        const button = document.createElement('button');
        button.textContent = '/' + phone.ipa + '/';
        button.addEventListener('click', function () { showIpaHelp(phone.ipa); });
        $('ipaSymbols').append(button);
      });
    }
  } catch (error) {
    $('wordIpa').textContent = '查询失败';
    $('wordMeta').textContent = error.message;
  }
  updateMismatchButton();
  await loadWordRecording();
}

$('mismatchWord').addEventListener('click', function () {
  if (!wordContext) return;
  const list = wordContext.segment.mismatch_words;
  const index = list.indexOf(wordContext.word);
  if (index >= 0) list.splice(index, 1);
  else {
    list.push(wordContext.word);
    wordContext.segment.mastered = false;
  }
  changed();
  updateMismatchButton();
});

$('speakWord').addEventListener('click', function () {
  if (!wordContext || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(wordContext.word);
  utterance.lang = 'en-US';
  const voice = speechSynthesis.getVoices().find(function (item) { return item.lang.toLowerCase() === 'en-us'; });
  if (voice) utterance.voice = voice;
  speechSynthesis.speak(utterance);
});

function wordRecordingKey() {
  return wordContext.recordingId + ':' + wordContext.segment.id + ':' + wordContext.word;
}

async function loadWordRecording() {
  try {
    const blob = await dbGet('recordings', wordRecordingKey());
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    recordingUrl = blob ? URL.createObjectURL(blob) : '';
    $('playRecording').disabled = !blob;
    $('recordStatus').textContent = blob ? '已载入你的浏览器本地录音，可以回听比较。' : '录音只保存在当前浏览器，不上传。';
  } catch (error) {
    $('recordStatus').textContent = '无法读取录音：' + error.message;
  }
}

$('recordWord').addEventListener('click', async function () {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = function (event) {
      if (event.data.size) recordedChunks.push(event.data);
    };
    mediaRecorder.onstop = async function () {
      stream.getTracks().forEach(function (track) { track.stop(); });
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      await dbPut('recordings', wordRecordingKey(), blob);
      $('recordWord').textContent = '🎤 重新录音';
      await loadWordRecording();
    };
    mediaRecorder.start();
    $('recordWord').textContent = '⏹ 停止并保存';
    $('recordStatus').textContent = '正在录音…读完后点击停止。';
  } catch (error) {
    $('recordStatus').textContent = '无法录音：请允许浏览器使用麦克风。';
  }
});

$('playRecording').addEventListener('click', function () {
  if (recordingUrl) new Audio(recordingUrl).play();
});

$('wordDialog').addEventListener('close', function () {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  render();
});

window.addEventListener('beforeunload', function (event) {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

$('device').textContent = selectedDevice === 'webgpu' ? '已检测到 WebGPU，将使用显卡加速' : '兼容模式：使用浏览器 WASM';
render();
