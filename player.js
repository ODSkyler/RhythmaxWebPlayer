/**
 * wave.player — player.js
 * ─────────────────────────────────────────────────────────────────
 * Full TIDAL integration via open community relay instances.
 *
 * FLOW:
 *  1. On load → fetch active instances from uptime API
 *  2. Auto-select best streaming instance (v2.8 preferred)
 *  3. User searches → /search/?s= on active instance
 *  4. User picks track → /track/?id=&quality= on active instance
 *  5. Decode base64 manifest:
 *     LOW/HIGH/LOSSLESS  → JSON { urls: [directURL] } → <audio>
 *     HI_RES_LOSSLESS    → DASH MPD XML → dash.js MediaPlayer
 *
 * ADDING MORE PROVIDERS:
 *  Implement a provider module with search(query) and getStream(id, quality)
 *  returning normalised Track objects. See PROVIDERS section below.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════ */

const UPTIME_URL       = 'https://tidal-uptime.props-76styles.workers.dev/';
const SEARCH_DEBOUNCE  = 450; // ms

/**
 * Build a TIDAL cover art URL.
 * The UUID from the API uses dashes: "95fa6942-edce-4c2c-88cb-5b6b84fbb35d"
 * The CDN URL uses slashes:          "95fa6942/edce/4c2c/88cb/5b6b84fbb35d"
 * Available sizes: 160, 640, 1280
 */
function coverUrl(uuid, size) {
  if (!uuid) return '';
  var path = uuid.replace(/-/g, '/');
  return 'https://resources.tidal.com/images/' + path + '/' + size + 'x' + size + '.jpg';
}

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */

const S = {
  instances:      [],
  activeInstance: null,
  queue:          [],
  currentIdx:     -1,
  isPlaying:      false,
  isShuffle:      false,
  isRepeat:       false,
  quality:        'HIGH',
  provider:       'tidal',
  likedIds:       new Set(),
  waveformData:   [],
  vizBars:        [],
  searchTimer:    null,
  dashPlayer:     null,
  searchResults:  [],
  retryCount:    0,
  maxRetries:    1,
  isSwitchingInstance: false,
  isLoadingTrack: false,
  currentRequestId: 0,
  lastStream:    null,   // cached stream response — reused by downloader
  lastStreamId:  null,   // track id the cache belongs to
  lastStreamQ:   null,   // quality the cache belongs to
};

/* ═══════════════════════════════════════════════════════════
   TRACK NORMALISATION
═══════════════════════════════════════════════════════════ */

function normaliseTidal(item) {
  const coverUuid = item.album && item.album.cover;
  return {
    id:       item.id,
    title:    item.title + (item.version ? ' (' + item.version + ')' : ''),
    artist:   item.artists ? item.artists.map(function(a) { return a.name; }).join(', ') : (item.artist ? item.artist.name : '—'),
    album:    item.album ? item.album.title : '—',
    duration: item.duration || 0,
    cover:    coverUrl(coverUuid, 160),   // thumbnail in lists
    coverLg:  coverUrl(coverUuid, 640),   // hero art
    explicit: !!item.explicit,
    quality:  item.audioQuality || '—',
    bpm:      item.bpm || null,
    key:      item.key || null,
    keyScale: item.keyScale || null,
    provider: 'tidal',
    _raw:     item,
  };
}

/* ═══════════════════════════════════════════════════════════
   TIDAL API
═══════════════════════════════════════════════════════════ */

