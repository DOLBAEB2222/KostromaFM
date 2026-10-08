/**
 * Радио Кострома ФМ — player logic v2 (CORS-safe)
 *
 * Проблема v1: crossOrigin='anonymous' заставлял браузер делать CORS-запрос,
 * сервер не отдаёт Access-Control-Allow-Origin → 403 → звук не шёл.
 *
 * Решение v2:
 *   1) Пробуем CORS один раз. Если сервер отдаёт ACAO — включаем реальный
 *      спектр-визуализатор через Web Audio API.
 *   2) Если CORS нет — играем БЕЗ crossOrigin (обычный <audio> из любого
 *      origin играется всегда) и рисуем декоративный визуализатор, который
 *      не читает аудио-данные, но живёт и пульсирует.
 *   3) Опционально: укажи CORS_PROXY — поток пойдёт через прокси, и реальный
 *      визуализатор заработает даже там, где прямого CORS нет.
 */

const STREAM_URL = 'https://s0.radioheart.ru:8000/RH85296';

/* Если хочешь настоящий спектр при отсутствии CORS — раскомментируй и впиши
 * свой прокси. Формат: префикс, к которому клеится encodeURIComponent(url).
 * Примеры: 'https://corsproxy.io/?url='  |  'https://api.allorigins.win/raw?url='
 * ВНИМАНИЕ: публичные прокси нестабильны и видят твой трафик. Свой — надёжнее.
 */
const CORS_PROXY = '';

const els = {
  body: document.body,
  playBtn: document.getElementById('playBtn'),
  muteBtn: document.getElementById('muteBtn'),
  volBtn: document.getElementById('volBtn'),
  volume: document.getElementById('volume'),
  track: document.getElementById('trackTitle'),
  artist: document.getElementById('trackArtist'),
  status: document.getElementById('statusText'),
  bitrate: document.getElementById('bitrate'),
  clock: document.getElementById('clock'),
  buffer: document.getElementById('bufferState'),
  listeners: document.getElementById('listenersChip'),
  vizMode: document.getElementById('vizMode'),
  streamLabel: document.getElementById('streamLabel'),
  viz: document.getElementById('viz'),
};

const META_ENDPOINTS = [
  'https://api.radioheart.ru/api/v2/station/85296/nowplaying',
  'https://api.radioheart.ru/api/nowplaying/85296',
  'https://s0.radioheart.ru:8000/RH85296/status-json.xsl',
];

const audio = new Audio();
audio.preload = 'none';
audio.volume = 0.8;
/* crossOrigin НЕ ставим по умолчанию — только если пробуем реальный визуализатор */

let audioCtx = null;
let analyser = null;
let sourceNode = null;
let sourceCreated = false;
let vizRAF = null;
let vizMode = 'idle'; // 'idle' | 'real' | 'decorative'
let isPlaying = false;
let metaTimer = null;
let corsChecked = false;
let corsAvailable = false;

/* ---------- helpers ---------- */

function setStatus(t) { els.status.textContent = t; }

function setVizMode(mode) {
  vizMode = mode;
  if (mode === 'real') els.vizMode.textContent = 'визуализатор: реальный';
  else if (mode === 'decorative') els.vizMode.textContent = 'визуализатор: декоративный';
  else els.vizMode.textContent = 'визуализатор: —';
}

/* ---------- CORS probe (один раз) ---------- */

async function probeCors(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      headers: { Range: 'bytes=0-1' },
      cache: 'no-store',
    });
    // Если fetch прошёл и тип ответа cors — значит ACAO есть
    return res.type === 'cors' || res.type === 'basic';
  } catch (e) {
    return false;
  }
}

async function resolveStreamUrl() {
  if (CORS_PROXY) {
    const proxied = CORS_PROXY + encodeURIComponent(STREAM_URL);
    els.streamLabel.textContent = 'via proxy';
    return { url: proxied, cors: true };
  }
  if (!corsChecked) {
    corsChecked = true;
    corsAvailable = await probeCors(STREAM_URL);
  }
  return { url: STREAM_URL, cors: corsAvailable };
}

/* ---------- playback ---------- */

function applyPlayIcon(playing) {
  els.playBtn.querySelector('.icon-play').style.display = playing ? 'none' : '';
  els.playBtn.querySelector('.icon-pause').style.display = playing ? '' : 'none';
}

