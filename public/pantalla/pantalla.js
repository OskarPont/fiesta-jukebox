import {
  api, ApiError, el, icon, setIcon, setText, setSrc, fmtTime, artistsText, syncClock, liveProgress,
  connectEvents, reconcile, makeBackground,
} from '../shared.js';

const $ = (id) => document.getElementById(id);
const setBg = makeBackground($('bg'));
let state = null;
setIcon($('coverPh'), 'music');

// ---------- toasts grandes ----------
function bigToast(t) {
  const host = $('bigToasts');
  const n = el('div', { class: `big-toast ${t.kind || ''}`, text: t.text });
  host.append(n);
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(() => { n.classList.add('out'); setTimeout(() => n.remove(), 450); }, 5200);
}

// ---------- pantalla completa y cursor ----------
let cursorTimer;
document.addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  $('fsHint').classList.add('gone');
});
document.addEventListener('mousemove', () => {
  document.body.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 4000);
});
setTimeout(() => $('fsHint').classList.add('gone'), 12000);

// ---------- anti quemado: mover un poco el QR ----------
function jiggle() {
  const x = (Math.random() * 2 - 1) * 2.2; const y = (Math.random() * 2 - 1) * 1.6;
  $('qrBlock').style.transform = `translate(${x}vh, ${y}vh)`;
}
setInterval(jiggle, 3 * 60 * 1000);

// ---------- render ----------
function render(st) {
  state = st; syncClock(st.serverNow);
  const active = st.party.active;
  renderPlayerNote(st, active);
  const sum = st.admin?.showSummary && st.admin.summary;
  // fiesta en marcha: el resumen es una franja bajo la vista normal; terminada: resumen a pantalla completa
  const band = active && !!sum;
  $('summary').hidden = !sum || active;
  if (sum) { renderSummary(st.admin.summary); renderSumNow(null); }
  if (band) renderBand(st.admin.summary);
  $('sumBand').hidden = !band;
  $('stage').classList.toggle('with-band', band);
  $('locked').hidden = true;
  $('idle').hidden = active || !!sum;
  $('stage').hidden = !active;
  if (!active) { setBg(null); return; }
  setText($('partyName'), st.party.name || '');

  const np = st.nowPlaying;
  const cover = $('cover');
  if (np) {
    setText($('npTitle'), np.name); setText($('npArtist'), artistsText(np.artists));
    if (np.image) { setSrc(cover, np.image); cover.hidden = false; } else cover.hidden = true;
    setBg(np.image || null);
    const by = $('npBy'); by.hidden = false;
    if (np.fromQueue) { by.className = 'chip big accent'; setText(by, `Pedida por ${np.fromQueue.addedBy.name}`); }
    else if (np.filler === 'classic') { by.className = 'chip big'; setText(by, 'Clásico de otras fiestas'); }
    else { by.className = 'chip big'; setText(by, 'Relleno: playlist del anfitrión'); }
    const lk = $('npLikes'); lk.hidden = !np.likes;
    if (lk.dataset.k !== String(np.likes)) { lk.dataset.k = String(np.likes); lk.replaceChildren(icon('heart'), String(np.likes || 0)); }
    setText($('tTotal'), fmtTime(np.durationMs));
    setText($('kickerText'), np.isPlaying ? 'Ahora suena' : 'En pausa');
  } else {
    setText($('npTitle'), 'Esperando la primera canción'); setText($('npArtist'), 'Escanea el código y pon algo');
    cover.hidden = true; $('npBy').hidden = true; $('npLikes').hidden = true; setBg(null); setText($('tTotal'), '0:00'); setText($('kickerText'), 'Ahora suena');
  }
  $('npEq').classList.toggle('paused', !(np && np.isPlaying));

  const q = st.queue.slice(0, 6);
  reconcile($('next'), q, (x) => x.qid, createItem, updateItem);
  $('nextEmpty').hidden = st.queue.length > 0;
  $('next').hidden = st.queue.length === 0;
  queueTotal = st.queue.length;

  const pin = st.admin?.pin;
  setText($('qrPin'), pin || '');
  setText($('qrUrl'), st.publicHost);
  const qr = $('qr'); const want = `../api/admin/qr.svg?pin=${pin}`;
  if (pin && qr.dataset.w !== want) { qr.dataset.w = want; qr.src = want; }
  updateOverflow();
  tick();
}

