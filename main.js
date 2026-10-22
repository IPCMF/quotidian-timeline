'use strict';
/* Quotidian Timeline v0.2 — plain CommonJS, no build step. */

let obsidian = null, cmView = null, cmState = null;
try {
  obsidian = require('obsidian');
  cmView = require('@codemirror/view');
  cmState = require('@codemirror/state');
} catch (e) { /* running outside Obsidian (tests) */ }

/* Per-task colour lives in the note text as one of these emoji, so it syncs anywhere. */
const COLOR_EMOJI = [
  ['🔴', '#e5484d', 'Red'], ['🟠', '#f76b15', 'Orange'], ['🟡', '#e9b10c', 'Yellow'], ['🟢', '#30a46c', 'Green'],
  ['🔵', '#0090ff', 'Blue'], ['🟣', '#8e4ec6', 'Purple'], ['🟤', '#a07553', 'Brown'], ['⚫', '#8b8d98', 'Grey'],
];
const EMOJI_HEX = Object.fromEntries(COLOR_EMOJI.map(([e, h]) => [e, h]));
const EMOJI_RE = /(🔴|🟠|🟡|🟢|🔵|🟣|🟤|⚫)️?/gu;

const VERSION = '0.7.2';

const DEFAULT_SETTINGS = {
  folder: '',             // '' = any note named like "26.10.08, ..."
  startMode: 'lead',      // 'lead' | 'first' | 'fixed'
  leadMinutes: 60,
  trailMinutes: 60,
  fixedStartHour: 8,
  pxPerHour: 48,
  maxHeight: 420,
  mobileMaxHeight: 260,
  dayStartHour: 6,        // bare times before this are read as pm ("2:30" -> 14:30)
  snapMinutes: 15,
  writeFormat: 'auto',    // 'auto' | '24h' | '12h'
  defaultColor: '',       // '' = theme accent
  tagColors: { Ma: '#3e8ef7', Fm: '#8e4ec6', Ph: '#30a46c', Ec: '#e9a70c', HP: '#e5484d', MATS: '#12a594' },
  collapsedDesktop: false,
  collapsedMobile: false,
  swapArrows: false,
  cleanupEnabled: true,   // trash untouched template-only day notes
  cleanupDays: 3,      // false: ◀ earlier day, ▶ later day
};

/* ---------- parsing ---------- */

const TASK_RE = /^(\s*[-*+]\s+\[)(.)(\]\s+)\(\s*([^)\-–—]+?)\s*[-–—]\s*([^)]*?)\s*\)\s*(.*?)\r?$/;
const CLOCK_RE = /^(\d{1,2})(?:[:.h](\d{1,2}))?\s*(am|pm|a|p)?$/i;

function parseClock(tok) {
  const m = CLOCK_RE.exec((tok || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2].padEnd(2, '0'), 10) : 0;
  if (h > 24 || min > 59) return null;
  return { h, min, ampm: m[3] ? m[3][0].toLowerCase() : null };
}

function resolveClock(c, floor) {
  if (c.ampm) return ((c.h % 12) + (c.ampm === 'p' ? 12 : 0)) * 60 + c.min;
  if (c.h >= 13 || c.h === 0) return c.h * 60 + c.min;
  if (c.h === 12) return 720 + c.min;
  const am = c.h * 60 + c.min;
  return am >= floor ? am : am + 720;
}