async function play() {
  if (isPlaying) return;
  els.body.classList.add('loading');
  setStatus('подключение…');

  const { url, cors } = await resolveStreamUrl();

  if (cors) {
    // реальный визуализатор: нужен crossOrigin ПЕРЕД src
    try {
      audio.crossOrigin = 'anonymous';
      if (!sourceCreated) {
        if (!initAudioGraph()) throw new Error('no audio graph');
      }
      setVizMode('real');
    } catch (e) {
      console.warn('real viz unavailable, falling back:', e);
      audio.removeAttribute('crossOrigin');
      setVizMode('decorative');
    }
  } else {
    audio.removeAttribute('crossOrigin');
    setVizMode('decorative');
  }

  // Без ?t= cache-buster — некоторые Icecast-сервера отдают 403 на незнакомый query
  audio.src = url;
  audio.load();

  try {
    await audio.play();
  } catch (err) {
    console.warn('play failed:', err);
    els.body.classList.remove('loading');
    setStatus('ошибка — тапни ещё раз');
  }
}

function stop() {
  isPlaying = false;
  els.body.classList.remove('playing', 'loading');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  applyPlayIcon(false);
  setStatus('остановлено');
  els.buffer.textContent = '—';
  stopViz();
  stopMeta();
}

els.playBtn.addEventListener('click', () => { isPlaying ? stop() : play(); });

audio.addEventListener('playing', () => {
  isPlaying = true;
  els.body.classList.remove('loading');
  els.body.classList.add('playing');
  applyPlayIcon(true);
  setStatus('в эфире');
  startViz();
  startMeta();
  updateMediaSession();
});

audio.addEventListener('waiting', () => {
  els.body.classList.add('loading');
  setStatus('буферизация…');
});

audio.addEventListener('error', (e) => {
  console.warn('audio error', e);
  els.body.classList.remove('loading', 'playing');
  applyPlayIcon(false);
  setStatus('поток недоступен');
});

audio.addEventListener('stalled', () => {
  if (!isPlaying) return;
  setStatus('переподключение…');
  setTimeout(() => { const was = isPlaying; stop(); if (was) play(); }, 1500);
});

/* ---------- volume ---------- */

els.volume.addEventListener('input', () => {
  audio.volume = els.volume.value / 100;
  if (audio.volume > 0) audio.muted = false;
  els.muteBtn.classList.toggle('off', audio.muted || audio.volume === 0);
});

els.muteBtn.addEventListener('click', () => {
  audio.muted = !audio.muted;
  els.muteBtn.classList.toggle('off', audio.muted);
});

els.volBtn.addEventListener('click', () => {
  const next = audio.volume > 0.5 ? 0.2 : 0.8;
  audio.volume = next;
  els.volume.value = next * 100;
  els.muteBtn.classList.toggle('off', next === 0);
});

/* ---------- real visualizer (Web Audio) ---------- */

function initAudioGraph() {
  if (sourceCreated) return true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    sourceCreated = true;
    return true;
  } catch (e) {
    console.warn('audio graph init failed:', e);
    return false;
  }
}

/* ---------- decorative visualizer (no audio data) ---------- */

