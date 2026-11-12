import {
  api, ApiError, el, icon, setIcon, setText, setSrc, fmtTime, fmtAgo, artistsText, syncClock, serverTime, setArtBy, liveProgress,
  toast, connectEvents, reconcile, safeStorage, makeBackground,
} from './shared.js';

const $ = (id) => document.getElementById(id);
const store = safeStorage();

let state = null;        // ultimo snapshot
let me = null;           // {id, name}
let events = null;
let sseOk = true;
let searchSeq = 0;
let lastResults = [];
let lastTerm = '';
let waitTimer = null;
const pendingAdd = new Map();   // trackId -> timestamp
const setBg = makeBackground($('bg'));

// ---------- iconos estaticos ----------
setIcon($('searchIco'), 'search');
setIcon($('qClear'), 'x');
setIcon($('emptyIco'), 'music');
setIcon($('coverPh'), 'music');

// ---------- vistas ----------
function show(view) {
  $('view-join').hidden = view !== 'join';
  $('view-main').hidden = view !== 'main';
  if (view === 'join') setBg(null);
}

function setJoinError(msg) {
  const e = $('joinError');
  e.hidden = !msg; e.textContent = msg || '';
  if (msg) { const f = $('joinForm'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); }
}

/**
 * Aviso de estado en la entrada (fin de fiesta, expulsion, sesion caducada, baneo). Fuera del formulario: se ve aunque no haya fiesta.
 * La region (role=status) esta siempre en el DOM y se oculta por CSS cuando esta vacia; el texto se escribe en el
 * siguiente frame para que los lectores de pantalla anuncien el cambio.
 */
function setJoinNotice(msg) {
  const n = $('joinNotice');
  n.textContent = '';
  if (msg) requestAnimationFrame(() => { n.textContent = msg; });
}

/**
 * Avisos del servidor que ve un invitado: solo los que le afectan.
 * Su cancion anadida o sonando (`by` = su id), salto por votacion y pausa/reanudar. Nada de "se ha unido"
 * ni de lo que anaden otros: con mucha gente era ruido constante y tapaba lo importante.
 */
const GUEST_TOAST_KINDS = new Set(['skip', 'control']);
function guestSeesToast(t) {
  if (!t || !t.text) return false;
  if (t.kind === 'add') return false; // el que añade ya recibe su confirmación con el puesto
  if (t.kind === 'now') return !!me && t.by === me.id;
  return GUEST_TOAST_KINDS.has(t.kind);
}

/** Baneado: la fiesta sigue en marcha, asi que ni formulario ni "no hay fiesta"; solo el aviso. */
function showBanned(msg) {
  clearInterval(waitTimer);
  show('join');
  setJoinError('');
  $('joinForm').hidden = true;
  $('joinClosed').hidden = true;
  setJoinNotice(msg || 'No puedes entrar a esta fiesta.');
}

