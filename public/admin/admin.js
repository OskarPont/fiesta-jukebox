import {
  api, ApiError, el, icon, setIcon, setText, setSrc, fmtTime, fmtAgo, artistsText, syncClock,
  toast, connectEvents, reconcile, copyText, BASE, applyTint,
} from '../shared.js';

const $ = (id) => document.getElementById(id);
let st = null;               // ultimo snapshot
let events = null;
let devices = null;          // lista de dispositivos (o null si no cargada)
let devicesError = '';
let dragging = false;
let pendingState = null;

setIcon($('logout'), 'logout'); $('logout').append(el('span', { class: 'lbl', text: 'Salir' }));
$('openScreen').append(icon('expand', 'sm'), el('span', { class: 'lbl', text: 'Abrir pantalla' }));
// atajo al PIN y al QR: con la fiesta en marcha la tarjeta «Fiesta» ya no va la primera
$('pinJump').addEventListener('click', () => {
  const target = cards.party.root;
  target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
});

// ---------- helpers de UI ----------
function run(btn, fn, { okMsg } = {}) {
  return async (ev) => {
    ev?.preventDefault?.();
    if (btn.disabled) return;
    btn.disabled = true;
    try { const r = await fn(); if (okMsg) toast(okMsg, 'ok', 2000); return r; }
    catch (e) { toast(e.message || 'Algo ha fallado', 'error', 5000); }
    finally { btn.disabled = false; }
  };
}
function button(label, { cls = '', ico, onclick, title } = {}) {
  const b = el('button', { class: `btn ${cls}`, type: 'button', title }, ico ? icon(ico, 'sm') : null, label ? el('span', { text: label }) : null);
  if (onclick) b.addEventListener('click', run(b, onclick));
  return b;
}
/** Boton destructivo: pide segundo clic. */
function confirmButton(label, { ico, cls = 'btn-danger', ask = '¿Seguro?', onclick } = {}) {
  const b = el('button', { class: `btn ${cls}`, type: 'button' }, ico ? icon(ico, 'sm') : null, el('span', { text: label }));
  let armed = null;
  b.addEventListener('click', async () => {
    if (!armed) {
      b.querySelector('span').textContent = ask;
      armed = setTimeout(() => { armed = null; b.querySelector('span').textContent = label; }, 3000);
      return;
    }
    clearTimeout(armed); armed = null; b.querySelector('span').textContent = label;
    b.disabled = true;
    try { await onclick(); } catch (e) { toast(e.message, 'error', 5000); } finally { b.disabled = false; }
  });
  return b;
}
function card(title, id) {
  const sub = el('span', { class: 'sub' });
  const body = el('div', { class: 'stack' });
  const root = el('section', { class: 'card acard', id, tabindex: '-1', 'aria-labelledby': `${id}-h` }, el('header', {}, el('h2', { id: `${id}-h`, text: title }), sub), body);
  return { root, body, sub };
}
function seg(options, onChange) {
  const wrap = el('div', { class: 'seg', role: 'group' });
  const btns = options.map(([value, label]) => {
    const b = el('button', { type: 'button', 'aria-pressed': 'false', text: label, dataset: { v: value } });
    b.addEventListener('click', () => onChange(value));
    wrap.append(b); return b;
  });
  return { el: wrap, set(v) { for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.v === String(v))); } };
}
function chip(text, cls = '') { return el('span', { class: `chip ${cls}`, text }); }

// ---------- login ----------
function showLogin(msg) {
  events?.close(); events = null; st = null;
  $('dash').hidden = true; $('login').hidden = false;
  const e = $('loginError'); e.hidden = !msg; e.textContent = msg || '';
  $('key').focus();
}
$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('admin/login', { method: 'POST', body: { key: $('key').value } });
    $('key').value = '';
    start();
  } catch (e) { const er = $('loginError'); er.hidden = false; er.textContent = e.message; }
});
$('logout').addEventListener('click', async () => {
  try { await api('admin/logout', { method: 'POST' }); } catch { /* ignorar */ }
  showLogin();
});

// =====================================================================
// TARJETAS
// =====================================================================
const cards = {};