function parseTasks(lines, lineOffset, settings) {
  const tasks = [];
  let floor = ((settings && settings.dayStartHour) ?? 6) * 60;
  lines.forEach((text, i) => {
    const m = TASK_RE.exec(text);
    if (!m) return;
    const sc = parseClock(m[4]);
    if (!sc) return;
    const start = resolveClock(sc, floor);
    let end, open = false;
    const ec = parseClock(m[5]);
    if (ec) {
      end = resolveClock(ec, start + 1);
      while (end <= start) end += 720;
    } else {
      end = start + 60; open = true;
    }
    const rest = m[6].trim();
    const emojis = rest.match(EMOJI_RE) || [];
    const color = emojis.length ? emojis[emojis.length - 1].replace('️', '') : null;
    const restNoEmoji = rest.replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
    const tags = (restNoEmoji.match(/#[\w\/-]+/g) || []).map(t => t.slice(1));
    const title = restNoEmoji.replace(/#[\w\/-]+/g, '').replace(/\s+/g, ' ').trim() || tags.join(' ') || 'Untitled';
    let style = null;
    if (sc.h >= 13 || sc.h === 0 || (ec && (ec.h >= 13 || ec.h === 0))) style = '24';
    else if (!sc.ampm && (start >= 780 || end >= 780)) style = '12';
    tasks.push({
      line: lineOffset + i, raw: text.replace(/\r$/, ''), pre: m[1], check: m[2], mid: m[3], endRaw: m[5],
      done: m[2].trim() !== '', start, end, open, rest: restNoEmoji, color, title, tags, style,
    });
    floor = start;
  });
  return tasks;
}

function findTimelines(lines, settings) {
  const out = [];
  const heads = [];
  lines.forEach((l, i) => { if (/^#{1,6}\s/.test(l)) heads.push(i); });
  const bounds = [];
  if (!heads.length || heads[0] > 0) bounds.push([0, heads.length ? heads[0] : lines.length, null]);
  heads.forEach((h, k) => bounds.push([h, k + 1 < heads.length ? heads[k + 1] : lines.length, lines[h]]));
  for (const [a, b, heading] of bounds) {
    const tasks = parseTasks(lines.slice(a, b), a, settings);
    if (!tasks.length) continue;
    // sit directly under the heading (above the list); no heading → after the list
    let anchor = b - 1;
    if (heading != null) anchor = a;
    else while (anchor > a && !lines[anchor].trim()) anchor--;
    out.push({ anchor, tasks, start: a, end: b, tomorrow: !!(heading && /tomorrow/i.test(heading)) });
  }
  return out;
}

const PLACEHOLDER_RE = /^(\s*[-*+]\s+\[)(.)(\]\s+)\(\s*time\s*-\s*time\s*\)\s*(.*)$/i;
/* Timelines, or (if the note has none) one empty block under the Today/Tomorrow heading. */
function findBlocks(lines, settings) {
  const tls = findTimelines(lines, settings);
  if (tls.length) return tls;
  const h = lines.findIndex(l => /^#{1,6}\s.*(today|tomorrow)/i.test(l));
  if (h < 0) return [];
  let b = lines.findIndex((l, i) => i > h && /^#{1,6}\s/.test(l));
  if (b < 0) b = lines.length;
  return [{ anchor: h, tasks: [], start: h, end: b, empty: true, tomorrow: /tomorrow/i.test(lines[h]) }];
}
function planFirstTask(lines, tl, start, end, rest, S) {
  const fresh = findBlocks(lines, S).find(x => x.start === tl.start) || tl;
  const style = S.writeFormat === '12h' ? '12' : '24';
  const times = `(${fmtWrite(start, style)}-${fmtWrite(end, style)}) `;
  for (let i = fresh.start + 1; i < fresh.end; i++) {
    const m = PLACEHOLDER_RE.exec(lines[i]);
    if (m) return { type: 'replace', i, text: `${m[1]} ${m[3]}${times}${rest || ''}` };
  }
  return { type: 'insert', i: fresh.anchor + 1, text: `- [ ] ${times}${rest || ''}` };
}
function relDay(d) {
  if (!d) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const n = Math.round((x - t) / 86400000);
  const text = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : n > 1 ? `In ${n} days` : `${-n} days ago`;
  return { text, cls: n === 0 ? 'qtl-day-today' : n > 0 ? 'qtl-day-future' : 'qtl-day-past' };
}
function dayBadge(date) {
  const r = relDay(date);
  return r ? el('span', 'qtl-day ' + r.cls, r.text) : null;
}

function noteDate(path, tomorrow) {
  const name = (path || '').split('/').pop();
  const m = /^(\d{2})\.(\d{2})\.(\d{2})/.exec(name || '');
  if (!m) return null;
  const d = new Date(2000 + +m[1], +m[2] - 1, +m[3]);
  if (tomorrow) d.setDate(d.getDate() + 1);
  return d;
}
function sameDay(a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* ---------- writing lines back ---------- */

const fmtClock = m => { m = ((m % 1440) + 1440) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const fmtDur = m => { const h = Math.floor(m / 60), r = m % 60; return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`; };
function fmtWrite(m, style) {
  m = ((m % 1440) + 1440) % 1440;
  const mm = String(m % 60).padStart(2, '0');
  if (style === '12') return `${(Math.floor(m / 60) % 12) || 12}:${mm}`;
  return `${Math.floor(m / 60)}:${mm}`;
}
function styleFor(t, tasks, S) {
  if (S.writeFormat === '24h') return '24';
  if (S.writeFormat === '12h') return '12';
  if (t && t.style) return t.style;
  const styles = (tasks || []).map(x => x.style).filter(Boolean);
  return styles.includes('12') && !styles.includes('24') ? '12' : '24';
}
function buildLine(t, ch, style) {
  const start = ch.start ?? t.start, end = ch.end ?? t.end;
  const open = ch.open ?? t.open;
  const done = ch.done ?? t.done;
  const check = ch.done === undefined ? t.check : (done ? 'x' : ' ');
  const color = ch.color === undefined ? t.color : ch.color;
  let rest = (ch.rest ?? t.rest).replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
  if (color) rest = rest ? `${rest} ${color}` : color;
  const e = open ? (t.open && t.endRaw ? t.endRaw : '?') : fmtWrite(end, style);
  return `${t.pre}${check}${t.mid}(${fmtWrite(start, style)}-${e}) ${rest}`.replace(/\s+$/, '');
}

/* Pure planners: given current lines, return one edit op (or null). */
function locate(lines, t) {
  if (lines[t.line] !== undefined && lines[t.line].replace(/\r$/, '') === t.raw) return t.line;
  return lines.findIndex(l => l.replace(/\r$/, '') === t.raw);
}
function planInsert(lines, tl, start, end, rest, S) {
  const proto = tl.tasks[0];
  const style = styleFor(null, tl.tasks, S);
  const text = `${proto.pre} ${proto.mid}(${fmtWrite(start, style)}-${fmtWrite(end, style)}) ${rest || ''}`;
  // place in time order within the section
  const fresh = findTimelines(lines, S).find(x => x.start === tl.start) || tl;
  const after = fresh.tasks.find(x => x.start > start);
  const i = after ? after.line : fresh.tasks[fresh.tasks.length - 1].line + 1;
  return { type: 'insert', i, text };
}
function applyOp(lines, op) {
  if (!op) return lines;
  if (op.type === 'replace') lines[op.i] = op.text;
  else if (op.type === 'insert') lines.splice(op.i, 0, op.text);
  else if (op.type === 'remove') lines.splice(op.i, 1);
  return lines;
}
/* Insert a task line into the Today/Tomorrow section of another note's text. */
function insertIntoDay(data, text, S) {
  const lines = data.split('\n');
  const newT = parseTasks([text], 0, S)[0];
  let h = lines.findIndex(l => /^#{1,6}\s.*(today|tomorrow)/i.test(l));
  if (h < 0) h = lines.findIndex(l => /^#{1,6}\s/.test(l));
  if (h < 0) { lines.unshift(text); return lines.join('\n'); }
  let end = lines.findIndex((l, i) => i > h && /^#{1,6}\s/.test(l));
  if (end < 0) end = lines.length;
  const sec = parseTasks(lines.slice(h, end), h, S);
  const after = newT ? sec.find(x => x.start > newT.start) : null;
  let i;
  if (after) i = after.line;
  else {
    i = end - 1;
    while (i > h && !/^\s*[-*+]\s/.test(lines[i])) i--;
    i += 1;
  }
  lines.splice(i, 0, text);
  return lines.join('\n');
}

/* ---------- rendering ---------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function colorFor(t, S) {
  if (t.color && EMOJI_HEX[t.color]) return EMOJI_HEX[t.color];
  const map = S.tagColors || {};
  for (const tag of t.tags) {
    const k = Object.keys(map).find(x => x.toLowerCase() === tag.toLowerCase());
    if (k) return map[k];
  }
  return S.defaultColor || null;
}

function layoutColumns(tasks) {
  const sorted = tasks.map((t, i) => ({ t, i })).sort((a, b) => a.t.start - b.t.start || b.t.end - a.t.end);
  const res = new Array(tasks.length);
  let cluster = [], clusterEnd = -1, cols = [];
  const flush = () => { const n = cols.length; cluster.forEach(c => { res[c.i].cols = n; }); cluster = []; cols = []; };
  for (const s of sorted) {
    if (s.t.start >= clusterEnd) { flush(); clusterEnd = -1; }
    let col = cols.findIndex(endAt => endAt <= s.t.start);
    if (col < 0) { col = cols.length; cols.push(0); }
    cols[col] = s.t.end;
    res[s.i] = { col, cols: 1 };
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.t.end);
  }
  flush();
  return res;
}

function freeGaps(tasks) {
  const iv = tasks.map(t => [t.start, t.end]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of iv) {
    if (merged.length && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    else merged.push([s, e]);
  }
  const gaps = [];
  for (let i = 1; i < merged.length; i++) if (merged[i][0] - merged[i - 1][1] >= 5) gaps.push([merged[i - 1][1], merged[i][0]]);
  return { gaps, busy: merged.reduce((a, [s, e]) => a + e - s, 0) };
}

/*
 opts: { today, now(), date (Date|null), isMobile, collapsed, onToggleCollapse(), api }
 api:  { update(t, changes), insert(tl, start, end), remove(t), goto(t), moveToDate(t, changes, isoDate), canFocus }
*/
function renderTimeline(tl, settings, opts = {}) {
  const S = Object.assign({}, DEFAULT_SETTINGS, settings);
  const tasks = tl.tasks;
  const minS = Math.min(...tasks.map(t => t.start));
  const maxE = Math.max(...tasks.map(t => t.end));
  let ws;
  if (S.startMode === 'first') ws = Math.floor(minS / 60) * 60;
  else if (S.startMode === 'fixed') ws = Math.min(S.fixedStartHour * 60, Math.floor(minS / 60) * 60);
  else ws = Math.floor((minS - S.leadMinutes) / 60) * 60;
  let we = Math.ceil((maxE + S.trailMinutes) / 60) * 60;
  // on today's note, stretch the window (up to 4h each way) so the now-line is visible
  if (opts.today) {
    const d0 = opts.now ? opts.now() : new Date();
    const n0 = d0.getHours() * 60 + d0.getMinutes();
    if (n0 < ws && ws - n0 <= 240) ws = Math.floor(n0 / 60) * 60;
    if (n0 > we && n0 - we <= 240) we = Math.ceil((n0 + 15) / 60) * 60;
  }
  ws = Math.max(0, ws);
  const pxm = S.pxPerHour / 60;
  const y = m => (m - ws) * pxm;
  const maxH = opts.isMobile ? S.mobileMaxHeight : S.maxHeight;

  const root = el('div', 'qtl');
  if (opts.collapsed) root.classList.add('qtl-collapsed');
  if (opts.api) root.classList.add('qtl-interactive');
  const { gaps, busy } = freeGaps(tasks);
  const free = gaps.reduce((a, [s, e]) => a + e - s, 0);
  const head = el('div', 'qtl-head');
  const chev = el('span', 'qtl-chev', opts.collapsed ? '▸' : '▾');
  head.append(
    chev,
    el('span', 'qtl-head-range', `${fmtClock(minS)} → ${fmtClock(maxE)}`),
    el('span', 'qtl-head-stat', `${fmtDur(busy)} planned`),
    el('span', 'qtl-head-stat', free ? `${fmtDur(free)} free` : 'back-to-back'),
  );
  const nextLine = el('span', 'qtl-head-next');
  head.append(el('span', 'qtl-spacer'), nextLine);
  const badge = dayBadge(opts.date);
  if (badge) head.append(badge);
  if (opts.onToggleCollapse) {
    head.classList.add('qtl-head-toggle');
    head.addEventListener('mousedown', e => e.preventDefault());
    head.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); opts.onToggleCollapse(); });
  }
  root.append(head);

  const scroll = el('div', 'qtl-scroll');
  scroll.style.maxHeight = maxH + 'px';
  const grid = el('div', 'qtl-grid');
  grid.style.height = (we - ws) * pxm + 'px';

  for (let m = ws; m <= we; m += 30) {
    const line = el('div', m % 60 ? 'qtl-line qtl-half' : 'qtl-line');
    line.style.top = y(m) + 'px';
    if (m % 60 === 0 && m < we) line.append(el('span', 'qtl-hour-label', fmtClock(m)));
    grid.append(line);
  }

  const lane = el('div', 'qtl-lane');
  for (const [s, e] of gaps) {
    const g = el('div', 'qtl-gap');
    g.style.top = y(s) + 'px';
    g.style.height = (e - s) * pxm + 'px';
    if ((e - s) * pxm < 16) g.classList.add('qtl-tight');
    g.append(el('span', 'qtl-gap-label', `${fmtDur(e - s)} free`));
    lane.append(g);
  }

  const cols = layoutColumns(tasks);
  const metaText = (t, s, e, open) => `${t.tags.length ? t.tags.map(x => '#' + x).join(' ') + ' · ' : ''}${fmtClock(s)}–${open ? '?' : fmtClock(e)} · ${open ? 'open-ended' : fmtDur(e - s)}`;
  tasks.forEach((t, i) => {
    const b = el('div', 'qtl-block');
    b._qtlTask = t;
    const h = (t.end - t.start) * pxm;
    b.style.top = y(t.start) + 'px';
    b.style.height = Math.max(h, 12) - 2 + 'px';
    b.style.left = `calc(${(cols[i].col / cols[i].cols) * 100}% + 2px)`;
    b.style.width = `calc(${100 / cols[i].cols}% - 4px)`;
    const c = colorFor(t, S);
    if (c) b.style.setProperty('--qtl-c', c);
    if (t.done) b.classList.add('qtl-done');
    if (t.open) b.classList.add('qtl-open');
    if (h < 34) b.classList.add('qtl-compact');
    b.append(el('span', 'qtl-title', t.title), el('span', 'qtl-meta', metaText(t, t.start, t.end, t.open)));
    if (opts.api) b.append(el('div', 'qtl-handle'));
    lane.append(b);
  });
  grid.append(lane);

  let nowEl = null, timer = null;
  const nowMinutes = () => { const d = opts.now ? opts.now() : new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const updateNow = () => {
    nextLine.textContent = '';
    if (!opts.today) return;
    const n = nowMinutes();
    if (n >= ws && n <= we) {
      if (!nowEl) { nowEl = el('div', 'qtl-now'); nowEl.append(el('span', 'qtl-now-label')); grid.append(nowEl); }
      nowEl.style.display = '';
      nowEl.style.top = y(n) + 'px';
      nowEl.firstChild.textContent = fmtClock(n);
    } else if (nowEl) nowEl.style.display = 'none';
    const cur = tasks.find(t => t.start <= n && n < t.end && !t.done);
    const next = tasks.filter(t => t.start > n && !t.done).sort((a, b) => a.start - b.start)[0];
    if (cur) nextLine.textContent = `${cur.title}: ${fmtDur(cur.end - n)} left`;
    else if (next) nextLine.textContent = `${next.title} in ${fmtDur(next.start - n)}`;
  };
  updateNow();
  if (opts.today) {
    // tick on each minute boundary
    const d = new Date();
    timer = setTimeout(function tick() { updateNow(); timer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50); }, 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
  }

  scroll.append(grid);
  root.append(scroll);

  let closePopup = () => {};
  if (opts.api) {
    attachInteractions({ root, lane, scroll, tl, ws, we, pxm, S, opts, metaText, y,
      openPopup: (t, anchor) => { closePopup(); closePopup = openPopup(t, anchor, tl, S, opts); } });
  }
  const cleanupFn = () => { if (timer) clearTimeout(timer); closePopup(); };
  root._qtlCleanup = cleanupFn;

  if (opts.today && !opts.collapsed) {
    requestAnimationFrame(() => {
      const n = nowMinutes();
      if (n > ws && n < we && scroll.scrollHeight > scroll.clientHeight) scroll.scrollTop = Math.max(0, y(n) - scroll.clientHeight / 3);
    });
  }
  return wrapNav(root, S, opts, cleanupFn);
}

/* Shown when a day note has no timed tasks yet: header + one full-width Add bar. */
function renderEmpty(tl, settings, opts = {}) {
  const S = Object.assign({}, DEFAULT_SETTINGS, settings);
  const root = el('div', 'qtl qtl-empty');
  const head = el('div', 'qtl-head');
  head.append(el('span', 'qtl-head-stat', 'No times yet'), el('span', 'qtl-spacer'));
  const badge = dayBadge(opts.date);
  if (badge) head.append(badge);
  root.append(head);
  if (opts.api) {
    const add = el('div', 'qtl-add');
    add.style.height = S.pxPerHour + 'px';
    add.append(el('span', 'qtl-add-plus', '+'), el('span', 'qtl-add-text', 'Add a 1-hour block'));
    const pickStart = () => {
      if (opts.today) { const d = new Date(); return Math.min(23 * 60, (d.getHours() + (d.getMinutes() ? 1 : 0)) * 60); }
      return S.fixedStartHour * 60;
    };
    add.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    add.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const a = pickStart();
      opts.api.insertFirst(tl, a, a + 60);
    });
    root.append(add);
  }
  return wrapNav(root, S, opts, () => {});
}

function wrapNav(root, S, opts, cleanupFn) {
  root._qtlCleanup = cleanupFn;
  if (!opts.onNav) return root;
  // day-switch arrows outside the box
  const outer = el('div', 'qtl-outer');
  const arrow = (side) => {
    const step = (side === 'left' ? -1 : 1) * (S.swapArrows ? -1 : 1);
    const a = el('div', 'qtl-nav qtl-nav-' + side);
    a.innerHTML = side === 'left'
      ? '<svg viewBox="0 0 10 14" aria-hidden="true"><path d="M9 1 L1.5 7 L9 13 Z"/></svg>'
      : '<svg viewBox="0 0 10 14" aria-hidden="true"><path d="M1 1 L8.5 7 L1 13 Z"/></svg>';
    const word = step < 0 ? 'previous' : 'next';
    a.title = `Go to the ${word} day's note\nShift-click: open/create the day ${step < 0 ? 'before' : 'after'} this one`;
    a.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); opts.onNav(step, e.shiftKey); });
    return a;
  };
  outer.append(arrow('left'), root, arrow('right'));
  outer._qtlCleanup = cleanupFn;
  return outer;
}

/* ---------- drag / click ---------- */

function attachInteractions(c) {
  const { root, lane, scroll, tl, ws, we, pxm, S, opts, metaText, y } = c;
  const api = opts.api;
  const snap = S.snapMinutes || 15;
  const minAt = cy => ws + (cy - lane.getBoundingClientRect().top) / pxm;
  const sn = (m, f = 'round') => Math[f](m / snap) * snap;
  let st = null;

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    if (st && st.timer) clearTimeout(st.timer);
    if (st && st.ghost) st.ghost.remove();
    if (st && st.bEl) st.bEl.classList.remove('qtl-dragging');
    root.classList.remove('qtl-busy');
    st = null;
  };
  const restore = () => {
    if (st && st.bEl && st.t) {
      st.bEl.style.top = y(st.t.start) + 'px';
      st.bEl.style.height = Math.max((st.t.end - st.t.start) * pxm, 12) - 2 + 'px';
      st.bEl.querySelector('.qtl-meta').textContent = metaText(st.t, st.t.start, st.t.end, st.t.open);
    }
  };
  const activate = () => {
    st.active = true;
    root.classList.add('qtl-busy');
    try { lane.setPointerCapture(st.id); } catch (e) {}
    if (st.kind === 'create') {
      st.ghost = el('div', 'qtl-ghost');
      st.ghost.append(el('span', 'qtl-ghost-label'));
      lane.append(st.ghost);
    } else st.bEl.classList.add('qtl-dragging');
    update(st.lastY);
  };
  const update = cy => {
    const sr = scroll.getBoundingClientRect();
    if (cy < sr.top + 20) scroll.scrollTop -= 8; else if (cy > sr.bottom - 20) scroll.scrollTop += 8;
    const m = minAt(cy);
    if (st.kind === 'create') {
      let a = sn(Math.min(st.m0, m), 'floor'), b = sn(Math.max(st.m0, m), 'ceil');
      a = Math.max(ws, a); b = Math.min(we, b);
      if (b - a < snap) b = a + snap;
      st.a = a; st.b = b;
      st.ghost.style.top = y(a) + 'px';
      st.ghost.style.height = (b - a) * pxm + 'px';
      st.ghost.firstChild.textContent = `${fmtClock(a)}–${fmtClock(b)} · ${fmtDur(b - a)}`;
    } else if (st.kind === 'move') {
      const dur = st.t.end - st.t.start;
      let ns = sn(st.t.start + (m - st.m0));
      ns = Math.max(0, Math.min(1440 - dur, ns));
      st.a = ns; st.b = ns + dur;
      st.bEl.style.top = y(ns) + 'px';
      st.bEl.querySelector('.qtl-meta').textContent = metaText(st.t, ns, ns + dur, st.t.open);
    } else {
      const ne = Math.max(st.t.start + snap, sn(m));
      st.a = st.t.start; st.b = ne;
      st.bEl.style.height = (ne - st.t.start) * pxm - 2 + 'px';
      st.bEl.querySelector('.qtl-meta').textContent = metaText(st.t, st.t.start, ne, false);
    }
  };
  function onMove(e) {
    if (!st || e.pointerId !== st.id) return;
    st.lastY = e.clientY;
    const dist = Math.hypot(e.clientX - st.x0, e.clientY - st.y0);
    if (!st.active) {
      if (st.touch) { if (dist > 8) { cleanup(); } return; }   // let the page scroll
      if (dist > 4) activate(); else return;
    }
    e.preventDefault();
    update(e.clientY);
  }
  function onUp(e) {
    if (!st || e.pointerId !== st.id) return;
    const s = st;
    if (s.active) {
      if (s.kind === 'create') { cleanup(); api.insert(tl, s.a, s.b); }
      else if (s.kind === 'move') {
        if (s.a !== s.t.start) { cleanup(); api.update(s.t, { start: s.a, end: s.b }); }
        else { restore(); cleanup(); }
      } else {
        if (s.b !== s.t.end || s.t.open) { cleanup(); api.update(s.t, { end: s.b, open: false }); }
        else { restore(); cleanup(); }
      }
    } else {
      cleanup();
      if (s.t) c.openPopup(s.t, s.bEl);
    }
  }
  function onCancel(e) { if (st && e.pointerId === st.id) { restore(); cleanup(); } }

  lane.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (st) cleanup();
    const bEl = e.target.closest('.qtl-block');
    const t = bEl ? bEl._qtlTask : null;
    let kind = 'create';
    if (t) kind = e.target.classList.contains('qtl-handle') ? 'resize' : 'move';
    const touch = e.pointerType !== 'mouse';
    st = { id: e.pointerId, kind, t, bEl, x0: e.clientX, y0: e.clientY, lastY: e.clientY, m0: minAt(e.clientY), active: false, touch };
    if (touch) st.timer = setTimeout(() => { if (st && !st.active) activate(); }, 350);
    else e.preventDefault();
    e.stopPropagation();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  });
  // stop iPad scrolling once a long-press drag is active
  lane.addEventListener('touchmove', e => { if (st && st.active) e.preventDefault(); }, { passive: false });
  lane.addEventListener('contextmenu', e => { if (st) e.preventDefault(); });
}

/* ---------- popup editor ---------- */

function openPopup(t, anchor, tl, S, opts) {
  const api = opts.api;
  const pop = el('div', 'qtl-pop');
  const toTime = m => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const fromTime = v => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };

  const title = el('input', 'qtl-pop-title'); title.type = 'text'; title.value = t.rest; title.placeholder = 'Task (tags like #Ph work)';
  const row1 = el('div', 'qtl-pop-row');
  const sIn = el('input'); sIn.type = 'time'; sIn.step = 60 * (S.snapMinutes || 15); sIn.value = toTime(t.start);
  const eIn = el('input'); eIn.type = 'time'; eIn.step = 60 * (S.snapMinutes || 15); eIn.value = t.open ? '' : toTime(t.end);
  const dur = el('span', 'qtl-pop-dur');
  const refreshDur = () => {
    const a = fromTime(sIn.value), b = fromTime(eIn.value);
    if (a == null) { dur.textContent = ''; return; }
    if (b == null) { dur.textContent = 'open-ended'; return; }
    dur.textContent = fmtDur((b - a + 1440) % 1440 || 1440);
  };
  sIn.addEventListener('input', refreshDur); eIn.addEventListener('input', refreshDur); refreshDur();
  row1.append(sIn, el('span', 'qtl-pop-arrow', '→'), eIn, dur);

  let dIn = null;
  const row2 = el('div', 'qtl-pop-row');
  if (opts.date) {
    dIn = el('input'); dIn.type = 'date'; dIn.value = isoDate(opts.date);
    row2.append(el('span', 'qtl-pop-label', 'Day'), dIn);
  }

  let color = t.color;
  const sw = el('div', 'qtl-pop-swatches');
  const swatches = [];
  const mk = (emoji, hex, name) => {
    const s = el('button', 'qtl-sw');
    s.type = 'button'; s.title = name;
    if (hex) s.style.setProperty('--qtl-c', hex); else { s.classList.add('qtl-sw-auto'); s.textContent = 'A'; }
    s._emoji = emoji;
    s.addEventListener('click', ev => { ev.preventDefault(); color = emoji; swatches.forEach(x => x.classList.toggle('is-on', x._emoji === color)); });
    swatches.push(s); sw.append(s);
  };
  mk(null, null, 'Auto (tag / default colour)');
  COLOR_EMOJI.forEach(([e, h, n]) => mk(e, h, n));
  swatches.forEach(x => x.classList.toggle('is-on', x._emoji === color));

  let done = t.done;
  const actions = el('div', 'qtl-pop-row qtl-pop-actions');
  const doneB = el('button', 'qtl-btn', done ? '✓ Done' : '○ Not done');
  doneB.type = 'button';
  doneB.addEventListener('click', ev => { ev.preventDefault(); done = !done; doneB.textContent = done ? '✓ Done' : '○ Not done'; doneB.classList.toggle('is-on', done); });
  doneB.classList.toggle('is-on', done);
  const delB = el('button', 'qtl-btn qtl-btn-danger', 'Delete'); delB.type = 'button';
  let armed = false;
  delB.addEventListener('click', ev => {
    ev.preventDefault();
    if (!armed) { armed = true; delB.textContent = 'Confirm delete'; return; }
    close(); api.remove(t);
  });
  actions.append(doneB);
  if (api.canFocus) {
    const goB = el('button', 'qtl-btn', 'Go to line'); goB.type = 'button';
    goB.addEventListener('click', ev => { ev.preventDefault(); close(); api.goto(t); });
    actions.append(goB);
  }
  actions.append(delB, el('span', 'qtl-spacer'));
  const saveB = el('button', 'qtl-btn mod-cta', 'Save'); saveB.type = 'button';
  actions.append(saveB);

  pop.append(title, row1);
  if (dIn) pop.append(row2);
  pop.append(sw, actions);

  const save = () => {
    const a = fromTime(sIn.value);
    if (a == null) { sIn.focus(); return; }
    let b = fromTime(eIn.value);
    const ch = { rest: title.value.trim(), done, color, start: a };
    if (b == null) ch.open = true;
    else { if (b <= a) b += 1440; ch.end = b; ch.open = false; }
    close();
    const newDate = dIn && dIn.value && dIn.value !== isoDate(opts.date) ? dIn.value : null;
    if (newDate) api.moveToDate(t, ch, newDate);
    else api.update(t, ch);
  };
  saveB.addEventListener('click', ev => { ev.preventDefault(); save(); });
  pop.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  });

  document.body.append(pop);
  // position
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  if (vw < 520) pop.classList.add('qtl-pop-sheet');
  else {
    let left = r.right + 8;
    if (left + pw > vw - 8) left = Math.max(8, r.left - pw - 8);
    if (left < 8) left = Math.max(8, Math.min(vw - pw - 8, r.left));
    let top = Math.max(8, Math.min(vh - ph - 8, r.top));
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }

  const outside = ev => { if (!pop.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    document.removeEventListener('pointerdown', outside, true);
    pop.remove();
  }
  if (!opts.isMobile) setTimeout(() => title.focus(), 0);
  return close;
}

/* ---------- Obsidian glue ---------- */

const DATE_NAME_RE = /^\d{2}\.\d{2}\.\d{2}\b/;
/* Folder setting empty: any note whose name starts with YY.MM.DD.
   Otherwise: notes inside any folder whose name matches (comma-separated, matched anywhere in the path). */
function isTarget(path, folder) {
  if (!path || !/\.md$/i.test(path)) return false;
  const name = path.split('/').pop();
  const fs = (folder || '').split(',').map(f => f.trim().replace(/^\/+|\/+$/g, '').toLowerCase()).filter(Boolean);
  if (!fs.length) return DATE_NAME_RE.test(name);
  const dir = '/' + path.toLowerCase().split('/').slice(0, -1).join('/') + '/';
  return fs.some(f => dir.includes('/' + f + '/'));
}
/* Matches a note that is still exactly the template ({{...}} tokens match anything on that line), or blank. */
function templateMatcher(tplText) {
  const norm = t => t.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  const parts = norm(tplText).split(/{{[^}]*}}/);
  const re = new RegExp('^' + parts.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\n]*?') + '$');
  return text => text.trim() === '' || re.test(norm(text));
}
const parentDir = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/* Make the api for one timeline, on top of an accessor that applies a planned op. */
function makeApi(plugin, acc, tl, path) {
  const S = plugin.settings;
  const style = t => styleFor(t, tl.tasks, S);
  const run = planner => acc.run(planner);
  return {
    canFocus: !!acc.focusLine,
    update(t, ch) {
      return run(lines => { const i = locate(lines, t); return i < 0 ? null : { type: 'replace', i, text: buildLine(t, ch, style(t)) }; });
    },
    remove(t) {
      return run(lines => { const i = locate(lines, t); return i < 0 ? null : { type: 'remove', i }; });
    },
    async insertFirst(tl2, a, b) {
      const op = await run(lines => planFirstTask(lines, tl2, a, b, acc.focusLine ? '' : 'New task', S));
      if (op && acc.focusLine) acc.focusLine(op.i);
    },
    async insert(tl2, a, b) {
      const op = await run(lines => planInsert(lines, tl2, a, b, acc.focusLine ? '' : 'New task', S));
      if (op && acc.focusLine) acc.focusLine(op.i);
    },
    goto(t) { run(lines => { const i = locate(lines, t); if (i >= 0) acc.focusLine(i); return null; }); },
    async moveToDate(t, ch, iso) {
      const text = buildLine(t, ch, style(t));
      try {
        const target = await plugin.insertIntoDate(text, iso, path);
        await run(lines => { const i = locate(lines, t); return i < 0 ? null : { type: 'remove', i }; });
        new obsidian.Notice(`Moved to ${target.basename}`);
      } catch (err) {
        console.error(err);
        new obsidian.Notice('Quotidian Timeline: could not move task — ' + err.message);
      }
    },
  };
}