async function showJoin(notice, farewell = null) {
  clearInterval(waitTimer);
  show('join');
  setJoinError('');
  // con despedida, el aviso "La fiesta ha terminado" sobra: lo dice la propia tarjeta
  setJoinNotice(farewell ? '' : notice || '');
  if (farewell) paintJoin({ active: false, farewell });
  let party = null;
  try { party = await api('party'); } catch { /* sin red */ }
  if (party || !farewell) paintJoin(party);
  waitTimer = setInterval(async () => {
    if ($('view-join').hidden) { clearInterval(waitTimer); return; }
    try { paintJoin(await api('party')); } catch { /* ignorar */ }
  }, 15000);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const likesVotes = (l, v) => `${plural(l, 'like', 'likes')} · ${plural(v, 'voto', 'votos')}`;

/** Tarjeta de despedida: resumen de la noche con los datos del propio invitado. Solo textContent, nunca innerHTML. */
function paintFarewell(f) {
  $('farewell').hidden = !f;
  const body = $('farewellBody');
  if (!f) { body.replaceChildren(); $('farewellParty').hidden = true; return; }
  setText($('farewellParty'), f.name || ''); $('farewellParty').hidden = !f.name;
  const sec = (title, ...kids) => el('div', { class: 'fw-sec' }, el('h3', { class: 'fw-h', text: title }), ...kids);
  const parts = [];
  const s = f.songOfNight;
  if (s) {
    const img = el('img', { class: 'fw-cover', alt: '', width: '64', height: '64' });
    setSrc(img, s.image);
    parts.push(sec('Canción de la noche', el('div', { class: 'fw-song' },
      s.image ? img : null,
      el('div', { class: 'fw-song-t' },
        el('p', { class: 'fw-big', text: s.name }),
        el('p', { class: 'fw-sub', text: artistsText(s.artists) }),
        s.addedBy ? el('p', { class: 'fw-sub', text: `la puso ${s.addedBy}` }) : null,
        el('p', { class: 'fw-meta', text: likesVotes(s.likes, s.votes) })))));
  }
  if (f.dj) parts.push(sec('DJ de la noche', el('p', { class: 'fw-big', text: f.dj.name }), el('p', { class: 'fw-meta', text: likesVotes(f.dj.likes, f.dj.votes) })));
  const m = f.mine;
  if (m) {
    parts.push(sec('Tu noche', m.songs
      ? [el('p', { class: 'fw-big', text: `Pusiste ${plural(m.songs, 'canción', 'canciones')}` }),
        el('p', { class: 'fw-meta', text: likesVotes(m.likes, m.votes) }),
        m.best ? el('p', { class: 'fw-sub', text: `La que más gustó: ${m.best.name}` }) : null]
      : el('p', { class: 'fw-big', text: 'Esta vez no pusiste canciones' })));
  }
  body.replaceChildren(...parts);
}

function paintJoin(party) {
  const active = !!party?.active;
  paintFarewell(!active && party?.farewell ? party.farewell : null);
  $('joinClosed').hidden = active;
  $('joinForm').hidden = !active;
  const jp = $('joinParty');
  jp.replaceChildren();
  if (active && party.name) jp.append('Estás invitado a ', el('strong', { text: party.name }));
}

$('pin').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('pin').value.trim(); const name = $('name').value.trim();
  if (!/^\d{4}$/.test(pin)) return setJoinError('El PIN son 4 números.');
  if (!name) return setJoinError('Escribe tu nombre.');
  setJoinError('');
  const btn = $('joinBtn'); btn.disabled = true; btn.textContent = 'Entrando…';
  try {
    const r = await api('join', { method: 'POST', body: { pin, name } });
    me = r.guest;
    store.set('fiesta.name', name);
    enterMain();
  } catch (err) {
    if (err.code === 'banned') { showBanned(err.message); return; }
    setJoinError(err.message);
    if (err.code === 'no_party') showJoin(err.message);
  } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
});

function enterMain() {
  clearInterval(waitTimer);
  show('main');
  state = null;
  events?.close();
  events = connectEvents({
    path: 'events?view=guest',
    onState: render,
    onToast: (t) => { if (guestSeesToast(t)) toast(t.text, t.kind); },
    onStatus: (s) => { sseOk = s === 'open'; updateBanner(); },
    onKicked: async () => {
      if (state && !state.party.active) return;
      me = null;
      // el servidor usa el mismo evento para expulsar y para banear: preguntar cual ha sido
      try { await api('me'); } catch (e) { if (e instanceof ApiError && e.code === 'banned') { showBanned(e.message); return; } }
      showJoin('El anfitrión te ha sacado de la fiesta.');
    },
    onUnauthorized: () => { me = null; showJoin('Tu sesión ha caducado. Vuelve a entrar con el PIN.'); },
    probe: () => api('me'),
  });
}

// ---------- render ----------
function render(st) {
  state = st;
  syncClock(st.serverNow);
  if (!st.party.active) { events?.close(); me = null; showJoin('La fiesta ha terminado. ¡Gracias por venir!', st.farewell || null); return; }
  if (!st.me) { events?.close(); me = null; showJoin('Tu sesión ha caducado. Vuelve a entrar con el PIN.'); return; }
  me = { id: st.me.id, name: st.me.name };
  for (const [id, t] of pendingAdd) if (st.queue.some((q) => q.trackId === id) || Date.now() - t > 4000) pendingAdd.delete(id);

  setText($('partyName'), st.party.name || '');
  const meBtn = $('meBtn');
  if (!meBtn.firstChild) meBtn.append(icon('user', 'sm'), el('span'));
  setText(meBtn.querySelector('span'), st.me.name);

  renderNow(st);
  renderControls();
  renderQuota();
  renderQueue(st);
  renderHistory(st);
  updateBanner();
  if (!$('results').hidden) renderResults();
  tick();
}