// ---------- Spotify ----------
cards.spotify = (() => {
  const c = card('Spotify', 'card-spotify');
  const status = el('div', { class: 'row' });
  const guide = el('div', { class: 'stack' });
  const connectRow = el('div', { class: 'btns' });
  const credsForm = el('div', { class: 'stack' });
  const idIn = el('input', { class: 'input', placeholder: 'Client ID', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Client ID' });
  const secIn = el('input', { class: 'input', placeholder: 'Client Secret', autocomplete: 'off', spellcheck: 'false', type: 'password', 'aria-label': 'Client Secret' });
  const saveBtn = button('Guardar credenciales', { cls: 'btn-primary', onclick: async () => {
    await api('admin/spotify/credentials', { method: 'POST', body: { clientId: idIn.value, clientSecret: secIn.value } });
    idIn.value = ''; secIn.value = '';
    toast('Credenciales guardadas. Ahora pulsa "Conectar Spotify".', 'ok', 4000);
  } });
  credsForm.append(
    el('label', { class: 'field' }, el('span', { text: 'Client ID' }), idIn),
    el('label', { class: 'field' }, el('span', { text: 'Client secret' }), secIn),
    saveBtn);
  const credsFold = el('details', { class: 'fold' }, el('summary', { text: 'Credenciales de la app de Spotify' }), el('div', { class: 'stack' }, credsForm));
  const note = el('p', { class: 'hint', text: 'Durante la fiesta no añadas canciones a la cola desde la app de Spotify: las de los invitados irían detrás de las tuyas.' });
  c.body.append(status, guide, connectRow, credsFold, note);

  let guideBuilt = false;
  function buildGuide(uri) {
    guide.replaceChildren(
      el('p', { class: 'hint', text: 'Para que fiesta. controle tu Spotify hay que crear una app en el panel de desarrolladores (solo se hace una vez):' }),
      el('ol', { class: 'guide' },
        el('li', {}, 'Entra en ', el('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener', text: 'developer.spotify.com/dashboard' }), ' con tu cuenta Premium y pulsa "Create app".'),
        el('li', {}, 'Nombre: ', el('code', { text: 'fiesta' }), '. Descripción: lo que quieras. API: marca ', el('b', { text: 'Web API' }), '.'),
        el('li', {}, 'En "Redirect URI" pega esta dirección exacta y pulsa "Add":'),
      ),
      el('div', { class: 'uri-row' }, el('span', { class: 'uri', text: uri }),
        button('Copiar', { cls: 'btn-sm', ico: 'copy', onclick: async () => { await copyText(uri); toast('Copiado', 'ok', 1500); } })),
      el('ol', { class: 'guide', start: '4' },
        el('li', { text: 'Acepta los términos y guarda. Abre "Settings" de la app y copia el Client ID y el Client secret.' }),
        el('li', { text: 'Pégalos aquí abajo, guarda y pulsa "Conectar Spotify".' }),
      ));
  }

  return {
    root: c.root,
    update(s) {
      const sp = s.admin.spotify;
      status.replaceChildren();
      const left = el('div', { class: 'stack', style: { gap: '6px', alignItems: 'flex-start' } });
      if (sp.mock) left.append(chip('Modo de prueba (mock)', 'warn'));
      if (!sp.configured) left.append(chip('Sin credenciales', 'warn'));
      else if (!sp.connected) left.append(chip('Sin conectar', 'danger'));
      else left.append(chip(`Conectado${sp.userName ? ' como ' + sp.userName : ''}`, 'ok'));
      if (sp.connected && sp.authorizedAt) {
        const when = new Date(sp.expiresAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
        left.append(el('span', { class: 'hint', text: `La conexión caduca el ${when} (${sp.daysLeft} días). Hay que reconectar antes.` }));
      }
      status.append(left);
      if (!sp.configured && !guideBuilt) { buildGuide(sp.redirectUri); guideBuilt = true; }
      guide.hidden = sp.configured;
      credsFold.hidden = false;
      credsFold.open = !sp.configured || credsFold.open;
      connectRow.replaceChildren();
      if (sp.configured) {
        const a = el('a', { class: `btn ${sp.connected ? '' : 'btn-primary'}`, href: BASE + 'api/spotify/login' }, icon('link', 'sm'), sp.connected ? 'Reconectar Spotify' : 'Conectar Spotify');
        connectRow.append(a);
        if (sp.connected) connectRow.append(confirmButton('Desconectar', { ico: 'x', onclick: async () => { await api('admin/spotify/disconnect', { method: 'POST' }); devices = null; } }));
      }
      if (sp.configured && !sp.mock) {
        // enseñar la URI tambien cuando ya hay credenciales (por si hay que corregirla)
        if (!connectRow.querySelector('.uri-row') && !sp.connected) connectRow.append(el('p', { class: 'hint', style: { width: '100%' }, text: `Redirect URI configurada en Spotify: ${sp.redirectUri}` }));
      }
    },
  };
})();

// ---------- Dispositivo ----------
cards.device = (() => {
  const c = card('Dispositivo', 'card-device');
  const list = el('div', { class: 'stack' });
  const refresh = button('Actualizar', { cls: 'btn-sm', ico: 'refresh', onclick: () => loadDevices(true) });
  c.root.querySelector('header').append(refresh);
  const hint = el('p', { class: 'hint', text: 'Abre Spotify en el dispositivo de la fiesta (altavoz, PC, móvil) y dale a play una vez si no aparece.' });
  c.body.append(list, hint);
  return {
    root: c.root,
    update(s) {
      const sp = s.admin.spotify;
      list.replaceChildren();
      if (!sp.connected) { list.append(el('p', { class: 'empty-note', text: 'Conecta Spotify para ver los dispositivos.' })); refresh.disabled = true; return; }
      refresh.disabled = false;
      if (devicesError) { list.append(el('p', { class: 'empty-note', text: devicesError })); return; }
      if (devices === null) { list.append(el('div', { class: 'row' }, el('span', { class: 'spinner' }))); return; }
      if (!devices.length) { list.append(el('p', { class: 'empty-note', text: 'No hay dispositivos disponibles ahora mismo.' })); return; }
      const chosen = s.admin.chosenDeviceId || devices.find((d) => d.active)?.id;
      for (const d of devices) {
        const r = el('input', { type: 'radio', name: 'dev', checked: d.id === chosen ? true : null, 'aria-label': d.name });
        const row = el('label', { class: `dev ${d.id === chosen ? 'sel' : ''}` }, r,
          el('div', { style: { flex: 1, minWidth: 0 } }, el('div', { class: 'n', text: d.name }), el('div', { class: 't', text: d.isIphone ? `${d.type} · iPhone: sin volumen, pausa solo tuya` : d.type + (d.volume != null ? ` · volumen ${d.volume}%` : '') })),
          d.active ? chip('Activo', 'ok') : null);
        r.addEventListener('change', async () => {
          try { await api('admin/device', { method: 'POST', body: { deviceId: d.id } }); toast(`Dispositivo: ${d.name}`, 'ok', 2000); loadDevices(); }
          catch (e) { toast(e.message, 'error', 5000); loadDevices(); }
        });
        list.append(row);
      }
    },
  };
})();

async function loadDevices(manual = false) {
  if (!st?.admin.spotify.connected) return;
  try {
    const r = await api('admin/devices');
    devices = r.devices; devicesError = '';
    if (manual) toast('Dispositivos actualizados', 'ok', 1500);
  } catch (e) { devices = []; devicesError = e.message; }
  cards.device.update(st);
}

// ---------- Fiesta ----------
cards.party = (() => {
  const c = card('Fiesta', 'card-party');
  const nameIn = el('input', { class: 'input', maxlength: '40', placeholder: 'Nombre de la fiesta', value: 'Fiesta', 'aria-label': 'Nombre de la fiesta' });
  const startBtn = button('Empezar fiesta', { cls: 'btn-primary btn-block', ico: 'play', onclick: async () => { await api('admin/party/start', { method: 'POST', body: { name: nameIn.value } }); toast('¡Fiesta en marcha!', 'ok'); } });
  const idle = el('div', { class: 'stack' }, el('label', { class: 'field' }, el('span', { text: 'Nombre' }), nameIn), startBtn,
    el('p', { class: 'hint', text: 'Al empezar se genera un PIN y un QR para que los invitados entren desde el móvil.' }));

  const pin = el('div', { class: 'pin-big', 'aria-label': 'PIN' });
  const qrImg = el('img', { alt: 'QR de la fiesta', width: '132', height: '132' });
  const nameLine = el('div', { class: 'sub' });
  const kickChk = el('input', { type: 'checkbox' });
  const link = () => `${st.publicUrl}/?p=${st.admin.pin}`;
  const active = el('div', { class: 'stack' },
    nameLine,
    el('div', { class: 'pin-box' }, pin, el('div', { class: 'qr-mini' }, qrImg)),
    el('div', { class: 'btns' },
      button('Nuevo PIN', { ico: 'refresh', onclick: async () => { await api('admin/party/pin', { method: 'POST', body: { kickAll: kickChk.checked } }); toast('PIN nuevo', 'ok', 1800); } }),
      button('Copiar enlace', { ico: 'copy', onclick: async () => { await copyText(link()); toast('Enlace copiado', 'ok', 1800); } }),
      el('a', { class: 'btn', href: '../pantalla/', target: '_blank', rel: 'noopener' }, icon('expand', 'sm'), 'Abrir pantalla')),
    el('label', { class: 'check' }, kickChk, 'Al cambiar el PIN, expulsar a todos los invitados'),
    el('hr', { class: 'sep' }),
    confirmButton('Terminar fiesta', { ico: 'x', ask: 'Pulsa otra vez para terminar', onclick: async () => { await api('admin/party/stop', { method: 'POST', body: { kickAll: true } }); toast('Fiesta terminada', 'ok'); } }));
  c.body.append(idle, active);
  return {
    root: c.root,
    update(s) {
      const on = s.party.active;
      idle.hidden = on; active.hidden = !on;
      c.sub.textContent = on ? 'En marcha' : 'Parada';
      if (on) {
        setText(pin, s.admin.pin || '');
        setText(nameLine, s.party.name || '');
        const want = `../api/admin/qr.svg?pin=${s.admin.pin}`;
        if (qrImg.dataset.w !== want) { qrImg.dataset.w = want; qrImg.src = want; }
      } else if (document.activeElement !== nameIn && s.party.name) nameIn.value = s.party.name;
    },
  };
})();

// ---------- Reproduccion ----------
cards.player = (() => {
  const c = card('Reproducción', 'card-player');
  const img = el('img', { alt: '', hidden: true });
  const ph = el('div', { class: 'ph' }, icon('music'));
  const t = el('div', { class: 't', text: 'Nada suena' });
  const sline = el('div', { class: 'hint' });
  const by = el('div', { class: 'hint' });
  const likes = el('div', { class: 'lkw' });
  const mini = el('div', { class: 'np-mini' }, img, ph, el('div', { style: { minWidth: 0, flex: 1 } }, t, sline, by, likes));
  // La accion sale de lo que muestra el boton, no del ultimo estado recibido: si llega una actualizacion
  // justo antes del clic, "Pausa" seguiria pausando y no reanudando.
  const playBtn = button('Pausa', { ico: 'pause', cls: 'btn-primary', onclick: async () => { await api(playBtn.dataset.action === 'resume' ? 'admin/control/resume' : 'admin/control/pause', { method: 'POST' }); } });
  const skipBtn = button('Saltar', { ico: 'skip', onclick: async () => { await api('admin/control/skip', { method: 'POST' }); } });
  const vol = el('input', { type: 'range', min: '0', max: '100', step: '1', value: '50', 'aria-label': 'Volumen' });
  const volOut = el('output', { class: 'muted', text: '50%' });
  let volTimer = null; let volBusy = 0; let lastSent = 0;
  vol.addEventListener('input', () => {
    volOut.textContent = `${vol.value}%`; volBusy = Date.now();
    const wait = Math.max(0, 300 - (Date.now() - lastSent));
    clearTimeout(volTimer);
    volTimer = setTimeout(async () => {
      lastSent = Date.now();
      try { await api('admin/volume', { method: 'POST', body: { pct: Number(vol.value) } }); } catch (e) { toast(e.message, 'error', 4000); }
    }, wait);
  });
  const status = el('div', { class: 'row' });
  const volIco = el('span', {}, icon('volume'));
  const iosNote = el('p', { class: 'hint', hidden: true });
  c.body.append(mini, el('div', { class: 'btns' }, playBtn, skipBtn), el('div', { class: 'vol' }, volIco, vol, volOut), iosNote, status);
  return {
    root: c.root,
    update(s) {
      const np = s.nowPlaying;
      if (np) {
        setText(t, np.name); setText(sline, artistsText(np.artists));
        if (np.image) { setSrc(img, np.image); img.hidden = false; ph.hidden = true; } else { img.hidden = true; ph.hidden = false; }
        applyTint(np.image || null);
        setText(by, np.fromQueue ? `Pedida por ${np.fromQueue.addedBy.name}` : np.filler === 'classic' ? 'Relleno: clásico de otras fiestas' : 'Relleno: playlist del anfitrión');
        likes.replaceChildren(...[likesLine({ queueLikes: np.queueLikes || 0, playLikes: np.playLikes || 0 })].filter(Boolean));
        const lbl = playBtn.querySelector('span'); setText(lbl, np.isPlaying ? 'Pausa' : 'Seguir');
        playBtn.replaceChildren(icon(np.isPlaying ? 'pause' : 'play', 'sm'), lbl);
        playBtn.dataset.action = np.isPlaying ? 'pause' : 'resume';
      } else {
        const lbl = playBtn.querySelector('span'); setText(lbl, 'Seguir');
        playBtn.replaceChildren(icon('play', 'sm'), lbl);
        playBtn.dataset.action = 'resume';
        applyTint(null);
        setText(t, 'Nada suena'); setText(sline, ''); setText(by, ''); likes.replaceChildren(); img.hidden = true; ph.hidden = false; }
      const ios = !!s.player.isIphone;
      vol.disabled = ios || s.player.supportsVolume === false;
      vol.title = vol.disabled ? (ios ? 'No disponible con iPhone: Apple no deja cambiar el volumen desde fuera' : 'Este dispositivo no deja cambiar el volumen desde fuera') : '';
      volIco.replaceChildren(icon(vol.disabled ? 'lock' : 'volume'));
      volOut.hidden = vol.disabled;
      iosNote.hidden = !ios;
      setText(iosNote, 'iPhone: el volumen no se puede controlar desde aquí (usa los botones del móvil o del altavoz) y los invitados no ven el botón de pausa. Para poder reanudar, deja Spotify abierto en pantalla con el bloqueo automático en "Nunca".');
      if (document.activeElement !== vol && Date.now() - volBusy > 1500 && s.player.volume != null) { vol.value = String(s.player.volume); volOut.textContent = `${s.player.volume}%`; }
      status.replaceChildren(playerChip(s), s.player.deviceName ? el('span', { class: 'hint', text: `En: ${s.player.deviceName}` }) : null);
      c.sub.textContent = s.party.active && s.queue.length ? `${s.queue.length} en cola` : '';
    },
  };
})();

function playerChip(s) {
  const map = {
    ok: ['Reproductor listo', 'ok'], no_device: ['Sin dispositivo activo', 'warn'], disconnected: ['Spotify desconectado', 'danger'],
    premium_required: ['Hace falta Premium', 'danger'], rate_limited: ['Spotify saturado, esperando', 'warn'], not_configured: ['Spotify sin configurar', 'warn'],
  };
  const [text, cls] = map[s.player.status] || [s.player.status, ''];
  return chip(text, cls);
}

// ---------- Ajustes ----------
cards.settings = (() => {
  const c = card('Ajustes', 'card-settings');
  const ctrls = {};
  let pending = {}; let saveTimer = null;
  function queueSave(key, value) {
    pending[key] = value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const body = pending; pending = {};
      try { await api('admin/settings', { method: 'PUT', body }); toast('Ajustes guardados', 'ok', 1500); }
      catch (e) { toast(e.message, 'error', 5000); }
    }, 400);
  }
  const rows = {}; // clave -> fila
  const vals = {}; // valor que manda (el del servidor, o el que acabas de elegir)
  function setRow(key, label, desc, control, outEl) {
    const descEl = desc ? el('div', { class: 'desc', id: `set-${key}-desc`, text: desc }) : null;
    const row = el('div', { class: 'set' }, el('div', { class: 'lab' }, el('span', { text: label }), outEl || null), descEl, control);
    rows[key] = row; return row;
  }
  function segSetting(key, label, desc, options) {
    const s = seg(options, (v) => { s.set(v); vals[key] = v; queueSave(key, v); refreshVisibility(); });
    ctrls[key] = { set: (v) => { if (!(key in pending)) { s.set(v); vals[key] = v; } } };
    return setRow(key, label, desc, s.el);
  }
  function rangeSetting(key, label, desc, min, max, step, fmt) {
    const id = `set-${key}`;
    const out = el('output', { for: id, text: '' });
    const r = el('input', { type: 'range', id, min: String(min), max: String(max), step: String(step), 'aria-label': label, 'aria-describedby': desc ? `${id}-desc` : null });
    const show = (v) => { const t = fmt(v); out.textContent = t; r.setAttribute('aria-valuetext', t); };
    r.addEventListener('input', () => show(Number(r.value)));
    r.addEventListener('change', () => queueSave(key, Number(r.value)));
    ctrls[key] = { set: (v) => { if (document.activeElement !== r && !(key in pending)) { r.value = String(v); show(v); } } };
    return setRow(key, label, desc, r, out);
  }
  function switchSetting(key, label, desc) {
    const i = el('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
    i.addEventListener('change', () => queueSave(key, i.checked));
    ctrls[key] = { set: (v) => { if (!(key in pending)) i.checked = !!v; } };
    const row = el('div', { class: 'set inline' }, el('div', {}, el('div', { class: 'lab', text: label }), desc ? el('div', { class: 'desc', text: desc }) : null), el('label', { class: 'switch' }, i, el('i')));
    rows[key] = row; return row;
  }
  // Solo se ven los ajustes que aplican con lo elegido arriba.
  function refreshVisibility() {
    const vote = vals.skipMode === 'vote';
    const direct = vals.pauseMode === 'direct' || vals.skipMode === 'direct';
    for (const k of ['skipVotePct', 'skipVoteMin']) if (rows[k]) rows[k].hidden = !vote;
    for (const k of ['controlCooldownSec', 'globalControlCooldownSec']) if (rows[k]) rows[k].hidden = !direct;
    if (rows.classicsMinScore) rows.classicsMinScore.hidden = vals.fillerMode !== 'classics';
  }
  function group(id, title, open, ...kids) {
    let isOpen = open;
    try { const v = localStorage.getItem(`fiesta.set.${id}`); if (v === '1' || v === '0') isOpen = v === '1'; } catch { /* sin almacenamiento */ }
    const d = el('details', { class: 'fold set-group', open: isOpen, dataset: { group: id } }, el('summary', { text: title }), el('div', { class: 'set-body' }, ...kids));
    d.addEventListener('toggle', () => { try { localStorage.setItem(`fiesta.set.${id}`, d.open ? '1' : '0'); } catch { /* sin almacenamiento */ } });
    return d;
  }
  let pauseRow = null;
  const pauseIosNote = el('p', { class: 'hint', hidden: true, text: 'Bloqueado con iPhone: los invitados no pueden pausar porque iOS duerme Spotify al pausar y no se podría reanudar.' });
  const sec = (n) => (n === 0 ? 'sin espera' : n >= 60 ? `${Math.floor(n / 60)} min${n % 60 ? ' ' + (n % 60) + ' s' : ''}` : `${n} s`);
  c.body.append(
    group('cola', 'Cola', true,
      switchSetting('allowAdd', 'Cola abierta', 'Si la cierras, nadie puede añadir canciones.'),
      rangeSetting('maxQueuedPerGuest', 'Canciones por invitado', 'Cuántas puede tener pendientes a la vez.', 1, 20, 1, (v) => `${v}`),
      rangeSetting('addCooldownSec', 'Espera entre canciones añadidas', 'Por invitado.', 0, 300, 5, sec),
      segSetting('ordering', 'Orden de la cola', null, [['votes', 'Por votos'], ['fifo', 'Orden de llegada']]),
      rangeSetting('maxDurationMin', 'Duración máxima', 'Canciones más largas no se pueden añadir.', 1, 60, 1, (v) => `${v} min`),
      rangeSetting('noRepeatMin', 'No repetir canciones', 'No se puede añadir algo que sonó hace menos de:', 0, 240, 5, (v) => (v === 0 ? 'se puede repetir' : `${v} min`)),
      switchSetting('allowExplicit', 'Permitir canciones explícitas')),
    group('controles', 'Controles de los invitados', false,
      pauseRow = segSetting('pauseMode', 'Pausar y reanudar', 'Quién puede pausar la música.', [['direct', 'Cualquiera'], ['admin', 'Solo yo']]),
      pauseIosNote,
      segSetting('skipMode', 'Saltar canción', 'Cómo se salta la canción que suena.', [['direct', 'Directo'], ['vote', 'Por votos'], ['admin', 'Solo yo']]),
      rangeSetting('skipVotePct', 'Votos para saltar', 'Porcentaje de invitados activos que hace falta.', 1, 100, 1, (v) => `${v}%`),
      rangeSetting('skipVoteMin', 'Mínimo de votos para saltar', null, 1, 20, 1, (v) => `${v}`),
      rangeSetting('controlCooldownSec', 'Espera para pausar o saltar', 'Por invitado, en modo directo.', 0, 600, 5, sec),
      rangeSetting('globalControlCooldownSec', 'Espera global para pausar o saltar', 'Evita guerras de pausa entre invitados.', 0, 300, 1, sec)),
    group('relleno', 'Relleno y clásicos', false,
      segSetting('fillerMode', 'Cuando la cola se vacía', 'Qué suena si nadie ha pedido nada.', [['classics', 'Clásicos de mis fiestas'], ['host', 'Mi playlist de Spotify']]),
      rangeSetting('classicsMinScore', 'Puntos para ser clásico', '1 punto por like, 0,5 por voto (sumando todas las fiestas).', 1, 20, 1, (v) => `${v} pts`),
      switchSetting('classicsAutoUpdate', 'Actualizar "Clásicos de fiesta" al terminar', 'La playlist de Spotify se rehace sola al terminar cada fiesta.')));
  return {
    root: c.root,
    update(s) {
      for (const [k, ctl] of Object.entries(ctrls)) ctl.set(s.settings[k]);
      refreshVisibility();
      const ios = !!s.player.isIphone;
      pauseIosNote.hidden = !ios;
      if (pauseRow) { pauseRow.classList.toggle('locked', ios); for (const b of pauseRow.querySelectorAll('button')) b.disabled = ios; }
    },
  };
})();

// ---------- Cola ----------
cards.queue = (() => {
  const c = card('Cola', 'card-queue');
  const list = el('ul', { class: 'aq' });
  const empty = el('p', { class: 'empty-note', text: 'La cola está vacía.' });
  const clear = confirmButton('Vaciar cola', { ico: 'trash', ask: '¿Vaciar toda?', onclick: async () => { await api('admin/queue/clear', { method: 'POST' }); } });
  clear.classList.add('btn-sm');
  c.root.querySelector('header').append(clear);
  c.body.append(list, empty, el('p', { class: 'hint', text: 'Arrastra el asa para cambiar el orden. Al mover algo a mano, deja de depender de los votos.' }));

  function create() {
    const li = el('li', { class: 'aq-item' },
      el('span', { class: 'grip', title: 'Arrastrar', role: 'img', 'aria-label': 'Arrastrar para reordenar' }, icon('grip')),
      el('img', { alt: '' }),
      el('div', { class: 'aq-main' }, el('div', { class: 't ellipsis' }), el('div', { class: 's ellipsis' })),
      el('div', { class: 'aq-btns' },
        el('span', { class: 'votes-tag' }),
        el('button', { class: 'icon-btn top', type: 'button', title: 'Subir arriba', 'aria-label': 'Poner la primera' }, icon('up')),
        el('button', { class: 'icon-btn del', type: 'button', title: 'Quitar', 'aria-label': 'Quitar de la cola' }, icon('trash'))));
    li.querySelector('.top').addEventListener('click', async () => { try { await api(`admin/queue/${encodeURIComponent(li.dataset.key)}/top`, { method: 'POST' }); } catch (e) { toast(e.message, 'error'); } });
    li.querySelector('.del').addEventListener('click', async () => { try { await api(`admin/queue/${encodeURIComponent(li.dataset.key)}`, { method: 'DELETE' }); } catch (e) { toast(e.message, 'error'); } });
    attachDrag(li, list);
    return li;
  }
  function upd(li, q) {
    li.classList.toggle('fed', q.fed);
    setSrc(li.querySelector('img'), q.thumb || q.image);
    setText(li.querySelector('.t'), q.name);
    setText(li.querySelector('.s'), `${artistsText(q.artists)} · de ${q.addedBy.name}`);
    const vt = li.querySelector('.votes-tag');
    vt.replaceChildren(); if (q.votes) vt.append(icon('up', 'sm'), String(q.votes));
    li.querySelector('.grip').hidden = q.fed;
    li.querySelector('.top').hidden = q.fed;
    li.querySelector('.del').hidden = q.fed;
    if (q.fed && !li.querySelector('.fed-chip')) li.querySelector('.aq-btns').prepend(el('span', { class: 'chip accent fed-chip', text: 'A continuación' }));
    if (!q.fed) li.querySelector('.fed-chip')?.remove();
  }
  return {
    root: c.root,
    update(s) {
      if (dragging) return;
      reconcile(list, s.queue, (q) => q.qid, create, upd);
      empty.hidden = s.queue.length > 0; list.hidden = s.queue.length === 0;
      clear.hidden = s.queue.length === 0;
      c.sub.textContent = `${s.queue.length} canciones`;
    },
  };
})();

/** Reordenar arrastrando con pointer events (vale para raton y tactil). */
function attachDrag(li, list) {
  const grip = li.querySelector('.grip');
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button > 0) return;
    if (li.classList.contains('fed')) return;
    e.preventDefault();
    const items = [...list.children].filter((x) => !x.classList.contains('fed'));
    const idx0 = items.indexOf(li);
    const rects = items.map((x) => x.getBoundingClientRect());
    const h = rects[idx0].height + 8;
    const startY = e.clientY;
    let newIdx = idx0;
    dragging = true;
    li.classList.add('dragging');
    for (const x of items) if (x !== li) x.classList.add('shift');
    grip.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const dy = ev.clientY - startY;
      li.style.transform = `translateY(${dy}px)`;
      const center = rects[idx0].top + rects[idx0].height / 2 + dy;
      let n = 0;
      rects.forEach((r, j) => { if (j !== idx0 && r.top + r.height / 2 < center) n++; });
      newIdx = n;
      items.forEach((x, j) => {
        if (x === li) return;
        let sh = 0;
        if (j < idx0 && j >= newIdx) sh = h;
        if (j > idx0 && j <= newIdx) sh = -h;
        x.style.transform = sh ? `translateY(${sh}px)` : '';
      });
    };
    const up = async () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      const order = items.filter((x) => x !== li);
      order.splice(newIdx, 0, li);
      for (const x of items) { x.classList.remove('shift', 'dragging'); x.style.transform = ''; }
      // aplica el nuevo orden ya, sin esperar al servidor
      const fedEls = [...list.children].filter((x) => x.classList.contains('fed'));
      for (const n of [...fedEls, ...order]) list.append(n);
      dragging = false;
      if (newIdx !== idx0) {
        try { await api('admin/queue/reorder', { method: 'POST', body: { qids: order.map((x) => x.dataset.key) } }); }
        catch (err) { toast(err.message, 'error'); }
      }
      if (pendingState) { const s = pendingState; pendingState = null; applyState(s); }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
}