let PluginBase = obsidian ? obsidian.Plugin : class {};

class QuotidianTimelinePlugin extends PluginBase {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.tagColors = Object.assign({}, data.tagColors || DEFAULT_SETTINGS.tagColors);
    const plugin = this;
    const isMobile = !!(obsidian.Platform && obsidian.Platform.isMobile);
    this.isMobile = isMobile;
    const { WidgetType, Decoration, EditorView } = cmView;
    const { StateField, StateEffect, RangeSetBuilder } = cmState;
    const refresh = StateEffect.define();
    this._refresh = refresh;

    const toggle = () => {
      const k = isMobile ? 'collapsedMobile' : 'collapsedDesktop';
      plugin.settings[k] = !plugin.settings[k];
      plugin.saveSettings();
    };
    const collapsed = () => plugin.settings[isMobile ? 'collapsedMobile' : 'collapsedDesktop'];

    class TimelineWidget extends WidgetType {
      constructor(tl, path) {
        super();
        this.tl = tl; this.path = path;
        this.key = JSON.stringify([tl.tasks, tl.start, tl.end, tl.anchor, tl.empty, tl.tomorrow, path, plugin.settings, new Date().toDateString()]);
      }
      eq(o) { return o.key === this.key; }
      toDOM(view) {
        const acc = {
          run(planner) {
            const lines = view.state.doc.toString().split('\n');
            const op = planner(lines);
            if (!op) return Promise.resolve(null);
            const doc = view.state.doc;
            if (op.type === 'replace') {
              const l = doc.line(op.i + 1);
              view.dispatch({ changes: { from: l.from, to: l.to, insert: op.text } });
            } else if (op.type === 'insert') {
              if (op.i < doc.lines) view.dispatch({ changes: { from: doc.line(op.i + 1).from, insert: op.text + '\n' } });
              else view.dispatch({ changes: { from: doc.length, insert: '\n' + op.text } });
            } else if (op.type === 'remove') {
              const l = doc.line(op.i + 1);
              if (op.i + 1 < doc.lines) view.dispatch({ changes: { from: l.from, to: doc.line(op.i + 2).from } });
              else view.dispatch({ changes: { from: op.i > 0 ? doc.line(op.i).to : l.from, to: l.to } });
            }
            return Promise.resolve(op);
          },
          focusLine(i) {
            const l = view.state.doc.line(Math.min(i + 1, view.state.doc.lines));
            view.dispatch({ selection: { anchor: l.to }, scrollIntoView: true });
            view.focus();
          },
        };
        const date = noteDate(this.path, this.tl.tomorrow);
        const wrap = document.createElement('div');
        wrap.className = 'qtl-cm-wrap';
        try {
          wrap.append((this.tl.empty ? renderEmpty : renderTimeline)(this.tl, plugin.settings, {
            today: sameDay(date, new Date()), date, isMobile,
            collapsed: collapsed(), onToggleCollapse: toggle,
            onNav: (step, create) => plugin.navDay(this.path, step, create),
            api: makeApi(plugin, acc, this.tl, this.path),
          }));
        } catch (err) {
          console.error('[Quotidian Timeline]', err);
          wrap.className = 'qtl-error';
          wrap.textContent = 'Quotidian Timeline hit an error: ' + err.message;
        }
        return wrap;
      }
      destroy(dom) { const r = dom.firstChild; if (r && r._qtlCleanup) r._qtlCleanup(); }
      ignoreEvent() { return true; }
      get estimatedHeight() { return collapsed() ? 32 : 32 + (isMobile ? plugin.settings.mobileMaxHeight : plugin.settings.maxHeight) / 2; }
    }