function renderNow(st) {
  const np = st.nowPlaying;
  const cover = $('cover');
  const own = !!(np && np.fromQueue && np.fromQueue.addedBy.id === st.me.id);
  document.querySelector('.np').classList.toggle('mine', own);
  setText($('npKicker'), own ? '¡Suena tu canción!' : 'Ahora suena');
  if (np) {
    setText($('npTitle'), np.name); setText($('npArtist'), artistsText(np.artists));
    if (np.image) { setSrc(cover, np.image); cover.hidden = false; } else cover.hidden = true;
    setBg(np.image || null);
    const by = $('npBy'); by.hidden = false;
    if (own) { by.className = 'chip accent'; setText(by, 'La has pedido tú'); }
    else if (np.fromQueue) { by.className = 'chip accent'; setText(by, `Pedida por ${np.fromQueue.addedBy.name}`); }
    else { by.className = 'chip'; setText(by, 'Relleno: playlist del anfitrión'); }
    setText($('tTotal'), fmtTime(np.durationMs));
  } else {
    setText($('npTitle'), 'Nada suena todavía'); setText($('npArtist'), 'Añade una canción a la cola');
    cover.hidden = true; $('npBy').hidden = true; setBg(null);
    setText($('tTotal'), '0:00');
  }
  $('pausedBadge').hidden = !(np && !np.isPlaying);
  $('npEq').classList.toggle('paused', !(np && np.isPlaying));
}

let busy = false;
let prevLike = { id: null, n: 0 }; let popTimer = 0;
function renderControls() {
  if (!state?.me) return;
  const st = state; const np = st.nowPlaying; const s = st.settings;
  const bp = $('btnPause'); const bs = $('btnSkip');
  const playing = !!(np && np.isPlaying);
  const cd = cooldownLeft();
  const controlsDown = st.player.status !== 'ok' && st.player.status !== 'rate_limited';

  const bl = $('btnLike');
  const own = !!(np && np.fromQueue && np.fromQueue.addedBy.id === st.me.id);
  const liked = !!(np && np.liked);
  bl.hidden = !np;
  if (np) {
    const likes = np.likes || 0;
    if (own && prevLike.id === np.trackId && likes > prevLike.n) {
      bl.classList.add('pop'); clearTimeout(popTimer); popTimer = setTimeout(() => bl.classList.remove('pop'), 500);
    }
    prevLike = { id: np.trackId, n: likes };
    bl.classList.toggle('own', own);
    const key = `${np.likes}|${liked}|${own}`;
    if (bl.dataset.k !== key) {
      bl.dataset.k = key;
      bl.replaceChildren(icon('heart'), el('span', { class: 'lbl', text: String(np.likes || 0) }));
    }
    bl.classList.toggle('on', liked);
    bl.setAttribute('aria-pressed', String(liked));
    bl.disabled = own;
    bl.title = own ? 'Los likes que recibe tu canción' : liked ? 'Quitar me gusta' : 'Me gusta esta canción';
    bl.setAttribute('aria-label', own ? `Likes a tu canción: ${likes}` : `${bl.title} (${likes})`);
  }
  // sin boton de pausa si solo pausa el anfitrion (o si el iPhone no deja pausar desde aqui)
  bp.hidden = !!st.player.isIphone || s.pauseMode === 'admin';
  bp.replaceChildren(icon(playing ? 'pause' : 'play'), el('span', { class: 'lbl', text: playing ? 'Pausa' : 'Seguir' }));
  bp.disabled = busy || !np || controlsDown;
  bp.classList.toggle('primary', !playing && !!np);
  bp.classList.toggle('subtle', playing);

  bs.hidden = s.skipMode === 'admin';
  $('controls').hidden = bp.hidden && bs.hidden;
  bs.classList.remove('voted');
  if (s.skipMode === 'vote') {
    const voted = st.me.skipVoted;
    const votes = np ? np.skipVotes : 0; const needed = np ? np.skipNeeded : 0;
    bs.replaceChildren(icon('skip'), el('span', { class: 'lbl', text: voted ? `Votado ${votes}/${needed}` : `Saltar ${votes}/${needed}` }));
    bs.classList.toggle('voted', voted);
    bs.disabled = busy || !np || controlsDown;
  } else if (s.skipMode === 'direct') {
    bs.replaceChildren(icon('skip'), el('span', { class: 'lbl', text: 'Saltar' }));
    bs.disabled = busy || !np || controlsDown || cd > 0;
  }
  const note = $('ctrlNote');
  const needCd = cd > 0 && (s.pauseMode === 'direct' || s.skipMode === 'direct');
  note.hidden = !needCd;
  if (needCd) setText(note, `Espera ${cd} s para volver a usar los controles`);
  if (needCd) { bp.disabled = bp.disabled || (s.pauseMode === 'direct' && cd > 0); }
}