// ---------- Invitados ----------
cards.guests = (() => {
  const c = card('Invitados', 'card-guests');
  const list = el('ul', { class: 'ag' });
  const empty = el('p', { class: 'empty-note', text: 'Todavía no ha entrado nadie.' });
  c.body.append(list, empty);
  function create() {
    const li = el('li', { class: 'ag-item' },
      el('div', { class: 'ag-main' }, el('div', { class: 't' }, el('span', { class: 'dot-s' }), el('span', { class: 'nm ellipsis' })), el('div', { class: 's' })),
      el('div', { class: 'ag-btns' }));
    return li;
  }
  function upd(li, g) {
    li.querySelector('.dot-s').classList.toggle('on', g.active && !g.banned);
    setText(li.querySelector('.nm'), g.name);
    setText(li.querySelector('.s'), g.banned ? 'Baneado' : `${g.added} añadidas · ${g.queued} en cola · ${g.active ? 'activo' : 'inactivo'}`);
    const k = g.banned ? 'b' : 'a';
    const btns = li.querySelector('.ag-btns');
    if (btns.dataset.k !== k) {
      btns.dataset.k = k; btns.replaceChildren();
      if (!g.banned) {
        btns.append(
          confirmButton('Expulsar', { cls: 'btn-sm', ico: 'logout', ask: '¿Seguro?', onclick: async () => { await api(`admin/guests/${encodeURIComponent(li.dataset.key)}/kick`, { method: 'POST' }); toast('Invitado expulsado', 'ok', 1800); } }),
          confirmButton('Banear', { cls: 'btn-sm btn-danger', ico: 'ban', ask: '¿Banear?', onclick: async () => { await api(`admin/guests/${encodeURIComponent(li.dataset.key)}/ban`, { method: 'POST' }); toast('Invitado baneado', 'ok', 1800); } }));
      }
    }
  }
  return {
    root: c.root,
    update(s) {
      const gs = s.admin.guests;
      reconcile(list, gs, (g) => g.id, create, upd);
      empty.hidden = gs.length > 0; list.hidden = gs.length === 0;
      c.sub.textContent = `${s.activeGuests} activos de ${gs.filter((g) => !g.banned).length}`;
    },
  };
})();