    const build = state => {
      const info = state.field(obsidian.editorInfoField, false);
      const path = info && info.file && info.file.path;
      if (!isTarget(path, plugin.settings.folder)) return Decoration.none;
      try {
        const lines = state.doc.toString().split('\n');
        const b = new RangeSetBuilder();
        for (const tl of findBlocks(lines, plugin.settings)) {
          const line = state.doc.line(tl.anchor + 1);
          b.add(line.to, line.to, Decoration.widget({ widget: new TimelineWidget(tl, path), block: true, side: 1 }));
        }
        return b.finish();
      } catch (err) {
        console.error('[Quotidian Timeline]', err);
        return Decoration.none;
      }
    };

    const field = StateField.define({
      create: build,
      update(deco, tr) {
        if (tr.docChanged || tr.effects.some(e => e.is(refresh))) return build(tr.state);
        return deco.map(tr.changes);
      },
      provide: f => EditorView.decorations.from(f),
    });
    this.registerEditorExtension(field);

    // Reading view
    this.registerMarkdownPostProcessor((elem, ctx) => { try {
      if (!isTarget(ctx.sourcePath, this.settings.folder)) return;
      const info = ctx.getSectionInfo(elem);
      if (!info) return;
      const all = info.text.split('\n');
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      const acc = {
        async run(planner) {
          let op = null;
          await plugin.app.vault.process(file, d => { const lines = d.split('\n'); op = planner(lines); return applyOp(lines, op).join('\n'); });
          return op;
        },
      };
      for (const tl of findBlocks(all, this.settings)) {
        if (tl.anchor < info.lineStart || tl.anchor > info.lineEnd) continue;
        const holder = document.createElement('div');
        holder.className = 'qtl-reading-wrap';
        const date = noteDate(ctx.sourcePath, tl.tomorrow);
        const r = (tl.empty ? renderEmpty : renderTimeline)(tl, this.settings, {
          today: sameDay(date, new Date()), date, isMobile,
          collapsed: collapsed(), onToggleCollapse: toggle,
          onNav: (step, create) => plugin.navDay(ctx.sourcePath, step, create),
          api: file ? makeApi(plugin, acc, tl, ctx.sourcePath) : null,
        });
        holder.append(r);
        elem.append(holder);
        const child = new obsidian.MarkdownRenderChild(holder);
        child.onunload = () => r._qtlCleanup && r._qtlCleanup();
        ctx.addChild(child);
      }
    } catch (err) { console.error('[Quotidian Timeline]', err); } });

    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshAll()));
    this.app.workspace.onLayoutReady(() => this.refreshAll());
    this.addSettingTab(new QTLSettingTab(this.app, this));
    const activePath = () => { const f = this.app.workspace.getActiveFile(); return f && f.path; };
    const cmd = (id, name, step, create) => this.addCommand({ id, name, callback: () => { const p = activePath(); if (p) this.navDay(p, step, create); } });
    cmd('prev-day-note', 'Go to previous day note', -1, false);
    cmd('next-day-note', 'Go to next day note', 1, false);
    cmd('create-prev-day-note', 'Open/create the day before', -1, true);
    cmd('create-next-day-note', 'Open/create the day after', 1, true);
    this.app.workspace.onLayoutReady(() => {
      // give sync a moment to bring in edits from other devices before judging notes empty
      setTimeout(() => { if (this.settings.cleanupEnabled) this.runCleanup(false); }, 30000);
    });
    this.registerInterval(window.setInterval(() => { if (this.settings.cleanupEnabled) this.runCleanup(false); }, 6 * 3600 * 1000));
    this.addCommand({ id: 'cleanup-empty-day-notes', name: 'Clean up empty day notes now', callback: () => this.runCleanup(true) });
    console.log(`[Quotidian Timeline] v${VERSION} loaded`);
  }

  async insertIntoDate(text, iso, sourcePath) {
    const m = window.moment(iso, 'YYYY-MM-DD');
    const S = this.settings;
    const prefix = m.format('YY.MM.DD');
    const dir = parentDir(sourcePath || '');
    const candidates = this.app.vault.getMarkdownFiles().filter(f => f.basename.startsWith(prefix) && !/template/i.test(f.basename));
    let file = candidates.find(f => f.parent && f.parent.path === (dir || '/')) || candidates.find(f => isTarget(f.path, S.folder));
    if (!file) file = await this.createDayNote(m, dir);
    await this.app.vault.process(file, d => insertIntoDay(d, text, S));
    return file;
  }

  dayNotes(dir) {
    const S = this.settings;
    const all = this.app.vault.getMarkdownFiles()
      .filter(f => DATE_NAME_RE.test(f.basename) && !/template/i.test(f.basename) && isTarget(f.path, S.folder));
    const same = all.filter(f => parentDir(f.path) === dir);
    return (same.length ? same : all).map(f => ({ f, d: noteDate(f.path, false) })).sort((a, b) => a.d - b.d);
  }

  async navDay(path, step, create) {
    try {
      const cur = noteDate(path, false);
      if (!cur) { new obsidian.Notice('This note is not a dated day note.'); return; }
      const dir = parentDir(path);
      const list = this.dayNotes(dir);
      let file;
      if (create) {
        const m = window.moment(cur).add(step, 'day');
        const hit = list.find(x => sameDay(x.d, m.toDate()));
        file = hit ? hit.f : await this.createDayNote(m, dir, true);
        if (!hit) new obsidian.Notice(`Created ${file.basename}`);
      } else {
        const hit = step > 0 ? list.find(x => x.d > cur) : list.filter(x => x.d < cur).pop();
        if (!hit) { new obsidian.Notice(step > 0 ? 'No later day note. Shift-click to create one.' : 'No earlier day note. Shift-click to create one.'); return; }
        file = hit.f;
      }
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (err) {
      console.error('[Quotidian Timeline]', err);
      new obsidian.Notice('Quotidian Timeline: ' + err.message);
    }
  }

  findTemplate(folder) {
    const files = this.app.vault.getMarkdownFiles().filter(f => /template/i.test(f.basename) && /checklist/i.test(f.basename) && !/weekly/i.test(f.basename));
    return files.find(f => parentDir(f.path) === folder) || files.find(f => /^YY\.MM\.DD/i.test(f.basename)) || null;
  }

  async findEmptyDayNotes() {
    const S = this.settings;
    const cutoff = window.moment().startOf('day').subtract(S.cleanupDays, 'days').toDate();
    const open = new Set(this.app.workspace.getLeavesOfType('markdown').map(l => l.view && l.view.file && l.view.file.path));
    const active = this.app.workspace.getActiveFile();
    if (active) open.add(active.path);
    const matchers = new Map();
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!DATE_NAME_RE.test(f.basename) || /template/i.test(f.basename) || !isTarget(f.path, S.folder)) continue;
      const d = noteDate(f.path, false);
      if (!d || d >= cutoff || open.has(f.path)) continue;
      const dir = parentDir(f.path);
      if (!matchers.has(dir)) {
        const tpl = this.findTemplate(dir);
        matchers.set(dir, tpl ? templateMatcher(await this.app.vault.cachedRead(tpl)) : (t => t.trim() === ''));
      }
      if (matchers.get(dir)(await this.app.vault.cachedRead(f))) out.push(f);
    }
    return out;
  }

  async runCleanup(manual) {
    if (this._cleaning) return;
    this._cleaning = true;
    try {
      const files = await this.findEmptyDayNotes();
      for (const f of files) {
        if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(f);
        else await this.app.vault.trash(f, true);
      }
      if (files.length || manual) new obsidian.Notice(files.length
        ? `Quotidian Timeline: moved ${files.length} empty day note${files.length > 1 ? 's' : ''} to trash`
        : 'Quotidian Timeline: no empty day notes to clean up');
    } catch (err) {
      console.error('[Quotidian Timeline] cleanup', err);
    } finally { this._cleaning = false; }
  }

  async createDayNote(m, folder, keepPlaceholders) {
    const name = m.format('YY.MM.DD, dddd, [W]WW [Checklist]');
    const tpl = this.findTemplate(folder);
    let body = '### Today:\n';
    if (tpl) {
      body = (await this.app.vault.read(tpl))
        .replace(/{{\s*date(?::([^}]+))?\s*}}/g, (_, fmt) => m.format(fmt ? fmt.trim() : 'YYYY-MM-DD'))
        .replace(/{{\s*title\s*}}/g, name)
        .split('\n').filter(l => keepPlaceholders || !/^\s*[-*+]\s+\[.\]\s+\(\s*time\s*-\s*time\s*\)/i.test(l)).join('\n');
    }
    return this.app.vault.create(`${folder ? folder + '/' : ''}${name}.md`, body);
  }

  refreshAll() {
    this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
      const v = leaf.view;
      const cm = v && v.editor && v.editor.cm;
      if (cm) cm.dispatch({ effects: this._refresh.of(null) });
      if (v && v.previewMode && v.getMode && v.getMode() === 'preview') v.previewMode.rerender(true);
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshAll();
  }
}