const TidalAPI = {
  async search(query) {
  if (!query) return [];

  let instances = S.instances;

  // 🔥 Move activeInstance to FRONT
  if (S.activeInstance) {
    instances = [
      { url: S.activeInstance },
      ...instances.filter(i => i.url !== S.activeInstance)
    ];
  }

  let lastError = null;

  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];

    try {
      console.warn("Searching via:", instance.url);

      const res = await fetch(
        instance.url + '/search/?s=' + encodeURIComponent(query)
      );

      if (!res.ok) throw new Error('Search failed: ' + res.status);

      const json = await res.json();

      // ✅ lock working instance
      if (S.activeInstance !== instance.url) {
        console.warn("Switching active instance →", instance.url);
        selectInstance(instance.url);
      }

      return (json.data && json.data.items ? json.data.items : [])
        .map(normaliseTidal);

    } catch (e) {
      console.warn("Search failed on:", instance.url);
      lastError = e;
    }
  }

  console.error("All instances failed for search");
  throw lastError || new Error("Search failed on all instances");
},

  async getStream(trackId, quality) {
    if (!S.activeInstance) throw new Error('No active TIDAL instance');
    const res  = await fetch(S.activeInstance + '/track/?id=' + trackId + '&quality=' + quality);
    if (!res.ok) throw new Error('Stream fetch failed: ' + res.status);
    const json = await res.json();
    const data = json && json.data;
    if (!data || !data.manifest) throw new Error('No manifest in response');

    const decoded = atob(data.manifest);

    if (data.manifestMimeType === 'application/dash+xml') {
      return { type: 'dash', mpd: decoded, meta: data };
    } else {
      const manifest = JSON.parse(decoded);
      const url = manifest.urls && manifest.urls[0];
      if (!url) throw new Error('No URL in manifest');
      return { type: 'direct', url: url, mimeType: manifest.mimeType, meta: data };
    }
  },
};

/* ═══════════════════════════════════════════════════════════
   FUTURE PROVIDERS (JioSaavn, YouTube)
   Each needs: search(query), getStream(id, quality)
   Return normalised track objects.
═══════════════════════════════════════════════════════════ */
// const JioSaavnAPI = { async search(q){...}, async getStream(id,q){...} };
// const YouTubeAPI  = { async search(q){...}, async getStream(id,q){...} };

/* ═══════════════════════════════════════════════════════════
   INSTANCE MANAGER
═══════════════════════════════════════════════════════════ */

async function fetchInstances() {
  try {
    const res  = await fetch(UPTIME_URL);
    const json = await res.json();
    S.instances = json.streaming || json.api || [];
    renderInstanceList();
    const saved = localStorage.getItem("rx_instance");

    if (saved) {
       const exists = S.instances.find(i => i.url === saved);

    if (exists) {
       console.warn("Saved instance still valid:", saved);
       selectInstance(saved);
    } else {
       console.warn("Saved instance dead → selecting new");
       autoSelectInstance();
  }
  } else {
    autoSelectInstance();
}
  } catch(e) {
    document.getElementById('instanceList').innerHTML =
      '<div class="inst-loading" style="color:#ff6b6b">Failed to reach uptime API</div>';
  }
}

function autoSelectInstance() {
  if (!S.instances.length) return;
  const best = S.instances.find(function(i) { return i.version === '2.8'; }) || S.instances[0];
  selectInstance(best.url);
}

function selectInstance(url) {
  S.activeInstance = url;

  // 🔥 SAVE
  localStorage.setItem("rx_instance", url);

  renderInstanceList(); // (you can remove later)
  var shortName = url.replace('https://', '').split('.')[0];
  document.getElementById('activeBadge').textContent = 'via ' + shortName;
  showToast('Connected: ' + url.replace('https://', ''));
}