// ---------- Historial, resumen y playlists ----------
function likesLine(h) {
  const parts = [];
  const tot = (h.queueLikes || 0) + (h.playLikes || 0);
  if (!tot) return null;
  return el('span', { class: 'lk', title: `${plural(h.playLikes || 0, 'like', 'likes')} · ${plural(h.queueLikes || 0, 'voto', 'votos')}` },
    icon('heart', 'sm'), el('b', { text: String(h.playLikes || 0) }), icon('up', 'sm'), el('b', { text: String(h.queueLikes || 0) }), el('span', { class: 'lk-split', text: `${tot} en total` }));
}
function originText(h) {
  if (h.addedBy) return `de ${h.addedBy}`;
  return h.filler === 'classic' ? 'clásico (relleno)' : 'relleno';
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function fmtDay(ts) { return ts ? new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

cards.history = (() => {
  const c = card('Historial y playlists', 'card-history');
  let sel = 'current';            // 'current' o id de fiesta archivada
  let remote = null;              // {party, summary, history} de una fiesta pasada
  let remoteFor = null;

  // selector de fiesta
  const partySel = el('select', { class: 'input sel', 'aria-label': 'Fiesta' });
  partySel.addEventListener('change', () => { sel = partySel.value; remote = null; remoteFor = null; refresh(); schedulePreview(); });

  // resumen
  const sumBox = el('div', { class: 'sum' });
  const showBtn = button('Añadir resumen a la pantalla', { ico: 'expand', cls: 'btn-sm', onclick: async () => {
    await api('admin/summary/show', { method: 'POST', body: { on: !st.admin.showSummary } });
  } });
  const showHint = el('p', { class: 'hint', text: 'La pantalla enseña el resumen de la fiesta actual (o de la última si ya terminó).' });

  // constructor de playlist
  const pl = { filter: 'all', minLikes: 1, likeType: 'total', order: 'played_asc', includeFiller: true };
  const filterSeg = seg([['all', 'Todas'], ['min', 'Con mínimo de likes y votos']], (v) => { pl.filter = v; filterSeg.set(v); minRow.hidden = v !== 'min'; schedulePreview(); });
  filterSeg.set('all');
  const minIn = el('input', { class: 'input num', type: 'number', min: '1', max: '999', value: '1', inputmode: 'numeric', 'aria-label': 'Mínimo de likes y votos' });
  minIn.addEventListener('input', () => { pl.minLikes = Math.max(0, Math.min(999, parseInt(minIn.value, 10) || 0)); schedulePreview(); });
  const minRow = el('div', { class: 'row', hidden: true }, el('span', { text: 'Al menos' }), minIn, el('span', { text: 'likes y votos' }));
  const typeSeg = seg([['total', 'Likes y votos'], ['play', 'Solo likes'], ['queue', 'Solo votos']], (v) => { pl.likeType = v; typeSeg.set(v); schedulePreview(); });
  typeSeg.set('total');
  const orderSel = el('select', { class: 'input sel', 'aria-label': 'Orden' },
    ...[['played_asc', 'Como sonaron (de la primera a la última)'], ['played_desc', 'Como sonaron (de la última a la primera)'],
      ['likes_desc', 'Más likes y votos primero'], ['likes_asc', 'Menos likes y votos primero'],
      ['added_asc', 'Por cuándo se pidieron (antiguas primero)'], ['added_desc', 'Por cuándo se pidieron (recientes primero)']]
      .map(([v, t]) => el('option', { value: v, text: t })));
  orderSel.addEventListener('change', () => { pl.order = orderSel.value; schedulePreview(); });
  const fillIn = el('input', { type: 'checkbox', role: 'switch', checked: true, 'aria-label': 'Incluir relleno' });
  fillIn.addEventListener('change', () => { pl.includeFiller = fillIn.checked; schedulePreview(); });
  const nameIn = el('input', { class: 'input', maxlength: '100', placeholder: 'Nombre de la playlist', 'aria-label': 'Nombre de la playlist' });
  const preview = el('div', { class: 'pv' });
  const result = el('div', { class: 'hint' });
  const body = () => ({
    partyId: sel, name: nameIn.value, likeType: pl.likeType, order: pl.order,
    minLikes: pl.filter === 'min' ? pl.minLikes : 0, includeFiller: pl.includeFiller,
  });
  const createBtn = button('Crear playlist en Spotify', { cls: 'btn-primary', ico: 'music', onclick: async () => {
    const r = await api('admin/playlist', { method: 'POST', body: body() });
    result.replaceChildren(`Playlist creada con ${r.added} canciones. `, el('a', { href: r.url, target: '_blank', rel: 'noopener', text: 'Abrir en Spotify' }));
    toast('Playlist guardada en Spotify', 'ok');
  } });
  let pvTimer = null; let pvSeq = 0;
  function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(loadPreview, 300); }
  async function loadPreview() {
    const seq = ++pvSeq;
    try {
      const r = await api('admin/playlist/preview', { method: 'POST', body: body() });
      if (seq !== pvSeq) return;
      preview.replaceChildren(...[
        el('b', { text: r.count === 1 ? 'Saldrá 1 canción' : `Saldrán ${r.count} canciones` }),
        r.items.length ? el('ol', { class: 'pv-list' }, ...r.items.map((i) => el('li', { text: `${i.name} · ${artistsText(i.artists)}` }))) : null,
        r.count > r.items.length ? el('span', { class: 'hint', text: `y ${r.count - r.items.length} más` }) : null].filter(Boolean));
      createBtn.disabled = r.count === 0;
    } catch (e) {
      if (seq !== pvSeq) return;
      preview.replaceChildren(el('span', { class: 'hint', text: e.message }));
      createBtn.disabled = true;
    }
  }
  const builder = el('details', { class: 'builder' },
    el('summary', { text: 'Crear una playlist con esta fiesta' }),
    el('div', { class: 'stack' },
      el('div', { class: 'set' }, el('div', { class: 'lab', text: 'Qué canciones' }), filterSeg.el, minRow),
      el('div', { class: 'set' }, el('div', { class: 'lab', text: 'Qué cuenta' }), el('div', { class: 'desc', text: 'Para el mínimo y para ordenar por likes y votos.' }), typeSeg.el),
      el('div', { class: 'set' }, el('div', { class: 'lab', text: 'Orden' }), orderSel),
      el('div', { class: 'set inline' }, el('div', {}, el('div', { class: 'lab', text: 'Incluir canciones de relleno' }), el('div', { class: 'desc', text: 'Las que no pidió nadie.' })), el('label', { class: 'switch' }, fillIn, el('i'))),
      el('div', { class: 'set' }, el('div', { class: 'lab', text: 'Nombre' }), nameIn),
      preview, createBtn, result));
  builder.addEventListener('toggle', () => { if (builder.open) loadPreview(); });

  // lista
  const list = el('ul', { class: 'ah' });
  const empty = el('p', { class: 'empty-note', text: 'Todavía no ha sonado nada.' });
  c.body.append(partySel, sumBox, el('div', { class: 'row' }, showBtn), showHint, builder, list, empty);

  function create() {
    return el('li', { class: 'ah-item' }, el('img', { alt: '' }),
      el('div', { class: 'ah-main' }, el('div', { class: 't ellipsis' }), el('div', { class: 's ellipsis' }), el('div', { class: 'lkw' })),
      el('span', { class: 'ago' }));
  }
  function upd(li, h) {
    setSrc(li.querySelector('img'), h.image);
    setText(li.querySelector('.t'), h.name);
    setText(li.querySelector('.s'), `${artistsText(h.artists)} · ${originText(h)}${h.skipped ? ' · saltada' : ''}`);
    li.querySelector('.lkw').replaceChildren(...[likesLine(h)].filter(Boolean));
    setText(li.querySelector('.ago'), sel === 'current' && st?.party.active ? fmtAgo(h.playedAt) : new Date(h.playedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }));
  }

  function renderSummary(sm) {
    sumBox.replaceChildren();
    if (!sm || !sm.songs) { sumBox.append(el('p', { class: 'hint', text: 'El resumen aparecerá cuando suenen canciones.' })); return; }
    const stat = (n, t) => el('div', { class: 'st' }, el('b', { text: String(n) }), el('span', { text: t }));
    sumBox.append(el('div', { class: 'sum-stats' },
      stat(sm.songs, sm.songs === 1 ? 'canción' : 'canciones'), stat(sm.playLikes, sm.playLikes === 1 ? 'like' : 'likes'), stat(sm.queueLikes, sm.queueLikes === 1 ? 'voto' : 'votos'), stat(sm.joined || 0, (sm.joined || 0) === 1 ? 'invitado' : 'invitados')));
    sumBox.append(el('p', { class: 'hint', text: `Pedidas por invitados: ${sm.requested}` }));
    const row = (k, v, m) => el('div', { class: 'sum-row' }, el('span', { class: 'k', text: k }), el('span', { class: 'v ellipsis', text: v }), m ? el('span', { class: 'm', text: m }) : null);
    const s1 = sm.songOfNight;
    sumBox.append(
      row('Canción de la noche', s1 ? `${s1.name} · ${artistsText(s1.artists)}` : 'Sin likes ni votos todavía', s1 ? `${plural(s1.playLikes, 'like', 'likes')} · ${plural(s1.queueLikes, 'voto', 'votos')}` : null),
      row('DJ de la noche', sm.bestDj ? sm.bestDj.name : 'Nadie todavía', sm.bestDj ? `${plural(sm.bestDj.likes, 'like', 'likes')} · ${plural(sm.bestDj.votes, 'voto', 'votos')}` : null));
  }

  async function fetchRemote(id) {
    remoteFor = id;
    try {
      const r = await api(`admin/history/${encodeURIComponent(id)}`);
      if (remoteFor !== id) return;
      remote = r; refresh();
    } catch (e) { toast(e.message, 'error', 4000); }
  }

  function refresh() {
    const s = st; if (!s) return;
    const a = s.admin;
    // opciones del selector
    const opts = [];
    if (s.party.active) opts.push(['current', `Fiesta actual · ${s.party.name}`]);
    for (const p of a.parties) if (!(s.party.active && a.summary?.partyId === p.id)) opts.push([p.id, `${p.name} · ${fmtDay(p.startedAt)} · ${p.songs} canciones`]);
    const key = opts.map((o) => o.join('|')).join('/');
    if (partySel.dataset.k !== key) {
      partySel.dataset.k = key;
      partySel.replaceChildren(...opts.map(([v, t]) => el('option', { value: v, text: t })));
    }
    if (!opts.some((o) => o[0] === sel)) { sel = opts[0]?.[0] || 'current'; remote = null; remoteFor = null; }
    partySel.value = sel;
    partySel.hidden = opts.length <= 1;

    let hs; let sm; let pname = s.party.name;
    if (!opts.length) { hs = []; sm = null; }
    else if (sel === 'current' && s.party.active) { hs = a.history; sm = a.summary; }
    else {
      if (!remote || remote.party.id !== sel) { if (remoteFor !== sel) fetchRemote(sel); hs = []; sm = null; }
      else { hs = remote.history; sm = remote.summary; pname = remote.party.name; }
    }
    renderSummary(sm);
    reconcile(list, hs, (h) => `${h.playedAt}-${h.trackId}`, create, upd);
    empty.hidden = hs.length > 0; list.hidden = hs.length === 0;
    c.sub.textContent = hs.length ? plural(hs.length, 'canción', 'canciones') : '';
    setText(showBtn.querySelector('span'), a.showSummary ? 'Quitar resumen de la pantalla' : 'Añadir resumen a la pantalla');
    showBtn.classList.toggle('btn-primary', !!a.showSummary);
    showBtn.disabled = !a.summary;
    if (document.activeElement !== nameIn && !nameIn.value) nameIn.placeholder = `${pname || 'Fiesta'} (${new Date().toLocaleDateString('es-ES')})`;
  }

  return { root: c.root, update(s) { refresh(); if (builder.open && s.party.active && sel === 'current') schedulePreview(); } };
})();