const SettingTabBase = obsidian ? obsidian.PluginSettingTab : class {};
class QTLSettingTab extends SettingTabBase {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; const p = this.plugin; const S = obsidian.Setting;
    containerEl.empty();
    const save = () => p.saveSettings();
    const num = (name, desc, key, min, max) => new S(containerEl).setName(name).setDesc(desc).addText(t => t
      .setValue(String(p.settings[key]))
      .onChange(async v => { const n = Number(v); if (v !== '' && !isNaN(n) && n >= min && n <= max) { p.settings[key] = n; await save(); } }));

    new S(containerEl).setName('Layout').setHeading();
    new S(containerEl).setName('Folder (optional)').setDesc('Leave empty: any note named like "26.10.08, Thursday…" gets a timeline, wherever it is. Or type folder names, comma-separated, e.g. "Quotidian".')
      .addText(t => t.setValue(p.settings.folder).onChange(async v => { p.settings.folder = v.trim(); await save(); }));
    new S(containerEl).setName('Timeline starts').setDesc('Where the visible window begins.')
      .addDropdown(d => d
        .addOption('lead', 'A lead-in before the first task')
        .addOption('first', 'At the first task')
        .addOption('fixed', 'At a fixed hour (start of workday)')
        .setValue(p.settings.startMode)
        .onChange(async v => { p.settings.startMode = v; await save(); }));
    num('Lead-in (minutes)', 'Used with "lead-in" mode.', 'leadMinutes', 0, 240);
    num('Workday start hour', 'Used with "fixed hour" mode (0–23).', 'fixedStartHour', 0, 23);
    num('Space after last task (minutes)', 'Room to drag new tasks below the last one.', 'trailMinutes', 0, 360);
    num('Pixels per hour', 'Vertical scale.', 'pxPerHour', 20, 200);
    num('Max height on desktop (px)', 'Taller timelines scroll inside this.', 'maxHeight', 120, 2000);
    num('Max height on phone/iPad (px)', '', 'mobileMaxHeight', 80, 2000);
    new S(containerEl).setName('Swap day arrows').setDesc('Off: ◀ = earlier day, ▶ = later day. On: the reverse.')
      .addToggle(t => t.setValue(p.settings.swapArrows).onChange(async v => { p.settings.swapArrows = v; await save(); }));