/** Aviso discreto cuando el reproductor falla; mismas frases que ven los invitados. */
function renderPlayerNote(st, active) {
  const status = st.player?.status;
  let msg = '';
  if (active) {
    if (status === 'rate_limited') msg = 'Spotify va saturado, un momento…';
    else if (['no_device', 'disconnected', 'not_configured', 'premium_required'].includes(status)) msg = 'La música está parada, avisando al anfitrión…';
  }
  const n = $('playerNote');
  setText(n, msg); n.hidden = !msg;
}

let queueTotal = 0;

/**
 * «A continuación» muestra solo las canciones que caben enteras y cuenta el resto en «y N más».
 * Se mide siempre con las 6 a la vista y la línea «más» reservada, y luego se ocultan las sobrantes.
 */
function updateOverflow() {
  const list = $('next'), more = $('nextMore');
  const items = [...list.children];
  if (!queueTotal || !items.length) { more.hidden = true; list.classList.remove('overflow'); return; }
  for (const li of items) li.hidden = false;
  // layout puro (offsetTop/offsetHeight): scrollHeight/getBoundingClientRect cuentan el translateY de la animación de entrada
  const fit = () => { let n = 0; for (const c of items) { if (c.offsetTop + c.offsetHeight <= list.clientHeight + 1) n++; else break; } return n; };
  // con la línea «más» reservada (si no hiciera falta, quitarla solo deja más sitio)
  more.hidden = false; setText(more, 'y 0 más en la cola');
  let visible = fit();
  if (visible >= items.length && queueTotal <= items.length) more.hidden = true;
  // ni una cabe entera: se deja la primera bajo la máscara en vez de una lista vacía
  const cut = visible === 0;
  if (cut) visible = 1;
  items.forEach((li, i) => { li.hidden = i >= visible; });
  const rest = queueTotal - visible;
  more.hidden = rest <= 0; if (rest > 0) setText(more, `y ${rest} más en la cola`);
  list.classList.toggle('overflow', cut);
}
window.addEventListener('resize', updateOverflow);

function renderSummary(s) {
  const n = (x) => String(x ?? 0);
  const pl = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  setText($('sumParty'), s.name || '');
  setText($('sumSongs'), n(s.songs)); setText($('sumLikes'), n(s.playLikes)); setText($('sumVotes'), n(s.queueLikes)); setText($('sumGuests'), n(s.joined));
  const song = s.songOfNight;
  $('sumSong').hidden = !song;
  if (song) {
    if (song.image) setSrc($('sumSongImg'), song.image);
    $('sumSongImg').hidden = !song.image;
    setText($('sumSongName'), song.name); setText($('sumSongArt'), artistsText(song.artists));
    setText($('sumSongMeta'), `${pl(song.playLikes, 'like', 'likes')} · ${pl(song.queueLikes, 'voto', 'votos')}${song.addedBy ? ' · la puso ' + song.addedBy : ''}`);
  }
  setText($('sumDj'), s.bestDj ? s.bestDj.name : 'Nadie todavía');
  setText($('sumDjMeta'), s.bestDj ? `${pl(s.bestDj.likes, 'like', 'likes')} · ${pl(s.bestDj.votes, 'voto', 'votos')}` : '');
  const top = $('sumTop'); top.replaceChildren();
  for (const t of s.top) top.append(el('li', {}, el('span', { class: 't ellipsis', text: `${t.name} · ${artistsText(t.artists)}` }), el('span', { class: 'v', title: `${pl(t.playLikes, 'like', 'likes')} · ${pl(t.queueLikes, 'voto', 'votos')}` }, icon('heart'), String(t.playLikes), icon('up'), String(t.queueLikes))));
  if (!s.top.length) top.append(el('li', { class: 'muted-t', text: 'Sin likes ni votos todavía' }));
}