function cooldownLeft() {
  if (!state?.me) return 0;
  return Math.max(0, Math.ceil((state.me.controlCooldownUntil - serverTime()) / 1000));
}
function addCooldownLeft() {
  if (!state?.me) return 0;
  return Math.max(0, Math.ceil((state.me.addCooldownUntil - serverTime()) / 1000));
}

async function control(fn) {
  if (busy) return;
  busy = true; renderControls();
  try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { busy = false; if (state) renderControls(); }
}
let likeBusy = false;
$('btnLike').addEventListener('click', async () => {
  const np = state?.nowPlaying;
  if (!np || likeBusy) return;
  likeBusy = true;
  const on = !np.liked;
  np.liked = on; np.likes = (np.likes || 0) + (on ? 1 : -1);   // optimista
  const b = $('btnLike');
  renderControls();
  if (on) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  try {
    const r = await api('nowplaying/like', { method: on ? 'POST' : 'DELETE' });
    if (state?.nowPlaying && state.nowPlaying.trackId === np.trackId) { state.nowPlaying.liked = r.liked; state.nowPlaying.likes = r.likes; renderControls(); }
  } catch (e) {
    toast(e.message, 'error');
    if (state?.nowPlaying) { state.nowPlaying.liked = !on; state.nowPlaying.likes += on ? -1 : 1; renderControls(); }
  } finally { likeBusy = false; }
});
$('btnPause').addEventListener('click', () => control(async () => {
  const playing = state.nowPlaying?.isPlaying;
  await api(playing ? 'control/pause' : 'control/resume', { method: 'POST' });
}));
$('btnSkip').addEventListener('click', () => control(async () => {
  const s = state.settings;
  if (s.skipMode === 'vote' && state.me.skipVoted) {
    await api('control/skip', { method: 'DELETE' });
    toast('Has retirado tu voto', 'info', 1800);
  } else {
    const r = await api('control/skip', { method: 'POST' });
    if (s.skipMode === 'vote' && !r.skipped) toast(`Voto registrado (${r.votes}/${r.needed})`, 'ok', 2200);
  }
}));

function renderQuota() {
  const q = $('quota'); const st = state;
  if (!st?.me) return;
  q.replaceChildren();
  if (!st.settings.allowAdd) { q.append('La cola está cerrada por ahora.'); return; }
  const n = st.me.quota;
  if (n <= 0) q.append('Has llegado a tu límite. Cuando suene alguna de tus canciones podrás añadir más.');
  else q.append('Tu cupo: te ', n === 1 ? 'queda ' : 'quedan ', el('b', { text: String(n) }), n === 1 ? ' canción' : ' canciones');
}

// ---------- cola ----------
let queuePos = new Map(); // qid -> puesto (1 = la siguiente)

// ---------- ayuda «Cómo funciona» ----------
const HELP_KEY = 'fiesta.help.seen';
let helpOpen = null;   // null = aun sin decidir en esta carga