    new S(containerEl).setName('Editing').setHeading();
    num('Drag snap (minutes)', '', 'snapMinutes', 5, 60);
    new S(containerEl).setName('Write times as')
      .setDesc('Format used when dragging or the popup rewrites a line. "Match note" keeps 12h notes 12h.')
      .addDropdown(d => d.addOption('auto', 'Match note').addOption('24h', '24-hour (14:00)').addOption('12h', '12-hour (2:00)')
        .setValue(p.settings.writeFormat).onChange(async v => { p.settings.writeFormat = v; await save(); }));
    num('Morning cutoff hour', 'Bare times before this hour count as pm, so "2:30" = 14:30.', 'dayStartHour', 0, 12);

    new S(containerEl).setName('Colours').setHeading();
    containerEl.createEl('p', { cls: 'setting-item-description', text:
      'Priority: a colour emoji on the line (🔴🟠🟡🟢🔵🟣🟤⚫, set from the popup or typed) → the first tag with a colour below → the default colour.' });
    new S(containerEl).setName('Default colour').setDesc('For tasks with no tag colour. Reset to follow your theme accent.')
      .addColorPicker(cp => cp.setValue(p.settings.defaultColor || '#7f6df2').onChange(async v => { p.settings.defaultColor = v; await save(); }))
      .addExtraButton(b => b.setIcon('rotate-ccw').setTooltip('Use theme accent').onClick(async () => { p.settings.defaultColor = ''; await save(); this.display(); }));
    for (const tag of Object.keys(p.settings.tagColors)) {
      new S(containerEl).setName('#' + tag)
        .addColorPicker(cp => cp.setValue(p.settings.tagColors[tag]).onChange(async v => { p.settings.tagColors[tag] = v; await save(); }))
        .addExtraButton(b => b.setIcon('trash').setTooltip('Remove').onClick(async () => { delete p.settings.tagColors[tag]; await save(); this.display(); }));
    }
    let newTag = '';
    new S(containerEl).setName('Add a tag colour')
      .addText(t => t.setPlaceholder('e.g. ESAT').onChange(v => { newTag = v.replace(/^#/, '').trim(); }))
      .addButton(b => b.setButtonText('Add').onClick(async () => {
        if (!newTag || p.settings.tagColors[newTag]) return;
        p.settings.tagColors[newTag] = COLOR_EMOJI[Object.keys(p.settings.tagColors).length % COLOR_EMOJI.length][1];
        await save(); this.display();
      }));

    new S(containerEl).setName('Clean-up').setHeading();
    new S(containerEl).setName('Trash empty day notes')
      .setDesc('Day notes still exactly like your template (nothing typed, nothing ticked) get moved to trash once they are older than the days below. Runs on this device when Obsidian opens and every 6 hours. Recoverable from trash.')
      .addToggle(t => t.setValue(p.settings.cleanupEnabled).onChange(async v => { p.settings.cleanupEnabled = v; await save(); }));
    num('Older than (days)', 'Counted from the date in the note name.', 'cleanupDays', 1, 365);
    new S(containerEl).setName('Check now')
      .setDesc('Preview lists what would go, without deleting.')
      .addButton(b => b.setButtonText('Preview').onClick(async () => {
        const files = await p.findEmptyDayNotes();
        new obsidian.Notice(files.length ? 'Would trash:\n' + files.map(f => '• ' + f.basename).join('\n') : 'Nothing to clean up.', 8000);
      }))
      .addButton(b => b.setButtonText('Clean up now').setWarning().onClick(() => p.runCleanup(true)));

    const foot = containerEl.createDiv({ cls: 'qtl-version' });
    foot.setText(`Quotidian Timeline v${VERSION}`);
  }
}

module.exports = QuotidianTimelinePlugin;
module.exports.__test = { findBlocks, planFirstTask, renderEmpty, relDay, templateMatcher, isTarget, VERSION, parseTasks, findTimelines, renderTimeline, buildLine, planInsert, applyOp, insertIntoDay, locate, styleFor, DEFAULT_SETTINGS };