/** Franja del resumen bajo la vista normal (top 3, sin barra «Ahora suena»: ya se ve arriba). */
function renderBand(s) {
  const n = (x) => String(x ?? 0);
  const pl = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  setText($('sbSongs'), n(s.songs)); setText($('sbLikes'), n(s.playLikes)); setText($('sbVotes'), n(s.queueLikes)); setText($('sbGuests'), n(s.joined));
  const song = s.songOfNight;
  $('sbSong').hidden = !song;
  if (song) {
    if (song.image) setSrc($('sbSongImg'), song.image);
    $('sbSongImg').hidden = !song.image;
    setText($('sbSongName'), song.name);
    setText($('sbSongBy'), song.addedBy ? `la puso ${song.addedBy}` : artistsText(song.artists));
    setText($('sbSongMeta'), `${pl(song.playLikes, 'like', 'likes')} · ${pl(song.queueLikes, 'voto', 'votos')}`);
  }
  setText($('sbDj'), s.bestDj ? s.bestDj.name : 'Nadie todavía');
  setText($('sbDjMeta'), s.bestDj ? `${pl(s.bestDj.likes, 'like', 'likes')} · ${pl(s.bestDj.votes, 'voto', 'votos')}` : '');
  const top = $('sbTop'); top.replaceChildren();
  for (const t of s.top.slice(0, 3)) top.append(el('li', {}, el('span', { class: 't ellipsis', text: t.name }), el('span', { class: 'v', title: `${pl(t.playLikes, 'like', 'likes')} · ${pl(t.queueLikes, 'voto', 'votos')}` }, icon('heart'), String(t.playLikes), icon('up'), String(t.queueLikes))));
  if (!s.top.length) top.append(el('li', { class: 'muted-t', text: 'Sin likes ni votos todavía' }));
}

/** Barra "Ahora suena" dentro del resumen, para no perder de vista la musica. */
function renderSumNow(np) {
  $('sumNow').hidden = !np;
  if (!np) return;
  const img = $('sumNowImg');
  if (np.image) { setSrc(img, np.image); img.hidden = false; } else img.hidden = true;
  setText($('sumNowTitle'), np.name); setText($('sumNowArtist'), artistsText(np.artists));
  setText($('sumNowKicker'), np.isPlaying ? 'Ahora suena' : 'En pausa');
  $('sumNowEq').classList.toggle('paused', !np.isPlaying);
  const by = $('sumNowBy');
  by.hidden = !np.fromQueue;
  if (np.fromQueue) { by.className = 'chip big accent'; setText(by, `Pedida por ${np.fromQueue.addedBy.name}`); }
}

function createItem() {
  return el('li', { class: 'n-item' },
    el('img', { alt: '' }),
    el('div', { class: 'n-main' }, el('div', { class: 'n-title ellipsis' }), el('div', { class: 'n-sub ellipsis' })),
    el('span', { class: 'n-votes' }));
}
function updateItem(li, q) {
  li.classList.toggle('fed', q.fed);
  setSrc(li.querySelector('img'), q.thumb || q.image);
  setText(li.querySelector('.n-title'), q.name);
  // una sola línea: artistas · de quién; el que ya va a sonar lo dice en su lugar
  setText(li.querySelector('.n-sub'), q.fed ? `Ya va a sonar · de ${q.addedBy.name}` : `${artistsText(q.artists)} · de ${q.addedBy.name}`);
  const v = li.querySelector('.n-votes');
  v.classList.toggle('zero', q.votes === 0);
  const k = String(q.votes);
  if (v.dataset.k !== k) { v.dataset.k = k; v.replaceChildren(icon('up'), String(q.votes)); }
  v.hidden = q.fed;
}

function tick() {
  if (!state?.nowPlaying) { $('barFill').style.transform = 'scaleX(0)'; $('sumNowBar').style.transform = 'scaleX(0)'; setText($('tNow'), '0:00'); return; }
  const np = state.nowPlaying;
  const ms = liveProgress(np, state.timeScale || 1);
  const frac = `scaleX(${np.durationMs ? Math.min(1, ms / np.durationMs) : 0})`;
  $('barFill').style.transform = frac;
  $('sumNowBar').style.transform = frac;
  setText($('tNow'), fmtTime(ms));
}
setInterval(tick, 250);

// ---------- arranque ----------
async function init() {
  try {
    await api('admin/status');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { $('locked').hidden = false; return; }
  }
  connectEvents({
    onState: render,
    onToast: bigToast,
    onStatus: () => {},
    onUnauthorized: () => { $('stage').hidden = true; $('locked').hidden = false; },
    probe: () => api('admin/status'),
  });
}
init();