function setHelp(open) {
  helpOpen = open;
  $('helpCard').hidden = !open;
  $('helpBtn').setAttribute('aria-expanded', String(open));
}
$('helpBtn').addEventListener('click', () => setHelp(!helpOpen));
$('helpClose').addEventListener('click', () => {
  try { store.set(HELP_KEY, '1'); } catch { /* sin almacenamiento */ }
  setHelp(false);
  $('helpBtn').focus();
});

function renderHelp(st) {
  if (helpOpen === null) {
    let seen = false;
    try { seen = !!store.get(HELP_KEY); } catch { /* */ }
    setHelp(!seen);
  }
  const s = st.settings || {};
  const lines = [];
  lines.push(s.ordering === 'fifo' ? 'La cola va por orden de llegada' : '↑ Vota una canción para que suene antes');
  if (s.skipMode === 'vote') {
    const n = st.skipNeeded;
    lines.push(n ? `Saltar: ${n === 1 ? 'hace' : 'hacen'} falta ${plural(n, 'voto', 'votos')}` : 'Saltar: hacen falta votos de la gente');
  } else if (s.skipMode === 'direct') lines.push('Cualquiera puede saltar la canción');
  if (s.maxQueuedPerGuest) lines.push(`Puedes tener ${plural(s.maxQueuedPerGuest, 'canción', 'canciones')} a la vez en la cola`);
  if (s.pauseMode === 'direct') lines.push('Cualquiera puede pausar la música');
  const ul = $('helpList');
  const cur = [...ul.children].map((li) => li.textContent);
  if (cur.length === lines.length && cur.every((t, i) => t === lines[i])) return;
  ul.replaceChildren(...lines.map((t) => el('li', {}, t)));
}

function renderQueue(st) {
  renderHelp(st);
  const list = $('queue');
  queuePos = new Map(st.queue.map((q, i) => [q.qid, i + 1]));
  reconcile(list, st.queue, (q) => q.qid, createQueueItem, updateQueueItem);
  setText($('queueCount'), String(st.queue.length));
  $('queueEmpty').hidden = st.queue.length > 0;
  list.hidden = st.queue.length === 0;
}

function createQueueItem() {
  const vote = el('button', { class: 'vote', type: 'button' });
  const del = el('button', { class: 'icon-btn del', type: 'button', 'aria-label': 'Quitar mi canción' }, icon('trash'));
  const li = el('li', { class: 'q-item fresh' },
    el('img', { class: 'q-cover', alt: '', loading: 'lazy' }),
    el('div', { class: 'q-main' }, el('div', { class: 'q-title ellipsis' }), el('div', { class: 'q-sub ellipsis' }), el('div', { class: 'q-by ellipsis' })),
    el('div', { class: 'q-actions' }, vote, del));
  vote.addEventListener('click', () => toggleVote(li.dataset.key, vote));
  del.addEventListener('click', async () => {
    del.disabled = true;
    try { await api(`queue/${encodeURIComponent(li.dataset.key)}`, { method: 'DELETE' }); }
    catch (e) { toast(e.message, 'error'); del.disabled = false; }
  });
  setTimeout(() => li.classList.remove('fresh'), 600);
  return li;
}

function updateQueueItem(li, q) {
  li.classList.toggle('fed', q.fed);
  setSrc(li.querySelector('.q-cover'), q.thumb || q.image);
  const title = li.querySelector('.q-title');
  const tt = (q.explicit ? 'E ' : '') + q.name;
  if (title.dataset.t !== tt) {
    title.dataset.t = tt; title.replaceChildren();
    if (q.explicit) title.append(el('span', { class: 'tag-e', text: 'E', title: 'Explícita' }));
    title.append(q.name);
  }
  setText(li.querySelector('.q-sub'), artistsText(q.artists));
  const by = li.querySelector('.q-by');
  const pos = queuePos.get(q.qid) || 0;
  const ownWaiting = q.mine && !q.fed;
  by.classList.toggle('own', ownWaiting);
  setText(by, q.fed ? `Ya va a sonar · de ${q.addedBy.name}`
    : ownWaiting ? (pos === 1 ? 'Tu canción · la siguiente' : `Tu canción · n.º ${pos}`)
    : `de ${q.addedBy.name}`);
  const vote = li.querySelector('.vote');
  vote.classList.toggle('on', q.voted);
  vote.disabled = q.mine || q.fed;
  vote.setAttribute('aria-pressed', String(q.voted));
  const voteLabel = q.fed ? 'Ya va a sonar: no se puede votar ni quitar' : q.mine ? 'Votos a tu canción' : q.voted ? 'Quitar mi voto' : 'Votar para que suene antes';
  vote.setAttribute('aria-label', voteLabel);
  vote.title = voteLabel;
  if (vote.dataset.v !== `${q.votes}|${q.fed}`) {
    vote.dataset.v = `${q.votes}|${q.fed}`;
    vote.replaceChildren(icon(q.fed ? 'lock' : 'up', 'sm'), el('span', { text: q.fed ? '' : String(q.votes) }));
  }
  li.querySelector('.del').hidden = !(q.mine && !q.fed);
}

