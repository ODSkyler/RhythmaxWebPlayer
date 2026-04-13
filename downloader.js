/**
 * downloader.js — Rhythmax Download Engine v3
 * ─────────────────────────────────────────────────────────────────
 * Fixes in this version:
 *
 *  FIX A — Tainted canvas crash:
 *    resources.tidal.com images are cross-origin. Canvas toBlob() on a
 *    cross-origin image throws SecurityError. Solution: fetch the cover
 *    image through the active TIDAL relay instance as a CORS-safe proxy
 *    (/image/?url=<encoded>) — or if the instance doesn't support that,
 *    fetch it directly with mode:'cors' and fall back to no-art silently.
 *    Never touch the DOM canvas for cover art.
 *
 *  FIX B — Stream cache (instant download for direct formats):
 *    player.js now stores the last getStream() response in S.lastStream.
 *    If the cached stream matches the current track+quality, the downloader
 *    skips the API call entirely and goes straight to fetching audio bytes.
 *    Only DASH (HiRes) still needs its own getStream() because the MPD
 *    segment URLs expire and cannot be reused for a full re-fetch.
 *
 *  FIX C — HiRes metadata (FLAC-in-ISOBMFF):
 *    Stitched DASH is fragmented MP4, not raw FLAC. iTunes atoms injected.
 *
 *  FIX 1 (from v2) — M4A moov tree not corrupted:
 *    All MP4 helpers work with Uint8Array throughout, no .buffer on slices.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   COVER ART — proxy fetch (no canvas, no CORS crash)
   ─────────────────────────────────────────────────────────
   Strategy (tried in order):
   1. Fetch cover URL via the active TIDAL instance using a
      /proxy/?url= or /image/?url= endpoint if available.
   2. Direct fetch with credentials omitted (works when the CDN
      sends permissive CORS on some instances).
   3. Return null — download proceeds without art.
═══════════════════════════════════════════════════════════ */

async function fetchCoverSafe(track) {
  const uuid = track._raw && track._raw.album && track._raw.album.cover;
  if (!uuid) return null;

  // Build the 1280px cover URL (dashes → slashes for the CDN path)
  const path     = uuid.replace(/-/g, '/');
  const coverUrl = 'https://resources.tidal.com/images/' + path + '/1280x1280.jpg';

  // Attempt 1: direct fetch, no-cors mode just gives an opaque response
  // so we must use cors mode and accept failure.
  try {
    const res = await fetch(coverUrl, { mode: 'cors', credentials: 'omit' });
    if (res.ok) return res.arrayBuffer();
  } catch (_) {}

  // Attempt 2: route through the active TIDAL relay instance.
  // Many instances expose /proxy?url= or pass through arbitrary URLs.
  if (S.activeInstance) {
    try {
      const proxyUrl = S.activeInstance + '/proxy?url=' + encodeURIComponent(coverUrl);
      const res = await fetch(proxyUrl);
      if (res.ok) return res.arrayBuffer();
    } catch (_) {}

    // Some instances use /image/ path
    try {
      const proxyUrl2 = S.activeInstance + '/image?url=' + encodeURIComponent(coverUrl);
      const res = await fetch(proxyUrl2);
      if (res.ok) return res.arrayBuffer();
    } catch (_) {}
  }

  // All attempts failed — return null, download continues without art
  console.warn('Cover art unavailable (CORS) — downloading without artwork');
  return null;
}

/* ═══════════════════════════════════════════════════════════
   STREAM CACHE HELPER
   ─────────────────────────────────────────────────────────
   Returns the cached stream if it matches current track+quality,
   otherwise calls TidalAPI.getStream() and updates the cache.
   DASH streams are always re-fetched because MPD segment URLs expire.
═══════════════════════════════════════════════════════════ */

async function getStreamCached(trackId, quality) {
  // Use cached stream if it matches (saves one API round-trip for direct formats)
  if (
    S.lastStream &&
    S.lastStreamId === trackId &&
    S.lastStreamQ  === quality &&
    S.lastStream.type !== 'dash'   // DASH URLs expire — always re-fetch
  ) {
    console.log('Reusing cached stream for', trackId);
    return S.lastStream;
  }

  const stream = await TidalAPI.getStream(trackId, quality);

  // Update cache (but don't overwrite a currently-playing DASH player)
  S.lastStream   = stream;
  S.lastStreamId = trackId;
  S.lastStreamQ  = quality;

  return stream;
}