// ---------- Clasicos de fiesta ----------
cards.classics = (() => {
  const c = card('Clásicos de fiesta', 'card-classics');
  const intro = el('p', { class: 'hint' });
  const plInfo = el('div', { class: 'hint' });
  const updBtn = button('Actualizar playlist ahora', { cls: 'btn-primary', ico: 'music', onclick: async () => {
    const r = await api('admin/classics/update', { method: 'POST' });
    toast(`Clásicos actualizados (${r.count} canciones)`, 'ok');
  } });
  const list = el('ul', { class: 'ah' });
  const empty = el('p', { class: 'empty-note', text: 'Todavía no hay clásicos. Saldrán solos cuando la gente dé likes y votos en tus fiestas.' });
  const restore = el('div', { class: 'row' });
  c.body.append(intro, el('div', { class: 'row' }, updBtn), plInfo, list, empty, restore);
  function create() {
    return el('li', { class: 'ah-item' }, el('img', { alt: '' }),
      el('div', { class: 'ah-main' }, el('div', { class: 't ellipsis' }), el('div', { class: 's ellipsis' }), el('div', { class: 'lkw' })),
      el('span', { class: 'score' }), el('div', { class: 'xb' }));
  }
  function upd(li, t) {
    setSrc(li.querySelector('img'), t.image);
    setText(li.querySelector('.t'), t.name);
    setText(li.querySelector('.s'), `${artistsText(t.artists)} · sonó ${t.plays} ${t.plays === 1 ? 'vez' : 'veces'}`);
    li.querySelector('.lkw').replaceChildren(...[likesLine(t)].filter(Boolean));
    setText(li.querySelector('.score'), `${String(t.score).replace('.', ',')} pts`);
    const xb = li.querySelector('.xb');
    if (!xb.firstChild) {
      const b = el('button', { class: 'icon-btn', type: 'button', title: 'Quitar de clásicos', 'aria-label': 'Quitar de clásicos' }, icon('x', 'sm'));
      b.addEventListener('click', run(b, async () => { await api(`admin/classics/${encodeURIComponent(li.dataset.key)}/exclude`, { method: 'POST', body: { excluded: true } }); toast('Quitada de clásicos', 'ok', 1800); }));
      xb.append(b);
    }
  }
  return {
    root: c.root,
    update(s) {
      const k = s.admin.classics; const set = s.settings;
      setText(intro, `Las canciones que más gustan en todas tus fiestas. Puntos: 1 por cada like y 0,5 por cada voto. Entran las que tienen ${set.classicsMinScore} puntos o más (se cambia en Ajustes).${set.classicsAutoUpdate ? ' La playlist se actualiza sola al terminar cada fiesta.' : ''}${set.fillerMode === 'classics' ? ' Cuando la cola se vacía, suenan estas canciones.' : ''}`);
      const p = k.playlist;
      plInfo.replaceChildren();
      if (p?.url) plInfo.append(el('a', { href: p.url, target: '_blank', rel: 'noopener', text: 'Abrir "Clásicos de fiesta" en Spotify' }), p.updatedAt ? ` · actualizada ${fmtAgo(p.updatedAt)} con ${plural(p.count, 'canción', 'canciones')}` : '');
      else plInfo.append('Todavía no se ha creado la playlist en Spotify.');
      updBtn.disabled = !k.count;
      reconcile(list, k.top, (t) => t.trackId, create, upd);
      empty.hidden = k.top.length > 0; list.hidden = k.top.length === 0;
      c.sub.textContent = k.count ? plural(k.count, 'canción', 'canciones') : '';
      restore.replaceChildren();
      if (k.excluded) {
        restore.append(el('span', { class: 'hint', text: `${plural(k.excluded, 'quitada', 'quitadas')} a mano.` }),
          button('Restaurarlas', { cls: 'btn-sm btn-ghost', onclick: async () => { await api('admin/classics/restore', { method: 'POST' }); toast('Restauradas', 'ok', 1800); } }));
      }
    },
  };
})();