function renderInstanceList() {
  var el = document.getElementById('instanceList');
  if (!S.instances.length) { el.innerHTML = '<div class="inst-loading">No instances found</div>'; return; }
  el.innerHTML = S.instances.map(function(inst) {
    var active = inst.url === S.activeInstance;
    var name   = inst.url.replace('https://', '');
    return '<div class="inst-item ' + (active ? 'active' : '') + '" onclick="selectInstance(\'' + inst.url + '\')">'
      + '<div class="inst-dot" style="background:' + (active ? 'var(--tidal)' : '#3a3a50') + '"></div>'
      + '<div class="inst-name">' + name + '</div>'
      + '<div class="inst-ver">v' + inst.version + '</div>'
      + '</div>';
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   SEARCH
═══════════════════════════════════════════════════════════ */

function onSearchInput(val) {
  document.getElementById('searchClear').classList.toggle('visible', val.length > 0);
  clearTimeout(S.searchTimer);
  if (!val.trim()) { hideDropdown(); return; }
  if (val.trim().length < 2) return;
  S.searchTimer = setTimeout(function() { doSearch(val.trim()); }, SEARCH_DEBOUNCE);
}

function onSearchKey(e) {
  if (e.key === 'Escape') { clearSearch(); return; }
  if (e.key === 'Enter') {
    clearTimeout(S.searchTimer);
    doSearch(document.getElementById('searchInput').value.trim());
  }
}

async function doSearch(query) {
  if (!query) return;
  showDropdown();
  setDropdownHTML('<div class="search-status"><span style="color:var(--muted)">Searching TIDAL…</span></div>');
  try {
    var tracks = await TidalAPI.search(query);
    S.searchResults = tracks;
    if (!tracks.length) { setDropdownHTML('<div class="search-status">No results found</div>'); return; }
    renderSearchResults(tracks);
  } catch(e) {
    setDropdownHTML('<div class="search-status" style="color:#ff6b6b">Error: ' + e.message + '</div>');
  }
}

function showDropdown() { document.getElementById('searchDropdown').classList.add('visible'); }
function hideDropdown()  { document.getElementById('searchDropdown').classList.remove('visible'); }
function setDropdownHTML(html) { document.getElementById('searchDropdown').innerHTML = html; }

function renderSearchResults(tracks) {
  var html = tracks.map(function(t, i) {
    return '<div class="sr-item" onclick="playFromSearch(' + i + ')">'
      + '<div class="sr-cover">' + (t.cover ? '<img src="' + t.cover + '" onerror="this.style.display=\'none\'" />' : '🎵') + '</div>'
      + '<div class="sr-info">'
      +   '<div class="sr-title">' + escHtml(t.title) + '</div>'
      +   '<div class="sr-sub">' + escHtml(t.artist)
      +     '<span class="quality-badge">' + t.quality + '</span>'
      +     (t.explicit ? '<span class="explicit-badge">E</span>' : '')
      +     (t.bpm ? '<span style="font-family:var(--font-m);font-size:10px">' + t.bpm + ' BPM</span>' : '')
      +   '</div>'
      + '</div>'
      + '<div class="sr-dur">' + fmtTime(t.duration) + '</div>'
      + '<button class="sr-add" onclick="event.stopPropagation();addToQueue(' + i + ')">+ Queue</button>'
      + '</div>';
  }).join('');
  setDropdownHTML(html);
}

function playFromSearch(idx) {
  var track = S.searchResults[idx];
  if (!track) return;
  var exists = S.queue.findIndex(function(t) { return t.id === track.id; });
  if (exists === -1) { S.queue.unshift(track); loadTrack(0); }
  else { loadTrack(exists); }
  clearSearch();
}

function addToQueue(idx) {
  var track = S.searchResults[idx];
  if (!track) return;
  if (S.queue.find(function(t) { return t.id === track.id; })) { showToast('Already in queue'); return; }
  S.queue.push(track);
  renderQueue();
  renderTrackGrid();
  showToast('Added: ' + track.title);
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').classList.remove('visible');
  hideDropdown();
}

/* ═══════════════════════════════════════════════════════════
   PLAYBACK
═══════════════════════════════════════════════════════════ */

var audioEl    = document.getElementById('audioEl');
var waveAnimId = null;

async function loadTrack(idx, autoPlay = true) {
  // 🚨 HARD LOCK (prevents multiple calls)
  if (S.isLoadingTrack) {
    console.warn("Already loading track, skipping...");
    return;
  }

  if (idx < 0 || idx >= S.queue.length) return;

  S.isLoadingTrack = true;
  S.retryCount = 0;
  S.currentIdx = idx;

  // 🔥 request ID (prevents old responses overriding)
  const reqId = Date.now();
  S.currentRequestId = reqId;

  const track = S.queue[idx];

  updateHeroUI(track);
  renderQueue();
  renderTrackGrid();

  if (!autoPlay) {
    S.isLoadingTrack = false;
    return;
  }

  setPlayBtnLoading(true);
  stopAll();

  try {
    const stream = await TidalAPI.getStream(track.id, S.quality);

    // Cache stream so downloader can reuse it without a second API call
    S.lastStream   = stream;
    S.lastStreamId = track.id;
    S.lastStreamQ  = S.quality;

    // 🚨 IGNORE OLD RESPONSE
    if (reqId !== S.currentRequestId) {
      console.warn("Stale response ignored");
      return;
    }

    setPlayBtnLoading(false);

    if (stream.type === 'dash') {
      await playDash(stream.mpd);
    } else {
      await playDirect(stream.url);
    }

    // Show bit depth + sample rate for lossless formats
    if (stream.meta) {
      if (stream.meta.bitDepth)   showMeta('heroBitDepth',   stream.meta.bitDepth + '-bit');
      if (stream.meta.sampleRate) showMeta('heroSampleRate', (stream.meta.sampleRate / 1000).toFixed(1) + ' kHz');
    }

    S.isPlaying = true;
    updatePlayBtn();
    document.getElementById('vinylRing').classList.remove('paused');
    startWaveformTick();

  } catch (e) {
    console.error(e);
    showToast('Playback error');

  } finally {
    // ✅ ALWAYS RELEASE LOCK
    S.isLoadingTrack = false;
  }
}

async function playDirect(url) {
  destroyDash();
  audioEl.src    = url;
  audioEl.volume = parseInt(document.getElementById('volSlider').value) / 100;
  await audioEl.play();
}

async function playDash(mpdXml) {
  destroyDash();
  audioEl.src = '';
  var blob   = new Blob([mpdXml], { type: 'application/dash+xml' });
  var mpdUrl = URL.createObjectURL(blob);
  S.dashPlayer = dashjs.MediaPlayer().create();
  S.dashPlayer.initialize(audioEl, mpdUrl, true);
  S.dashPlayer.setVolume(parseInt(document.getElementById('volSlider').value) / 100);
  return new Promise(function(resolve) {
    S.dashPlayer.on(dashjs.MediaPlayer.events.CAN_PLAY, resolve);
    setTimeout(resolve, 4000);
  });
}

function destroyDash() {
  if (S.dashPlayer) { try { S.dashPlayer.destroy(); } catch(e) {} S.dashPlayer = null; }
}

function stopAll() {
  destroyDash();
  audioEl.pause();
  audioEl.src = '';
  clearInterval(waveAnimId);
  S.isPlaying = false;
  updatePlayBtn();
}

function togglePlay() {
  if (S.currentIdx === -1) { showToast('Search for a track first'); return; }
  if (S.isPlaying) {
    audioEl.pause();
    if (S.dashPlayer) S.dashPlayer.pause();
    S.isPlaying = false;
    document.getElementById('vinylRing').classList.add('paused');
  } else {
    audioEl.play().catch(function(){});
    if (S.dashPlayer) S.dashPlayer.play();
    S.isPlaying = true;
    document.getElementById('vinylRing').classList.remove('paused');
    startWaveformTick();
  }
  updatePlayBtn();
}

function prevTrack() {
  S.isLoadingTrack = false;
  if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
  var idx = S.currentIdx - 1;
  if (idx < 0) idx = S.queue.length - 1;
  loadTrack(idx);
}

function nextTrack() {
  S.isLoadingTrack = false;
  if (!S.queue.length) return;
  var idx;
  if (S.isShuffle) {
    do { idx = Math.floor(Math.random() * S.queue.length); }
    while (idx === S.currentIdx && S.queue.length > 1);
  } else {
    idx = (S.currentIdx + 1) % S.queue.length;
  }
  loadTrack(idx);
}

function toggleShuffle() {
  S.isShuffle = !S.isShuffle;
  document.getElementById('shuffleBtn').classList.toggle('active', S.isShuffle);
  showToast(S.isShuffle ? '🔀 Shuffle on' : 'Shuffle off');
}

function toggleRepeat() {
  S.isRepeat = !S.isRepeat;
  document.getElementById('repeatBtn').classList.toggle('active', S.isRepeat);
  showToast(S.isRepeat ? '🔁 Repeat on' : 'Repeat off');
}

function setVolume(v) {
  var vol = parseInt(v) / 100;
  audioEl.volume = vol;
  if (S.dashPlayer) S.dashPlayer.setVolume(vol);
}

function onQualityChange(q) {
  S.quality = q;
  showToast('Quality: ' + q);
  // Update download hint immediately
  var hint = document.getElementById('dlQualityHint');
  if (hint) {
    var qLabel = {
      LOW:             'M4A · 96 kbps AAC',
      HIGH:            'M4A · 320 kbps AAC',
      LOSSLESS:        'FLAC · 16-bit 44.1 kHz',
      HI_RES_LOSSLESS: 'FLAC · 24-bit Hi-Res',
    }[q] || q;
    hint.textContent = qLabel;
  }
  if (S.currentIdx >= 0) {
    S.isLoadingTrack = false; // force-release lock
    loadTrack(S.currentIdx);
  }
}

function setProvider(p, tabEl) {
  if (p !== 'tidal') { showToast(p + ' coming soon!'); return; }
  S.provider = p;
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  if (tabEl) tabEl.classList.add('active');
}

/* Audio events */
audioEl.addEventListener('ended', function() {
  if (S.isRepeat) { audioEl.currentTime = 0; audioEl.play(); }
  else nextTrack();
});

audioEl.addEventListener('timeupdate', function() {
  updateTimeDisplay();
  drawWaveform(audioEl.currentTime / (audioEl.duration || 1));
});

audioEl.addEventListener('error', function () {
  // ✅ Ignore if already playing (most important fix)
  if (audioEl.currentTime > 0) {
    console.warn("Non-fatal error ignored");
    return;
  }

  // 🚨 Prevent spam
  if (S.isSwitchingInstance || S.isLoadingTrack) {
    console.warn("Busy, skipping instance switch");
    return;
  }

  if (S.retryCount >= S.maxRetries) {
    showToast("Playback failed");
    return;
  }

  S.isSwitchingInstance = true;
  S.retryCount++;

  const others = S.instances.filter(i => i.url !== S.activeInstance);

  if (!others.length) {
    showToast("No fallback instances");
    S.isSwitchingInstance = false;
    return;
  }

  const next = others[S.retryCount % others.length];

  console.warn("Switching instance →", next.url);

  selectInstance(next.url);

  setTimeout(() => {
    S.isSwitchingInstance = false;
    loadTrack(S.currentIdx);
  }, 800); // ⏳ give time for previous request to settle
});

/* Waveform seek */
document.getElementById('waveformTrack').addEventListener('click', function(e) {
  if (S.currentIdx === -1) return;
  var rect = document.getElementById('waveformTrack').getBoundingClientRect();
  var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (audioEl.duration) audioEl.currentTime = pct * audioEl.duration;
  if (S.dashPlayer && S.dashPlayer.duration()) S.dashPlayer.seek(pct * S.dashPlayer.duration());
  drawWaveform(pct);
});

/* ═══════════════════════════════════════════════════════════
   WAVEFORM & VISUALIZER
═══════════════════════════════════════════════════════════ */

function genWaveform(n) {
  var d = [];
  for (var i = 0; i < n; i++) {
    var base = 0.2 + 0.65 * Math.sin((i / n) * Math.PI);
    d.push(Math.max(0.08, Math.min(1, base + (Math.random() - 0.5) * 0.28)));
  }
  return d;
}

function drawWaveform(progress) {
  if (progress === undefined) progress = 0;
  var canvas = document.getElementById('waveformCanvas');
  var track  = document.getElementById('waveformTrack');
  var W = track.clientWidth || 560;
  var H = 46;
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  var numBars = Math.floor(W / 4);
  for (var i = 0; i < numBars; i++) {
    var frac = i / numBars;
    var val  = S.waveformData[Math.floor(frac * S.waveformData.length)] || 0.3;
    var h    = val * H * 0.85;
    var y    = (H - h) / 2;
    ctx.fillStyle = frac < progress ? '#6c5ce7' : 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(i * (W / numBars), y, 3, h, 1);
    else ctx.rect(i * (W / numBars), y, 3, h);
    ctx.fill();
  }
}

function startWaveformTick() {
  clearInterval(waveAnimId);
  waveAnimId = setInterval(function() {
    if (!S.isPlaying) return;
    var prog = audioEl.currentTime / (audioEl.duration || 1);
    drawWaveform(isNaN(prog) ? 0 : prog);
    updateTimeDisplay();
  }, 250);
}

function buildVisualizerBars() {
  var v = document.getElementById('visualizer');
  v.innerHTML = '';
  S.vizBars = [];
  for (var i = 0; i < 28; i++) {
    var b = document.createElement('div');
    b.className = 'bar'; v.appendChild(b); S.vizBars.push(b);
  }
}

function animateVizBars() {
  S.vizBars.forEach(function(b) {
    b.style.height = (S.isPlaying ? 4 + Math.random() * 20 : 4) + 'px';
  });
}

function updateTimeDisplay() {
  var cur = audioEl.currentTime || 0;
  var dur = audioEl.duration   || (S.queue[S.currentIdx] ? S.queue[S.currentIdx].duration : 0);
  document.getElementById('curTime').textContent = fmtTime(cur);
  document.getElementById('durTime').textContent = fmtTime(dur);
}

/* ═══════════════════════════════════════════════════════════
   HERO UI
═══════════════════════════════════════════════════════════ */

function updateHeroUI(track) {
  document.getElementById('heroTitle').textContent  = track.title;
  document.getElementById('heroArtist').textContent = track.artist + ' · ' + track.album;
  document.getElementById('heroQuality').textContent= track.quality;

  if (track.bpm) showMeta('heroBpm', track.bpm + ' BPM'); else hideMeta('heroBpm');
  if (track.key) showMeta('heroKey', track.key + ' ' + (track.keyScale || '')); else hideMeta('heroKey');
  hideMeta('heroBitDepth'); hideMeta('heroSampleRate');

  var badge = document.getElementById('heroProvider');
  badge.style.background = 'rgba(0,212,232,0.10)';
  badge.style.color      = 'var(--tidal)';
  badge.textContent      = '● TIDAL';

  var cover       = document.getElementById('heroCover');
  var placeholder = document.getElementById('heroPlaceholder');
  if (track.coverLg) {
    cover.src = track.coverLg;
    cover.onload  = function() { cover.classList.add('loaded'); placeholder.style.display = 'none'; };
    cover.onerror = function() { cover.classList.remove('loaded'); placeholder.style.display = 'flex'; };
  } else {
    cover.classList.remove('loaded'); placeholder.style.display = 'flex';
  }

  // Update download quality hint
  var hint = document.getElementById('dlQualityHint');
  if (hint) {
    var qLabel = {
      LOW:             'M4A · 96 kbps AAC',
      HIGH:            'M4A · 320 kbps AAC',
      LOSSLESS:        'FLAC · 16-bit 44.1 kHz',
      HI_RES_LOSSLESS: 'FLAC · 24-bit Hi-Res',
    }[S.quality] || S.quality;
    hint.textContent = qLabel;
  }

  // Reset hero download button
  var dlBtn = document.getElementById('heroDownloadBtn');
  if (dlBtn) setDownloadState(dlBtn, 'idle', null);

  S.waveformData = genWaveform(200);
  drawWaveform(0);
}

function showMeta(id, text) { var el = document.getElementById(id); el.textContent = text; el.style.display = ''; }
function hideMeta(id) { document.getElementById(id).style.display = 'none'; }

/* ═══════════════════════════════════════════════════════════
   RENDER: QUEUE PANEL & TRACK GRID
═══════════════════════════════════════════════════════════ */

function renderQueue() {
  var panel = document.getElementById('queuePanel');
  if (!S.queue.length) { panel.innerHTML = '<div class="empty-hint">Search a song to start</div>'; return; }
  panel.innerHTML = S.queue.slice(0, 10).map(function(t, i) {
    var active = i === S.currentIdx;
    return '<div class="queue-item ' + (active ? 'playing' : '') + '" onclick="loadTrack(' + i + ')">'
      + '<div class="queue-thumb">' + (t.cover ? '<img src="' + t.cover + '" onerror="this.style.display=\'none\'" />' : '🎵') + '</div>'
      + '<div class="queue-info"><div class="queue-title" style="color:' + (active ? 'var(--tidal)' : 'var(--text)') + '">' + escHtml(t.title) + '</div>'
      + '<div class="queue-artist">' + escHtml(t.artist) + '</div></div>'
      + '<div class="queue-dur">' + fmtTime(t.duration) + '</div>'
      + '</div>';
  }).join('');
}

function renderTrackGrid() {
  var grid = document.getElementById('trackGrid');
  document.getElementById('listTitle').textContent = 'Queue (' + S.queue.length + ')';
  if (!S.queue.length) { grid.innerHTML = '<div class="empty-state">Search for songs above to build your queue</div>'; return; }
  grid.innerHTML = S.queue.map(function(t, i) {
    var active  = i === S.currentIdx;
    var isLiked = S.likedIds.has(t.id);
    return '<div class="track-row ' + (active ? 'active' : '') + '" onclick="loadTrack(' + i + ')">'
      + '<div class="track-num">' + (active && S.isPlaying
        ? '<div class="playing-bars"><div class="pb"></div><div class="pb"></div><div class="pb"></div></div>'
        : (i + 1)) + '</div>'
      + '<div class="track-thumb">' + (t.cover ? '<img src="' + t.cover + '" onerror="this.style.display=\'none\'" />' : '🎵') + '</div>'
      + '<div class="track-details"><div class="track-name" style="color:' + (active ? 'var(--tidal)' : 'var(--text)') + '">' + escHtml(t.title) + '</div>'
      + '<div class="track-sub">' + escHtml(t.artist) + '<span class="quality-badge">' + t.quality + '</span>' + (t.explicit ? '<span class="explicit-badge">E</span>' : '') + '</div></div>'
      + '<div class="track-album">' + escHtml(t.album) + '</div>'
      + '<div class="track-dur">' + fmtTime(t.duration) + '</div>'
      + '<div class="track-actions">'
      +   '<button class="icon-btn ' + (isLiked ? 'liked' : '') + '" onclick="event.stopPropagation();toggleLike(' + t.id + ')" title="Like">♥</button>'
      +   '<button class="icon-btn dl-btn dl-idle dl-row" onclick="downloadTrackRow(' + i + ', event)" title="Download">'
      +     '<span class="dl-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>'
      +     '<span class="dl-text"></span>'
      +   '</button>'
      +   '<button class="icon-btn" onclick="event.stopPropagation();removeFromQueue(' + i + ')" title="Remove">✕</button>'
      + '</div></div>';
  }).join('');
}

function removeFromQueue(idx) {
  S.queue.splice(idx, 1);
  if (S.currentIdx >= idx && S.currentIdx > 0) S.currentIdx--;
  renderQueue(); renderTrackGrid();
}

function toggleLike(id) {
  if (S.likedIds.has(id)) { S.likedIds.delete(id); showToast('Removed from Liked Songs'); }
  else { S.likedIds.add(id); showToast('Liked ♥'); }
  renderTrackGrid();
}

function showView(view, el) {
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  el.classList.add('active');
  if (view === 'liked') {
    document.getElementById('listTitle').textContent = 'Liked Songs';
    var liked = S.queue.filter(function(t) { return S.likedIds.has(t.id); });
    if (!liked.length) { document.getElementById('trackGrid').innerHTML = '<div class="empty-state">No liked songs yet — heart a track!</div>'; return; }
    var saved = S.queue; S.queue = liked; renderTrackGrid(); S.queue = saved;
  } else { renderTrackGrid(); }
}

/* ═══════════════════════════════════════════════════════════
   PLAY BUTTON
═══════════════════════════════════════════════════════════ */

function updatePlayBtn() {
  document.getElementById('playIcon').innerHTML = S.isPlaying
    ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
    : '<path d="M8 5v14l11-7z"/>';
}

function setPlayBtnLoading(on) {
  document.getElementById('playBtn').classList.toggle('loading', on);
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */

function fmtTime(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var toastTimer;
function showToast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.classList.remove('show'); }, 2500);
}

window.addEventListener('resize', function() {
  var prog = audioEl.currentTime / (audioEl.duration || 1);
  drawWaveform(isNaN(prog) ? 0 : prog);
});

/* ═══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */

(function init() {
  buildVisualizerBars();
  S.waveformData = genWaveform(200);
  drawWaveform(0);
  setInterval(animateVizBars, 140);

  // 🔥 LOAD SAVED INSTANCE FIRST (PATCH #2)
  const saved = localStorage.getItem("rx_instance");
  if (saved) {
    console.warn("Using cached instance:", saved);
    S.activeInstance = saved;
  }

  // 🌐 Then fetch latest instances
  fetchInstances();

  showToast('Connecting to TIDAL instances…');
})();