/* ═══════════════════════════════════════════════════════════
   PUBLIC ENTRY POINT — hero download button
═══════════════════════════════════════════════════════════ */

async function downloadTrack(track, quality) {
  if (!track) { showToast('No track selected'); return; }

  const btn = document.getElementById('heroDownloadBtn');
  setDownloadState(btn, 'loading', 'Preparing…');

  try {
    // FIX B: reuse cached stream for direct formats
    const stream = await getStreamCached(track.id, quality);

    setDownloadState(btn, 'loading', 'Fetching artwork…');
    const coverBuf = await fetchCoverSafe(track);   // FIX A: no canvas

    const meta = buildMeta(track, stream, quality);

    if (stream.type === 'dash') {
      await downloadDashFlac(stream.mpd, meta, coverBuf, track, btn);
    } else if (stream.mimeType && stream.mimeType.includes('flac')) {
      await downloadFlac(stream.url, meta, coverBuf, track, btn);
    } else {
      await downloadM4a(stream.url, meta, coverBuf, track, btn);
    }

  } catch (e) {
    console.error('Download failed:', e);
    showToast('Download failed: ' + e.message);
    setDownloadState(btn, 'idle', null);
  }
}

/* ═══════════════════════════════════════════════════════════
   METADATA BUILDER
═══════════════════════════════════════════════════════════ */

function buildMeta(track, stream, quality) {
  const raw  = track._raw || {};
  const year = raw.streamStartDate
    ? raw.streamStartDate.substring(0, 4)
    : (raw.releaseDate ? raw.releaseDate.substring(0, 4) : '');

  return {
    title:       track.title  || '',
    artist:      track.artist || '',
    albumArtist: raw.artists
      ? ((raw.artists.find(function(a) { return a.type === 'MAIN'; }) || raw.artists[0] || {}).name || track.artist)
      : track.artist,
    album:       track.album  || '',
    year:        year,
    trackNumber: raw.trackNumber || 1,
    trackTotal:  raw.trackTotal  || null,
    isrc:        raw.isrc        || '',
    bpm:         raw.bpm         ? String(raw.bpm) : '',
    copyright:   raw.copyright   || '',
    comment:     'Downloaded via Rhythmax · TIDAL · ' + quality,
    explicit:    !!raw.explicit,
    bitDepth:    stream.meta && stream.meta.bitDepth   ? stream.meta.bitDepth   : null,
    sampleRate:  stream.meta && stream.meta.sampleRate ? stream.meta.sampleRate : null,
  };
}

/* ═══════════════════════════════════════════════════════════
   SAFE FILENAME  →  Artist - Title.ext
═══════════════════════════════════════════════════════════ */

function safeFilename(track, ext) {
  const artist    = track.artist.split(',')[0].trim();
  const titleClean= (track._raw && track._raw.title) || track.title;
  return (artist + ' - ' + titleClean)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200) + '.' + ext;
}

/* ═══════════════════════════════════════════════════════════
   DOWNLOAD: M4A / AAC  (LOW + HIGH)
═══════════════════════════════════════════════════════════ */

async function downloadM4a(url, meta, coverBuf, track, btn) {
  setDownloadState(btn, 'loading', 'Downloading…');
  const audioBuf = await fetchBinary(url, function(p) {
    setDownloadState(btn, 'loading', 'Downloading… ' + p + '%');
  });

  setDownloadState(btn, 'loading', 'Tagging…');
  const tagged = injectM4aMeta(new Uint8Array(audioBuf), meta, coverBuf);

  triggerDownload(tagged, safeFilename(track, 'm4a'), 'audio/mp4');
  setDownloadState(btn, 'done', 'Downloaded!');
  setTimeout(function() { setDownloadState(btn, 'idle', null); }, 3000);
  showToast('Downloaded: ' + track.title);
}

/* ═══════════════════════════════════════════════════════════
   DOWNLOAD: FLAC / LOSSLESS
═══════════════════════════════════════════════════════════ */

async function downloadFlac(url, meta, coverBuf, track, btn) {
  setDownloadState(btn, 'loading', 'Downloading…');
  const audioBuf = await fetchBinary(url, function(p) {
    setDownloadState(btn, 'loading', 'Downloading… ' + p + '%');
  });

  setDownloadState(btn, 'loading', 'Tagging…');
  const tagged = injectFlacMeta(new Uint8Array(audioBuf), meta, coverBuf);

  triggerDownload(tagged, safeFilename(track, 'flac'), 'audio/flac');
  setDownloadState(btn, 'done', 'Downloaded!');
  setTimeout(function() { setDownloadState(btn, 'idle', null); }, 3000);
  showToast('Downloaded: ' + track.title);
}