async function toggleVote(qid, btn) {
  const q = state.queue.find((x) => x.qid === qid);
  if (!q) return;
  const on = !q.voted;
  q.voted = on; q.votes += on ? 1 : -1;      // optimista
  btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
  updateQueueItem(btn.closest('.q-item'), q);
  try { await api(`queue/${encodeURIComponent(qid)}/vote`, { method: on ? 'POST' : 'DELETE' }); }
  catch (e) { toast(e.message, 'error'); }
}

function renderHistory(st) {
  const ul = $('historyList');
  const items = st.history.slice(0, 20);
  $('historyEmpty').hidden = items.length > 0;
  ul.replaceChildren(...items.map((h) => el('li', { class: 'hist' },
    el('img', { class: 'h-cover', alt: '', loading: 'lazy', src: h.image || null }),
    el('div', { class: 'q-main' },
      el('div', { class: 'q-title ellipsis', text: h.name }),
      (() => { const d = el('div', { class: 'q-sub' }); setArtBy(d, artistsText(h.artists), h.addedBy ? ` · de ${h.addedBy}` : ''); return d; })()),
    el('span', { class: 'muted small', style: { padding: 0 }, text: fmtAgo(h.playedAt) }))));
}

function updateBanner() {
  const b = $('banner');
  if (!state) { b.hidden = true; return; }
  const status = state.player.status;
  let msg = null; let cls = '';
  if (!sseOk) { msg = 'Reconectando…'; cls = 'info'; }
  else if (status === 'rate_limited') msg = 'Spotify va saturado, un momento…';
  else if (['no_device', 'disconnected', 'not_configured', 'premium_required'].includes(status)) msg = 'La música está parada, avisando al anfitrión…';
  b.hidden = !msg; b.className = 'banner ' + cls;
  b.replaceChildren();
  if (msg) b.append(!sseOk ? el('span', { class: 'spinner' }) : icon('alert', 'sm'), msg);
}

// ---------- progreso y cuentas atras (sin ticks desde el servidor) ----------
function tick() {
  if (!state || document.hidden) return;
  const np = state.nowPlaying;
  if (np) {
    const ms = liveProgress(np, state.timeScale || 1);
    $('barFill').style.transform = `scaleX(${np.durationMs ? Math.min(1, ms / np.durationMs) : 0})`;
    setText($('tNow'), fmtTime(ms));
  } else { $('barFill').style.transform = 'scaleX(0)'; setText($('tNow'), '0:00'); }
  const cd = cooldownLeft();
  if (cd !== lastCd) { lastCd = cd; renderControls(); }
  if (!$('results').hidden) updateResultButtons();
}
let lastCd = 0;
setInterval(tick, 250);

// ---------- busqueda ----------
const qInput = $('q');
let debounce = null;
// La X es la única forma visible de cerrar: sale con texto o con resultados abiertos.
function syncClear() { $('qClear').hidden = !qInput.value && $('results').hidden; }
qInput.addEventListener('input', () => {
  syncClear();
  clearTimeout(debounce);
  const term = qInput.value.trim();
  if (term.length < 2) { searchSeq++; closeResults(); return; }
  debounce = setTimeout(() => doSearch(term), 350);
});
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { qInput.value = ''; closeResults(); }
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(debounce); const t = qInput.value.trim(); if (t.length >= 2) doSearch(t); qInput.blur(); }
});
$('qClear').addEventListener('click', () => { qInput.value = ''; closeResults(); qInput.focus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('results').hidden) closeResults(); });
document.addEventListener('pointerdown', (e) => {
  if (!$('results').hidden && !$('searchWrap').contains(e.target)) closeResults();
});