function startDecorativeViz() {
  const ctx = els.viz.getContext('2d');
  const W = els.viz.width, H = els.viz.height;
  const cx = W / 2, cy = H / 2;
  const bars = 96;
  const step = (Math.PI * 2) / bars;
  const inner = W * 0.24;

  const phases = Array.from({ length: bars }, () => Math.random() * Math.PI * 2);
  const speeds = Array.from({ length: bars }, () => 0.4 + Math.random() * 1.3);
  const baseAmp = Array.from({ length: bars }, () => 0.22 + Math.random() * 0.45);

  let t = 0, envelope = 0, beat = 0, nextBeat = 0;

  function draw() {
    vizRAF = requestAnimationFrame(draw);
    t += 0.016;
    envelope += ((isPlaying ? 1 : 0) - envelope) * 0.06;

    if (isPlaying && t > nextBeat) {
      beat = 1;
      nextBeat = t + 0.35 + Math.random() * 1.1;
    }
    beat *= 0.90;

    ctx.clearRect(0, 0, W, H);

    for (let i = 0; i < bars; i++) {
      const m1 = 0.5 + 0.5 * Math.sin(t * speeds[i] + phases[i]);
      const m2 = 0.5 + 0.5 * Math.sin(t * speeds[i] * 2.3 + phases[i] * 1.7);
      let v = (m1 * 0.65 + m2 * 0.35) * baseAmp[i];
      v += beat * 0.35 * (1 - i / bars);
      v *= envelope;

      const len = 4 + v * (W * 0.22);
      const angle = i * step - Math.PI / 2;
      const x1 = cx + Math.cos(angle) * inner;
      const y1 = cy + Math.sin(angle) * inner;
      const x2 = cx + Math.cos(angle) * (inner + len);
      const y2 = cy + Math.sin(angle) * (inner + len);

      const hue = 340 + v * 30;
      const light = 45 + v * 30;
      ctx.strokeStyle = `hsla(${hue}, 100%, ${light}%, ${0.25 + v * 0.7})`;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, inner - 6 - (0.1 + beat * 0.4) * 10, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,45,85,${0.12 + envelope * 0.3 + beat * 0.25})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  draw();
}

/* ---------- real viz driver ---------- */

function startRealViz() {
  if (!analyser) { startDecorativeViz(); return; }
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const ctx = els.viz.getContext('2d');
  const W = els.viz.width, H = els.viz.height;
  const bins = analyser.frequencyBinCount;
  const data = new Uint8Array(bins);
  const cx = W / 2, cy = H / 2;

  function draw() {
    vizRAF = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, W, H);

    const bars = 96;
    const inner = W * 0.24;
    const step = (Math.PI * 2) / bars;

    for (let i = 0; i < bars; i++) {
      const idx = Math.floor((i / bars) * (bins * 0.7));
      const v = data[idx] / 255;
      const len = 4 + v * (W * 0.20);
      const angle = i * step - Math.PI / 2;
      const x1 = cx + Math.cos(angle) * inner;
      const y1 = cy + Math.sin(angle) * inner;
      const x2 = cx + Math.cos(angle) * (inner + len);
      const y2 = cy + Math.sin(angle) * (inner + len);

      ctx.strokeStyle = `hsla(${340 + v * 30}, 100%, ${45 + v * 25}%, ${0.25 + v * 0.7})`;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const avg = data.reduce((a, b) => a + b, 0) / bins / 255;
    ctx.beginPath();
    ctx.arc(cx, cy, inner - 6 - avg * 10, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,45,85,${0.15 + avg * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  draw();
}

function startViz() {
  stopViz();
  if (vizMode === 'real') startRealViz();
  else startDecorativeViz();
}

function stopViz() {
  if (vizRAF) cancelAnimationFrame(vizRAF);
  vizRAF = null;
  const ctx = els.viz.getContext('2d');
  ctx.clearRect(0, 0, els.viz.width, els.viz.height);
}

/* ---------- metadata ---------- */

async function fetchMeta() {
  for (const url of META_ENDPOINTS) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { continue; }

      if (json.icestats && json.icestats.source) {
        const src = Array.isArray(json.icestats.source) ? json.icestats.source[0] : json.icestats.source;
        applyMeta(src.title || src.server_name, src.yp_currently_playing, src.listeners, src.bitrate);
        return true;
      }
      const title = json.title || json.song || json.track || json.nowplaying;
      const artist = json.artist || json.performer || '';
      if (title) { applyMeta(artist, title, json.listeners, json.bitrate); return true; }
    } catch (e) { /* next */ }
  }
  return false;
}

function applyMeta(artist, title, listeners, bitrate) {
  if (title) els.track.textContent = title;
  if (artist) els.artist.textContent = artist;
  else if (title) els.artist.textContent = 'Радио Кострома ФМ';
  if (listeners) els.listeners.textContent = listeners + ' слушателей';
  if (bitrate) els.bitrate.textContent = bitrate + ' kbps';
  updateMediaSession(artist, title);
}

function startMeta() {
  fetchMeta();
  clearInterval(metaTimer);
  metaTimer = setInterval(fetchMeta, 15000);
}
function stopMeta() { clearInterval(metaTimer); metaTimer = null; }

/* ---------- Media Session ---------- */

function updateMediaSession(artist, title) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: title || els.track.textContent,
    artist: artist || els.artist.textContent,
    album: 'Радио Кострома ФМ',
  });
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', stop);
  navigator.mediaSession.setActionHandler('stop', stop);
}

/* ---------- clock ---------- */

function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString('ru-RU', { hour12: false });
}
tickClock();
setInterval(tickClock, 1000);

/* ---------- buffer indicator ---------- */

setInterval(() => {
  if (!isPlaying) return;
  if (audio.buffered.length) {
    const end = audio.buffered.end(audio.buffered.length - 1);
    els.buffer.textContent = 'буфер ' + Math.max(0, end - audio.currentTime).toFixed(1) + 'с';
  } else {
    els.buffer.textContent = 'live';
  }
}, 1000);

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); isPlaying ? stop() : play(); }
  if (e.code === 'ArrowUp') { e.preventDefault(); audio.volume = Math.min(1, audio.volume + 0.05); els.volume.value = audio.volume * 100; }
  if (e.code === 'ArrowDown') { e.preventDefault(); audio.volume = Math.max(0, audio.volume - 0.05); els.volume.value = audio.volume * 100; }
  if (e.code === 'KeyM') { audio.muted = !audio.muted; els.muteBtn.classList.toggle('off', audio.muted); }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isPlaying && audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
});

/* показать режим визуализатора с самого старта */
setVizMode('idle');