/* ═══════════════════════════════════════════════════════════
   DOWNLOAD: HI-RES (DASH → stitched FLAC-in-MP4)
   FIX C: TIDAL HiRes DASH = FLAC-in-ISOBMFF, not raw FLAC.
   Inject iTunes atoms same as M4A, save with .flac extension.
═══════════════════════════════════════════════════════════ */

async function downloadDashFlac(mpdXml, meta, coverBuf, track, btn) {
  setDownloadState(btn, 'loading', 'Parsing manifest…');

  const { initUrl, segmentUrls } = parseMpd(mpdXml);
  const total   = segmentUrls.length + 1;
  let   fetched = 0;

  function tick() {
    fetched++;
    setDownloadState(btn, 'loading',
      'Stitching ' + Math.round((fetched / total) * 100) + '%…');
  }

  const initBuf = await fetchBinary(initUrl); tick();
  const segs    = [];
  for (const url of segmentUrls) {
    segs.push(new Uint8Array(await fetchBinary(url))); tick();
  }

  setDownloadState(btn, 'loading', 'Tagging…');
  const stitched = concatU8([new Uint8Array(initBuf), ...segs]);
  const tagged   = injectM4aMeta(stitched, meta, coverBuf); // FIX C

  triggerDownload(tagged, safeFilename(track, 'flac'), 'audio/flac');
  setDownloadState(btn, 'done', 'Downloaded!');
  setTimeout(function() { setDownloadState(btn, 'idle', null); }, 3000);
  showToast('Hi-Res downloaded: ' + track.title);
}

/* ═══════════════════════════════════════════════════════════
   MPD PARSER
═══════════════════════════════════════════════════════════ */

function parseMpd(mpdXml) {
  const doc = new DOMParser().parseFromString(mpdXml, 'application/xml');
  const st  = doc.querySelector('SegmentTemplate');
  if (!st) throw new Error('No SegmentTemplate in MPD');

  const initUrl  = st.getAttribute('initialization');
  const mediaTpl = st.getAttribute('media');
  const start    = parseInt(st.getAttribute('startNumber') || '1', 10);

  const nums = [];
  let n = start;
  for (const s of doc.querySelectorAll('SegmentTimeline S')) {
    const r = parseInt(s.getAttribute('r') || '0', 10);
    for (let i = 0; i <= r; i++) nums.push(n++);
  }

  if (!initUrl || !nums.length) throw new Error('Invalid MPD structure');

  return {
    initUrl,
    segmentUrls: nums.map(function(num) { return mediaTpl.replace('$Number$', num); }),
  };
}

/* ═══════════════════════════════════════════════════════════
   FLAC METADATA INJECTOR  (raw FLAC files — LOSSLESS only)
═══════════════════════════════════════════════════════════ */

function injectFlacMeta(src, meta, coverBuf) {
  if (src[0] !== 0x66 || src[1] !== 0x4C || src[2] !== 0x61 || src[3] !== 0x43) {
    console.warn('Not raw FLAC — skipping FLAC injection');
    return src;
  }

  let offset = 4, siBlock = null, audioStart = null;
  while (offset < src.length) {
    const hdr   = src[offset];
    const isLast= (hdr & 0x80) !== 0;
    const type  =  hdr & 0x7F;
    const len   = (src[offset+1] << 16) | (src[offset+2] << 8) | src[offset+3];
    if (type === 0) {
      siBlock    = new Uint8Array(src.slice(offset, offset + 4 + len));
      siBlock[0] = 0x00;
    }
    offset += 4 + len;
    if (isLast) { audioStart = offset; break; }
  }

  if (!siBlock || audioStart === null) return src;

  const vcBlock  = buildVorbisComment(meta);
  const picBlock = coverBuf ? buildFlacPicture(coverBuf) : null;

  if (picBlock) {
    picBlock[0] = (picBlock[0]  & 0x7F) | 0x80;
    vcBlock[0]  =  vcBlock[0]   & 0x7F;
  } else {
    vcBlock[0]  = (vcBlock[0]   & 0x7F) | 0x80;
  }
  siBlock[0] &= 0x7F;

  const parts = [new Uint8Array([0x66,0x4C,0x61,0x43]), siBlock, vcBlock];
  if (picBlock) parts.push(picBlock);
  parts.push(src.slice(audioStart));
  return concatU8(parts);
}