function closeResults() { $('results').hidden = true; $('results').style.maxHeight = ''; searchSeq++; releaseSearchSpace(); syncClear(); }

// Con una mano y el teclado abierto: el buscador sube arriba y los resultados caben sobre el teclado.
function scrollSearchToTop() {
  // el ancla marca el hueco natural del buscador; se suma su margen superior para dejarlo pegado arriba
  const top = $('searchAnchor').getBoundingClientRect().top + window.scrollY + (parseFloat(getComputedStyle($('searchWrap')).marginTop) || 0);
  // ya está fijo arriba (cola desplazada): no se mueve la página para no hacer perder el sitio
  if (Math.abs($('searchWrap').getBoundingClientRect().top) < 2) return;
  // con poca cola la página no es lo bastante alta para subir el buscador: se añade el espacio que falte
  const main = $('view-main');
  const have = parseFloat(main.style.marginBottom) || 0;
  const need = top + window.innerHeight - (document.documentElement.scrollHeight - have);
  main.style.marginBottom = need > 0 ? Math.ceil(need) + 'px' : '';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
}
qInput.addEventListener('focus', () => { scrollSearchToTop(); setTimeout(scrollSearchToTop, 60); });
// el espacio extra se quita al terminar: resultados cerrados y buscador sin foco
function releaseSearchSpace() {
  if ($('results').hidden && document.activeElement !== qInput) $('view-main').style.marginBottom = '';
}
qInput.addEventListener('blur', releaseSearchSpace);

function fitResults() {
  const box = $('results');
  if (box.hidden) return;
  const vv = window.visualViewport;
  const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const searchBottom = $('searchWrap').querySelector('.search').getBoundingClientRect().bottom;
  box.style.maxHeight = Math.max(140, visibleBottom - searchBottom - 12) + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitResults);
  window.visualViewport.addEventListener('scroll', fitResults);
}
window.addEventListener('resize', fitResults);

async function doSearch(term) {
  const seq = ++searchSeq; lastTerm = term;
  const box = $('results'); box.hidden = false; syncClear(); fitResults();
  setText($('resultsInfo'), 'Buscando…');
  $('resultsList').replaceChildren(el('li', { class: 'res-loading' }, el('span', { class: 'spinner' })));
  try {
    const r = await api(`search?q=${encodeURIComponent(term)}`);
    if (seq !== searchSeq) return;
    lastResults = r.results; renderResults();
  } catch (e) {
    if (seq !== searchSeq) return;
    setText($('resultsInfo'), 'No se pudo buscar');
    const retry = el('button', { class: 'btn btn-sm', type: 'button', text: 'Reintentar' });
    retry.addEventListener('click', () => doSearch(term));
    $('resultsList').replaceChildren(el('li', { class: 'res-empty' }, el('p', { text: e.message }), retry));
  }
}

function resultState(t) {
  const st = state;
  if (!st?.me) return { kind: 'no', note: '' };
  if (pendingAdd.has(t.trackId) || st.queue.some((q) => q.trackId === t.trackId)) return { kind: 'done', note: 'Ya en la cola' };
  if (t.blocked === 'explicit') return { kind: 'no', note: 'No se admiten explícitas' };
  if (t.blocked === 'long') return { kind: 'no', note: `Dura más de ${st.settings.maxDurationMin} min` };
  if (t.recentlyPlayed) return { kind: 'no', note: 'Sonó hace poco' };
  if (!st.settings.allowAdd) return { kind: 'no', note: 'Cola cerrada' };
  if (st.me.quota <= 0) return { kind: 'no', note: 'Límite alcanzado' };
  const cd = addCooldownLeft();
  if (cd > 0) return { kind: 'wait', note: '', cd };
  return { kind: 'add', note: '' };
}