// ---------- orden de tarjetas ----------
// Cada disposicion tiene un orden de lectura (movil, una columna) y un reparto fijo en dos columnas
// (escritorio). Las columnas son contenedores reales: una tarjeta que crece no hace saltar a las demas.
const LAYOUTS = {
  // fiesta en marcha: lo que se toca cada pocos minutos, arriba
  fiesta: {
    order: ['player', 'queue', 'party', 'guests', 'history', 'classics', 'settings', 'device', 'spotify'],
    a: ['player', 'queue', 'guests'],
    b: ['party', 'history', 'classics', 'settings', 'device', 'spotify'],
  },
  // Spotify listo y sin fiesta: lo primero es empezarla
  ready: {
    order: ['party', 'player', 'queue', 'guests', 'history', 'classics', 'settings', 'device', 'spotify'],
    a: ['party', 'player', 'queue', 'guests'],
    b: ['history', 'classics', 'settings', 'device', 'spotify'],
  },
  // puesta en marcha: conectar Spotify, elegir dispositivo, empezar
  setup: {
    order: ['spotify', 'device', 'party', 'player', 'queue', 'guests', 'settings', 'history', 'classics'],
    a: ['spotify', 'device', 'party'],
    b: ['player', 'queue', 'guests', 'settings', 'history', 'classics'],
  },
};
const cardsHost = $('cards');
const colA = el('div', { class: 'col col-a' });
const colB = el('div', { class: 'col col-b' });
const wideMq = matchMedia('(min-width: 980px)');
let layoutKey = '';
function layout(s) {
  const sp = s.admin.spotify;
  const ready = sp.configured && sp.connected;
  const name = !ready ? 'setup' : s.party.active ? 'fiesta' : 'ready';
  const wide = wideMq.matches;
  const key = `${name}:${wide ? 'cols' : 'one'}`;
  if (key === layoutKey) return;
  layoutKey = key;
  const L = LAYOUTS[name];
  // mover nodos quita el foco: se devuelve a donde estaba
  const focused = cardsHost.contains(document.activeElement) ? document.activeElement : null;
  if (wide) {
    // dos columnas: el DOM (y el foco) baja por la primera y luego por la segunda, como se ve
    cardsHost.append(colA, colB);
    for (const k of L.a) colA.append(cards[k].root);
    for (const k of L.b) colB.append(cards[k].root);
  } else {
    // una columna: las tarjetas van directas, en el orden de lectura, para que foco y vista coincidan
    for (const k of L.order) cardsHost.append(cards[k].root);
    colA.remove(); colB.remove();
  }
  if (focused && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
}
wideMq.addEventListener('change', () => { if (st?.admin && !dragging) layout(st); });

// ---------- alertas y cabecera ----------
function renderTop(s) {
  const chips = $('topChips'); chips.replaceChildren();
  const sp = s.admin.spotify;
  const on = s.party.active;
  chips.append(chip(sp.connected ? 'Spotify conectado' : sp.configured ? 'Spotify sin conectar' : 'Spotify sin configurar', sp.connected ? 'ok' : 'warn'));
  if (sp.connected) {
    const dev = s.player.status !== 'no_device' && s.player.deviceName;
    const c = chip(dev || 'Sin dispositivo', dev ? '' : 'warn');
    if (dev) c.title = `Suena en: ${dev}`;
    chips.append(c);
  }
  if (on) {
    chips.append(chip(`Fiesta en marcha · ${s.activeGuests} ${s.activeGuests === 1 ? 'activo' : 'activos'}`, 'accent'));
    chips.append(chip(`${s.queue.length} en cola`));
  } else chips.append(chip('Sin fiesta'));
  const pj = $('pinJump');
  const showPin = !!(on && s.admin.pin);
  pj.hidden = !showPin;
  if (showPin) {
    setText($('pinJumpText'), `PIN ${s.admin.pin}`);
    pj.setAttribute('aria-label', `PIN ${s.admin.pin}. Ver PIN y QR de la fiesta`);
  }
  const al = $('alerts'); al.replaceChildren();
  const items = [...s.admin.alerts];
  const ps = s.player.status;
  if (sp.connected && ps === 'no_device' && s.player.isIphone) items.push({ level: 'warn', text: 'Spotify se ha dormido en el iPhone. Ábrelo, dale a play y déjalo en pantalla.' });
  else if (sp.connected && ps === 'no_device') items.push({ level: 'warn', text: 'Spotify no encuentra un dispositivo activo. Abre Spotify en el altavoz o el PC de la fiesta y dale a play una vez.' });
  if (sp.configured && !sp.connected && !sp.mock) items.push({ level: 'warn', text: 'Spotify está sin conectar: pulsa "Conectar Spotify" para que los invitados puedan poner música.' });
  for (const a of items) al.append(el('div', { class: `alert ${a.level === 'error' ? 'error' : ''}` }, icon('alert', 'sm'), el('span', { text: a.text })));
}

// ---------- estado ----------
let prevConnected = null;
function applyState(s) {
  st = s; syncClock(s.serverNow);
  if (!s.admin) return;
  layout(s);
  renderTop(s);
  for (const c of Object.values(cards)) c.update(s);
  if (prevConnected !== s.admin.spotify.connected) {
    prevConnected = s.admin.spotify.connected;
    if (prevConnected) loadDevices(); else devices = null;
    cards.device.update(s);
  }
}
function onState(s) {
  if (dragging) { pendingState = s; st = s; return; }
  applyState(s);
}

async function start() {
  try { await api('admin/status'); } catch (e) {
    if (e instanceof ApiError && e.status === 401) { showLogin(); return; }
    showLogin(e.message); return;
  }
  $('login').hidden = true; $('dash').hidden = false;
  events?.close();
  events = connectEvents({
    onState,
    onToast: (t) => { if (t.kind !== 'join') toast(t.text, 'info', 2800); },
    onStatus: () => {},
    onUnauthorized: () => showLogin('La sesión ha caducado.'),
    probe: () => api('admin/status'),
  });
  const q = new URLSearchParams(location.search);
  const sp = q.get('spotify');
  if (sp) {
    const msg = { ok: ['Spotify conectado', 'ok'], denied: ['Has cancelado la autorización de Spotify', 'error'], state: ['La autorización falló, prueba otra vez', 'error'], error: ['No se pudo conectar con Spotify. Revisa el Client ID, el secret y la Redirect URI', 'error'], nocreds: ['Primero guarda el Client ID y el secret', 'error'] }[sp];
    if (msg) toast(msg[0], msg[1], 6000);
    history.replaceState(null, '', location.pathname);
  }
}

// ticks para "hace X min"
setInterval(() => { if (st && !dragging && !document.hidden) { cards.history.update(st); cards.classics.update(st); } }, 30000);
start();