function buildVorbisComment(meta) {
  const vendor = encodeUtf8('Rhythmax');
  const tags   = [];
  function add(k, v) { if (v !== null && v !== undefined && String(v) !== '') tags.push(encodeUtf8(k + '=' + v)); }
  add('TITLE',         meta.title);
  add('ARTIST',        meta.artist);
  add('ALBUMARTIST',   meta.albumArtist);
  add('ALBUM',         meta.album);
  add('DATE',          meta.year);
  add('TRACKNUMBER',   meta.trackNumber);
  add('ISRC',          meta.isrc);
  add('BPM',           meta.bpm);
  add('COPYRIGHT',     meta.copyright);
  add('COMMENT',       meta.comment);
  if (meta.explicit)   add('ITUNESADVISORY', '1');
  if (meta.bitDepth)   add('BITSPERSAMPLE',  meta.bitDepth);
  if (meta.sampleRate) add('SAMPLERATE',     meta.sampleRate);

  let size = 4 + vendor.length + 4;
  for (const t of tags) size += 4 + t.length;
  const data = new Uint8Array(size);
  const dv   = new DataView(data.buffer);
  let pos = 0;
  dv.setUint32(pos, vendor.length, true); pos += 4;
  data.set(vendor, pos); pos += vendor.length;
  dv.setUint32(pos, tags.length, true);   pos += 4;
  for (const t of tags) { dv.setUint32(pos, t.length, true); pos += 4; data.set(t, pos); pos += t.length; }
  return wrapFlacBlock(4, data);
}

function buildFlacPicture(coverBuf) {
  const b    = new Uint8Array(coverBuf);
  const mime = encodeUtf8((b[0]===0xFF && b[1]===0xD8) ? 'image/jpeg' : 'image/png');
  const desc = encodeUtf8('Cover');
  const img  = b;
  const size = 4 + 4+mime.length + 4+desc.length + 16 + 4+img.length;
  const data = new Uint8Array(size);
  const dv   = new DataView(data.buffer);
  let pos = 0;
  dv.setUint32(pos, 3,           false); pos += 4;
  dv.setUint32(pos, mime.length, false); pos += 4; data.set(mime, pos); pos += mime.length;
  dv.setUint32(pos, desc.length, false); pos += 4; data.set(desc, pos); pos += desc.length;
  dv.setUint32(pos, 1280, false); pos += 4;
  dv.setUint32(pos, 1280, false); pos += 4;
  dv.setUint32(pos, 24,   false); pos += 4;
  dv.setUint32(pos, 0,    false); pos += 4;
  dv.setUint32(pos, img.length, false); pos += 4; data.set(img, pos);
  return wrapFlacBlock(6, data);
}

function wrapFlacBlock(type, data) {
  const b = new Uint8Array(4 + data.length);
  b[0] = type & 0x7F;
  b[1] = (data.length >> 16) & 0xFF;
  b[2] = (data.length >>  8) & 0xFF;
  b[3] =  data.length        & 0xFF;
  b.set(data, 4);
  return b;
}

/* ═══════════════════════════════════════════════════════════
   M4A / iTunes METADATA INJECTOR
   Works for both AAC (LOW/HIGH) and FLAC-in-ISOBMFF (HiRes).
   FIX 1: pure Uint8Array throughout, no .buffer on slices.
═══════════════════════════════════════════════════════════ */

function injectM4aMeta(src, meta, coverBuf) {
  return replaceIlst(src, buildIlst(meta, coverBuf));
}