function renderResults() {
  if (!state) return;
  setText($('resultsInfo'), lastResults.length ? `${lastResults.length} ${lastResults.length === 1 ? "resultado" : "resultados"}` : 'Sin resultados');
  const ul = $('resultsList');
  if (!lastResults.length) { ul.replaceChildren(el('li', { class: 'res-empty', text: `Nada para "${lastTerm}". Prueba con otra búsqueda.` })); return; }
  ul.replaceChildren(...lastResults.map((t) => {
    const btn = el('button', { class: 'add-btn', type: 'button' });
    btn.addEventListener('click', () => addTrack(t, btn));
    const note = el('div', { class: 'res-note' });
    const li = el('li', { class: 'res', dataset: { id: t.trackId } },
      el('img', { alt: '', loading: 'lazy', src: t.thumb || t.image || null }),
      el('div', { class: 'res-main' },
        el('div', { class: 'res-title ellipsis' }, t.explicit ? el('span', { class: 'tag-e', text: 'E', title: 'Explícita' }) : null, t.name),
        el('div', { class: 'res-sub ellipsis', text: `${artistsText(t.artists)} · ${fmtTime(t.durationMs)}` }),
        note),
      btn);
    li._t = t; li._btn = btn; li._note = note;
    return li;
  }));
  updateResultButtons();
}

function updateResultButtons() {
  for (const li of $('resultsList').children) {
    if (!li._t) continue;
    const s = resultState(li._t); const btn = li._btn;
    const key = s.kind + (s.cd || '');
    if (btn.dataset.k === key) continue;
    btn.dataset.k = key;
    btn.disabled = s.kind !== 'add';
    btn.classList.toggle('done', s.kind === 'done');
    btn.setAttribute('aria-label', s.kind === 'add' ? `Añadir ${li._t.name}` : s.note || 'Espera');
    if (s.kind === 'add') btn.replaceChildren(icon('plus'));
    else if (s.kind === 'done') btn.replaceChildren(icon('check'));
    else if (s.kind === 'wait') btn.replaceChildren(el('span', { class: 'cd', text: `${s.cd}s` }));
    else btn.replaceChildren(icon('lock', 'sm'));
    setText(li._note, s.note);
  }
}

async function addTrack(t, btn) {
  btn.disabled = true;
  try {
    const r = await api('queue', { method: 'POST', body: { uri: t.uri } });
    const n = r?.position || 0;
    toast(n === 1 ? 'Añadida · suena la siguiente' : n > 1 ? `Añadida · va la ${n}.ª` : 'Añadida a la cola', 'ok');
    pendingAdd.set(t.trackId, Date.now());
    btn.classList.add('pop');
    updateResultButtons();
  } catch (e) {
    toast(e.message, 'error');
    btn.dataset.k = ''; btn.disabled = false; updateResultButtons();
  }
}

// ---------- cambiar nombre ----------
const dlg = $('renameDlg');
$('meBtn').addEventListener('click', () => {
  $('renameInput').value = me?.name || ''; $('renameError').hidden = true;
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  $('renameInput').select();
});
$('renameCancel').addEventListener('click', () => dlg.close());
$('renameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('renameInput').value.trim();
  if (!name) return;
  try {
    const r = await api('join', { method: 'POST', body: { pin: '', name } });
    me = r.guest; store.set('fiesta.name', r.guest.name);
    toast('Nombre cambiado', 'ok', 1800);
    dlg.close();
  } catch (err) { setText($('renameError'), err.message); $('renameError').hidden = false; }
});

// ---------- arranque ----------
async function init() {
  const params = new URLSearchParams(location.search);
  const p = params.get('p');
  if (p) { $('pin').value = p.replace(/\D/g, '').slice(0, 4); history.replaceState(null, '', location.pathname); }
  const saved = store.get('fiesta.name'); if (saved) $('name').value = saved;
  let meRes = null;
  try { meRes = await api('me'); } catch (e) { if (e instanceof ApiError && e.code === 'banned') { showBanned(e.message); return; } }
  if (meRes) { me = meRes.guest; enterMain(); return; }
  await showJoin();
  if ($('pin').value.length === 4) $('name').focus(); else $('pin').focus({ preventScroll: true });
}
init();