function buildIlst(meta, coverBuf) {
  const atoms = [];
  function txt(name, val) {
    if (!val && val !== 0) return;
    const enc  = encodeUtf8(String(val));
    const pay  = new Uint8Array(8 + enc.length);
    new DataView(pay.buffer).setUint32(0, 1, false); // UTF-8
    pay.set(enc, 8);
    atoms.push(mkBox(name, mkBox('data', pay)));
  }
  txt('\xA9nam', meta.title);
  txt('\xA9ART', meta.artist);
  txt('aART',    meta.albumArtist);
  txt('\xA9alb', meta.album);
  txt('\xA9day', meta.year);
  txt('\xA9cmt', meta.comment);
  txt('cprt',    meta.copyright);

  if (meta.trackNumber) {
    const td = new Uint8Array(16); // 8 flags + 8 trkn data
    new DataView(td.buffer).setUint16(10, meta.trackNumber, false);
    if (meta.trackTotal) new DataView(td.buffer).setUint16(12, meta.trackTotal, false);
    atoms.push(mkBox('trkn', mkBox('data', td)));
  }

  if (coverBuf) {
    const b   = new Uint8Array(coverBuf);
    const fmt = (b[0]===0xFF && b[1]===0xD8) ? 13 : 14;
    const pay = new Uint8Array(8 + b.length);
    new DataView(pay.buffer).setUint32(0, fmt, false);
    pay.set(b, 8);
    atoms.push(mkBox('covr', mkBox('data', pay)));
  }

  if (meta.explicit) {
    const pay = new Uint8Array(9); // 8 flags + 1 byte
    new DataView(pay.buffer).setUint32(0, 21, false);
    pay[8] = 1;
    atoms.push(mkBox('rtng', mkBox('data', pay)));
  }

  return mkBox('ilst', concatU8(atoms));
}

/* ─── MP4 box helpers ────────────────────────────────── */

function mkBox(name, content) {
  const nb  = encodeAscii(name.padEnd(4,' ').substring(0,4));
  const box = new Uint8Array(8 + content.length);
  new DataView(box.buffer).setUint32(0, 8 + content.length, false);
  box.set(nb, 4);
  box.set(content, 8);
  return box;
}

// FullBox = size(4) + type(4) + versionFlags(4) + content
function mkFullBox(name, vf, content) {
  const nb  = encodeAscii(name.padEnd(4,' ').substring(0,4));
  const vfb = new Uint8Array(4);
  new DataView(vfb.buffer).setUint32(0, vf, false);
  const inner = concatU8([vfb, content]);
  const box   = new Uint8Array(8 + inner.length);
  new DataView(box.buffer).setUint32(0, 8 + inner.length, false);
  box.set(nb, 4);
  box.set(inner, 8);
  return box;
}

function findBox(src, start, end, name) {
  const nb = encodeAscii(name.padEnd(4,' ').substring(0,4));
  let pos  = start;
  while (pos + 8 <= end) {
    const sz = rdU32(src, pos);
    if (sz < 8 || pos + sz > end + 8) break;
    if (src[pos+4]===nb[0] && src[pos+5]===nb[1] && src[pos+6]===nb[2] && src[pos+7]===nb[3]) return pos;
    pos += sz;
  }
  return -1;
}

function rdU32(src, pos) {
  return ((src[pos]<<24)|(src[pos+1]<<16)|(src[pos+2]<<8)|src[pos+3]) >>> 0;
}

function replaceIlst(src, newIlst) {
  const moovPos = findBox(src, 0, src.length, 'moov');
  if (moovPos === -1) { console.warn('No moov'); return src; }

  const moovSz    = rdU32(src, moovPos);
  const moovInner = src.slice(moovPos + 8, moovPos + moovSz);
  const udtaPos   = findBox(moovInner, 0, moovInner.length, 'udta');

  let newMoovInner;
  if (udtaPos === -1) {
    newMoovInner = concatU8([moovInner, mkBox('udta', buildMetaBox(newIlst))]);
  } else {
    const udtaSz    = rdU32(moovInner, udtaPos);
    const udtaInner = moovInner.slice(udtaPos + 8, udtaPos + udtaSz);
    const metaPos   = findBox(udtaInner, 0, udtaInner.length, 'meta');

    let newUdtaInner;
    if (metaPos === -1) {
      newUdtaInner = concatU8([udtaInner, buildMetaBox(newIlst)]);
    } else {
      const metaSz    = rdU32(udtaInner, metaPos);
      const metaVF    = rdU32(udtaInner, metaPos + 8); // existing version+flags
      const metaInner = udtaInner.slice(metaPos + 12, metaPos + metaSz);
      const ilstPos   = findBox(metaInner, 0, metaInner.length, 'ilst');

      let newMetaInner;
      if (ilstPos === -1) {
        newMetaInner = concatU8([metaInner, newIlst]);
      } else {
        const ilstSz = rdU32(metaInner, ilstPos);
        newMetaInner = concatU8([metaInner.slice(0,ilstPos), newIlst, metaInner.slice(ilstPos+ilstSz)]);
      }

      const newMeta = mkFullBox('meta', metaVF, newMetaInner);
      newUdtaInner  = concatU8([udtaInner.slice(0,metaPos), newMeta, udtaInner.slice(metaPos+metaSz)]);
    }

    const newUdta = mkBox('udta', newUdtaInner);
    newMoovInner  = concatU8([moovInner.slice(0,udtaPos), newUdta, moovInner.slice(udtaPos+udtaSz)]);
  }

  return concatU8([src.slice(0,moovPos), mkBox('moov',newMoovInner), src.slice(moovPos+moovSz)]);
}

function buildMetaBox(ilstBox) {
  const hdlrPayload = new Uint8Array(25);
  hdlrPayload.set(encodeAscii('mdir'), 8);
  const hdlr = mkFullBox('hdlr', 0, hdlrPayload);
  return mkFullBox('meta', 0, concatU8([hdlr, ilstBox]));
}

/* ═══════════════════════════════════════════════════════════
   BINARY UTILITIES
═══════════════════════════════════════════════════════════ */

function concatU8(arrays) {
  const total = arrays.reduce(function(s,a){ return s+a.length; }, 0);
  const out   = new Uint8Array(total);
  let   off   = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
var concatBuffers = concatU8; // alias

function encodeUtf8(s)  { return new TextEncoder().encode(s); }
function encodeAscii(s) {
  const o = new Uint8Array(s.length);
  for (let i=0;i<s.length;i++) o[i]=s.charCodeAt(i)&0xFF;
  return o;
}

/* ═══════════════════════════════════════════════════════════
   FETCH WITH PROGRESS
═══════════════════════════════════════════════════════════ */

async function fetchBinary(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const cl = res.headers.get('content-length');
  if (onProgress && cl) {
    const total = parseInt(cl, 10);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress(Math.round(got/total*100));
    }
    return concatU8(chunks).buffer;
  }
  return res.arrayBuffer();
}

/* ═══════════════════════════════════════════════════════════
   TRIGGER DOWNLOAD
═══════════════════════════════════════════════════════════ */

function triggerDownload(data, filename, mimeType) {
  const blob = new Blob([data instanceof Uint8Array ? data : new Uint8Array(data)], {type: mimeType});
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {href:url, download:filename});
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 10000);
}

/* ═══════════════════════════════════════════════════════════
   BUTTON STATE MACHINE
═══════════════════════════════════════════════════════════ */

function setDownloadState(btn, state, label) {
  if (!btn) return;
  btn.classList.remove('dl-idle','dl-loading','dl-done');
  btn.classList.add('dl-'+state);
  const icon = btn.querySelector('.dl-icon');
  const text = btn.querySelector('.dl-text');
  if (state==='idle')    { if(icon) icon.innerHTML=DL_SVG;   if(text) text.textContent='Download';      btn.disabled=false; }
  if (state==='loading') { if(icon) icon.innerHTML=SPIN_SVG; if(text) text.textContent=label||'…';      btn.disabled=true;  }
  if (state==='done')    { if(icon) icon.innerHTML=CHECK_SVG;if(text) text.textContent=label||'Done!';  btn.disabled=false; }
}

const DL_SVG   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const SPIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="animation:dl-spin .8s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>';
const CHECK_SVG= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20,6 9,17 4,12"/></svg>';

/* ═══════════════════════════════════════════════════════════
   TRACK ROW DOWNLOAD
═══════════════════════════════════════════════════════════ */

async function downloadTrackRow(queueIdx, event) {
  event.stopPropagation();
  const track = S.queue[queueIdx];
  if (!track) return;
  const btn = event.currentTarget;
  setDownloadState(btn, 'loading', '…');
  try {
    const stream   = await getStreamCached(track.id, S.quality);
    const coverBuf = await fetchCoverSafe(track);
    const meta     = buildMeta(track, stream, S.quality);
    if (stream.type === 'dash') {
      await downloadDashFlac(stream.mpd, meta, coverBuf, track, btn);
    } else if (stream.mimeType && stream.mimeType.includes('flac')) {
      await downloadFlac(stream.url, meta, coverBuf, track, btn);
    } else {
      await downloadM4a(stream.url, meta, coverBuf, track, btn);
    }
  } catch(e) {
    console.error(e);
    showToast('Download failed: ' + e.message);
    setDownloadState(btn, 'idle', null);
  }
}
