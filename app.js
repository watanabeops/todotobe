/* TODOTOBE — メモとタスク
 *
 * 保存の形（変えると過去のデータが読めなくなる）
 *   - タスクは projectName / sectionName を文字列で持つ。親を消してもアーカイブが読める
 *   - 完了は completedAt を立てるだけ。移動しないので戻すのが安全
 *   - すべての項目が id と updatedAt を持つ。端末間の突き合わせは項目単位
 */

'use strict';

const KEY_STATE  = 'todotobe_state';
const KEY_CONFIG = 'todotobe_config';
const FIREBASE_SDK = '12.15.0';

/* Firebase のウェブ構成。秘密ではない（クライアントに配られる前提の値）。
   守っているのは Firestore のルールと同期キーのほうで、ここではない */
const DEFAULT_FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDK2Z0DwVCiQJgdeBtWLuT4nytLYaYekQk',
    authDomain: 'todotobe-62dcd.firebaseapp.com',
    projectId: 'todotobe-62dcd',
    storageBucket: 'todotobe-62dcd.firebasestorage.app',
    messagingSenderId: '144228111763',
    appId: '1:144228111763:web:0fe4b3452bc9aa31c14466'
};

/* 青・橙・紫・緑・赤・青緑・紺・灰。隣り合う色を最も離した順 */
const PALETTE = ['#3498db', '#f39c12', '#9b59b6', '#2ecc71', '#e74c3c', '#1abc9c', '#34495e', '#7f8c8d'];

/* 先頭4色は「固定枠」に予約する。枠は順番も色も動かない。
   5色目以降は、枠に入っていないタグへ自動で配る */
const DEFAULT_SLOTS = ['#映画', '#ビンセントベガ', '#家族', '#じぶん'];
const SLOTS = DEFAULT_SLOTS.length;
const AUTO_COLORS = PALETTE.slice(SLOTS);

const COLLECTIONS = ['projects', 'sections', 'tasks', 'notes'];

/* ============================================================
 * 状態
 * ============================================================ */
let state = { projects: [], sections: [], tasks: [], notes: [], tagColors: {}, tagSlots: DEFAULT_SLOTS.slice() };
let config = { enabled: false, firebaseConfig: DEFAULT_FIREBASE_CONFIG, key: '' };

let view = { kind: 'project', id: null };
let openNote = null;
let editing = null;              // {kind:'task-body'|'task-note'|..., id}
let memoH = 33;
let memoFolded = false;
const collapsed = new Set();
let searchQ = '';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now() + Math.round(Math.random() * 1e6));
const now = () => new Date().toISOString();

/* 保存はUTCのISO。表示は必ずこの端末の日付に直す。
   直さないと、日本時間の朝9時より前に完了したものが前日に並ぶ */
function localDay(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ============================================================
 * 保存（端末内）
 * ============================================================ */
function loadLocal() {
    try {
        const raw = localStorage.getItem(KEY_STATE);
        if (raw) {
            const p = JSON.parse(raw);
            COLLECTIONS.forEach(c => { if (Array.isArray(p[c])) state[c] = p[c]; });
            if (p.tagColors && typeof p.tagColors === 'object') state.tagColors = p.tagColors;
            if (Array.isArray(p.tagSlots)) state.tagSlots = normalizeSlots(p.tagSlots);
        }
    } catch (e) { console.error('保存データを読めませんでした', e); }
    try {
        const raw = localStorage.getItem(KEY_CONFIG);
        if (raw) config = Object.assign(config, JSON.parse(raw));
    } catch (e) { console.error('設定を読めませんでした', e); }
}
function saveLocal() {
    try { localStorage.setItem(KEY_STATE, JSON.stringify(state)); }
    catch (e) { console.error('端末への保存に失敗しました', e); toast('端末に保存できませんでした'); }
}
function saveConfig() {
    try { localStorage.setItem(KEY_CONFIG, JSON.stringify(config)); } catch (e) {}
}

/* ============================================================
 * 同期（Firestore）
 * 正本はFirestore側。端末内の保存は、開いた直後の表示と、
 * 同期を切っているときのための控えに回る。
 * ============================================================ */
let fb = null;                   // { fs, db, unsubs: [] }
let syncState = 'off';           // off | connecting | on | error
let syncError = '';

async function startSync(push) {
    stopSync();
    if (!config.enabled || !config.firebaseConfig || !config.key) { syncState = 'off'; return; }
    syncState = 'connecting'; syncError = ''; render();
    try {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK}`;
        const { initializeApp, getApps, deleteApp } = await import(`${base}/firebase-app.js`);
        const fs = await import(`${base}/firebase-firestore.js`);

        getApps().filter(a => a.name === 'todotobe').forEach(deleteApp);
        const app = initializeApp(config.firebaseConfig, 'todotobe');

        let db;
        try {
            db = fs.initializeFirestore(app, {
                localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
            });
        } catch (e) {
            db = fs.getFirestore(app);   // 端末が永続キャッシュを使えない場合
        }

        fb = { fs, db, unsubs: [] };

        if (push) await pushAll();

        COLLECTIONS.forEach(name => {
            const col = fs.collection(db, 'todotobe', config.key, name);
            fb.unsubs.push(fs.onSnapshot(col, snap => {
                snap.docChanges().forEach(ch => {
                    const arr = state[name];
                    const i = arr.findIndex(x => x.id === ch.doc.id);
                    if (ch.type === 'removed') { if (i >= 0) arr.splice(i, 1); return; }
                    const obj = Object.assign({}, ch.doc.data(), { id: ch.doc.id });
                    if (i < 0) arr.push(obj); else arr[i] = obj;
                });
                syncState = 'on';
                saveLocal();
                render();
                if (name === 'projects') ensureFirstProject();
                if (name === 'projects' || name === 'notes') migrateGreenMark();
            }, err => {
                syncState = 'error'; syncError = err.message; render();
            }));
        });

        const metaRef = fs.doc(db, 'todotobe', config.key);
        fb.unsubs.push(fs.onSnapshot(metaRef, d => {
            const m = d.data();
            if (!m) return;
            /* 向こうを優先する。手元を優先すると、2台が同時に同じ新タグへ
               別々の色を付けたとき、どちらも譲らず色が食い違ったままになる */
            if (m.tagColors) state.tagColors = Object.assign({}, state.tagColors, m.tagColors);
            if (Array.isArray(m.tagSlots)) state.tagSlots = normalizeSlots(m.tagSlots);
            saveLocal(); render();
        }, () => {}));

        syncState = 'on';
    } catch (e) {
        syncState = 'error'; syncError = e.message;
        console.error('同期を開始できませんでした', e);
    }
    render();
}

function stopSync() {
    if (fb) { fb.unsubs.forEach(u => { try { u(); } catch (e) {} }); }
    fb = null;
    syncState = 'off';
}

async function pushAll() {
    if (!fb) return;
    const { fs, db } = fb;
    for (const name of COLLECTIONS) {
        for (const obj of state[name]) {
            await fs.setDoc(fs.doc(db, 'todotobe', config.key, name, obj.id), strip(obj));
        }
    }
    await fs.setDoc(fs.doc(db, 'todotobe', config.key), { tagColors: state.tagColors, tagSlots: state.tagSlots, updatedAt: now() }, { merge: true });
}

function strip(obj) {
    const o = {};
    Object.keys(obj).forEach(k => { if (k !== 'id' && obj[k] !== undefined) o[k] = obj[k]; });
    return o;
}

/* 1件を書く。端末内とFirestoreの両方へ */
function put(name, obj) {
    obj.updatedAt = now();
    const arr = state[name];
    const i = arr.findIndex(x => x.id === obj.id);
    if (i < 0) arr.push(obj); else arr[i] = obj;
    saveLocal();
    if (fb) fb.fs.setDoc(fb.fs.doc(fb.db, 'todotobe', config.key, name, obj.id), strip(obj))
        .catch(e => { syncState = 'error'; syncError = e.message; render(); });
    return obj;
}

/* 1件を消す */
function drop(name, id) {
    state[name] = state[name].filter(x => x.id !== id);
    saveLocal();
    if (fb) fb.fs.deleteDoc(fb.fs.doc(fb.db, 'todotobe', config.key, name, id))
        .catch(e => { syncState = 'error'; syncError = e.message; render(); });
}

/* 色と枠は別々に書く。
   まとめて書くと、枠がまだ届いていない端末が色を1つ決めただけで
   空の枠まで書き込み、他の端末の枠の名前を消してしまう（実際に消えた） */
function putMetaField(field) {
    saveLocal();
    if (!fb) return;
    const patch = { updatedAt: now() };
    patch[field] = state[field];
    const ref = fb.fs.doc(fb.db, 'todotobe', config.key);
    /* setDoc の merge はマップを深く合成するので、消したキーが向こうから戻ってくる。
       updateDoc はフィールドごと置き換える。文書がまだ無いときだけ setDoc に落ちる */
    fb.fs.updateDoc(ref, patch)
        .catch(() => fb.fs.setDoc(ref, patch, { merge: true }).catch(() => {}));
}
const putColors = () => putMetaField('tagColors');
const putSlots = () => putMetaField('tagSlots');

/* ============================================================
 * タグ
 * ============================================================ */
const TAG_RE = /#[^\s#、。,.!?！？「」『』（）()]+/g;

function extractTags(text) {
    if (!text) return [];
    const m = String(text).match(TAG_RE);
    return m ? [...new Set(m)] : [];
}

function allTags() {
    const seen = [];
    const push = s => extractTags(s).forEach(g => { if (!seen.includes(g)) seen.push(g); });
    state.tasks.forEach(x => push(x.body));
    state.notes.forEach(x => push(x.title + ' ' + x.body));
    state.projects.forEach(p => push(p.scratch));
    return seen;
}

/* 枠は必ず SLOTS 個。中身は '#…' か空文字。
   空いている枠は既定値で1つずつ埋める（初回と、事故で消えたときの復帰）。
   自分で付けた名前は上書きしない */
function normalizeSlots(arr) {
    const out = [];
    for (let i = 0; i < SLOTS; i++) out.push(typeof (arr || [])[i] === 'string' ? (arr[i] || '') : '');
    /* 空いた枠は既定値で埋める。自分で付けた名前は上書きしない */
    for (let i = 0; i < SLOTS; i++) {
        if (!out[i] && !out.includes(DEFAULT_SLOTS[i])) out[i] = DEFAULT_SLOTS[i];
    }
    return out;
}
function slotIndexOf(tag) { return state.tagSlots.indexOf(tag); }

/* 「#催事」と打つ途中の「#催」にも色が割り当たり、そのたびに書き込みが走っていた。
   書き込みはまとめ、打ち終わって消えた途中経過は捨てる。
   捨てるのはこの回に生まれた分だけ（他の端末にしか無いタグを消さないため） */
const bornThisSession = new Set();
let colorTimer = null;
function scheduleColors() {
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => {
        const alive = new Set(allTags());
        bornThisSession.forEach(t => {
            if (!alive.has(t)) { delete state.tagColors[t]; bornThisSession.delete(t); }
        });
        putColors();
    }, 800);
}

/* 枠に入っているタグは、その枠の色。枠の外は残りの色から配る（枠の4色とは重ならない） */
function tagColor(tag) {
    const i = slotIndexOf(tag);
    if (i >= 0) return PALETTE[i];

    const cur = state.tagColors[tag];
    if (cur && AUTO_COLORS.includes(cur)) return cur;

    const used = {};
    AUTO_COLORS.forEach(c => used[c] = 0);
    Object.entries(state.tagColors).forEach(([t, c]) => {
        if (c in used && slotIndexOf(t) < 0) used[c]++;
    });
    state.tagColors[tag] = AUTO_COLORS.reduce((best, c) => used[c] < used[best] ? c : best, AUTO_COLORS[0]);
    bornThisSession.add(tag);
    scheduleColors();
    return state.tagColors[tag];
}

/* 枠にタグ名を割り当てる。'#' は無くても付ける */
function setSlot(i, raw) {
    let name = String(raw || '').trim().replace(/\s+/g, '');
    if (name && !name.startsWith('#')) name = '#' + name;
    if (name) state.tagSlots = state.tagSlots.map((v, k) => (v === name && k !== i) ? '' : v);  // 二重に置かない
    state.tagSlots[i] = name;
    if (name) { delete state.tagColors[name]; putColors(); }   // 枠の色を使うので、自動割り当ては捨てる
    putSlots();
    render();
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
/* ============================================================
 * マーカー
 * 保存は今までどおりの文字列。==ここ== が印。
 * ============================================================ */
/* 印は前後で同じ記号。== は最初からある黄色なので変えない。
   -- は「2026--08」のような普通の文字列と当たるので使わない */
const MARKS = [
    { d: '==', css: 'hl-y', label: '黄' },
    { d: '++', css: 'hl-p', label: 'ピンク' },
    { d: '::', css: 'hl-g', label: '緑' },
];
const MARK_RE = /(==|\+\+|::)([\s\S]+?)\1/g;

/* 緑は ~~ だったが、貼り先が Markdown だと打ち消し線になるので :: に変えた。
   古い ~~ は読み込んだときに書き換える */
const OLD_GREEN = /~~([\s\S]+?)~~/g;
function migrateGreenMark() {
    const fix = s => String(s == null ? '' : s).replace(OLD_GREEN, '::$1::');
    state.projects.forEach(p => {
        const next = fix(p.scratch);
        if (next !== p.scratch) { p.scratch = next; put('projects', p); }
    });
    state.notes.forEach(n => {
        const next = fix(n.body);
        if (next !== n.body) { n.body = next; put('notes', n); }
    });
}
const cssOf = d => (MARKS.find(m => m.d === d) || MARKS[0]).css;

/* 入力欄の裏に敷く。文字数を変えてはいけない（変えると色帯がずれる） */
function paintMark(text) {
    return esc(text).replace(MARK_RE, (_, d, inner) =>
        `<span class="hl ${cssOf(d)}"><span class="syn">${d}</span>${inner}<span class="syn">${d}</span></span>`);
}
/* 読むときは印を消す */
function renderMark(text) {
    return esc(text).replace(MARK_RE, (_, d, inner) => `<span class="hl ${cssOf(d)}">${inner}</span>`);
}
/* 検索や字数勘定のための素の文字列 */
const stripMark = text => String(text == null ? '' : text).replace(MARK_RE, '$2');

function syncBackdrop(ta) {
    const bd = ta.parentElement && ta.parentElement.querySelector('.backdrop');
    if (!bd) return;
    bd.innerHTML = paintMark(ta.value) + '\n';
    bd.scrollTop = ta.scrollTop;
}

function toggleMark(ta, d) {
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    /* 中身の無い印を置かせない。片割れが次の印と組んで、以降が全部ずれる */
    if (s === e) { ta.focus(); return toast('文字を選んでから押してください'); }

    const sel = v.slice(s, e);
    const wrapped = MARKS.find(m => sel.length > m.d.length * 2
        && sel.startsWith(m.d) && sel.endsWith(m.d));
    const around = MARKS.find(m => v.slice(s - m.d.length, s) === m.d && v.slice(e, e + m.d.length) === m.d);

    let ns, ne;
    if (wrapped) {                                   // 印ごと選んだ
        const inner = sel.slice(wrapped.d.length, -wrapped.d.length);
        const body = (wrapped.d === d) ? inner : d + inner + d;   // 同じ色なら外す、違えば塗り替え
        ta.value = v.slice(0, s) + body + v.slice(e);
        ns = s; ne = s + body.length;
    } else if (around) {                             // 内側だけ選んだ
        const L = around.d.length;
        const body = (around.d === d) ? sel : d + sel + d;
        ta.value = v.slice(0, s - L) + body + v.slice(e + L);
        ns = s - L; ne = ns + body.length;
    } else {                                         // 付ける
        ta.value = v.slice(0, s) + d + sel + d + v.slice(e);
        ns = s + d.length; ne = e + d.length;
    }
    ta.focus();
    ta.setSelectionRange(ns, ne);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function withTags(text) {
    return esc(text).replace(TAG_RE, m => `<span class="tag" style="background:${tagColor(m)}" data-tag="${esc(m)}">${m}</span>`);
}

/* ============================================================
 * 小道具
 * ============================================================ */
/* 日本語入力の変換確定と、入力の確定は、どちらもエンター。
   変換中のエンターで確定してしまわないよう、composition の状態を見る。
   Safari は確定のエンターより先に compositionend を出すことがあるので、
   直後のわずかな時間も変換扱いにする */
let composing = false;
let composingEndedAt = 0;
document.addEventListener('compositionstart', () => { composing = true; });
document.addEventListener('compositionend', () => { composing = false; composingEndedAt = Date.now(); });
function isImeEnter(e) {
    return composing || e.isComposing || e.keyCode === 229 || (Date.now() - composingEndedAt) < 30;
}

let toastTimer = null;
function toast(msg, actionLabel, onAction) {
    const el = document.getElementById('toast');
    el.innerHTML = esc(msg) + (actionLabel ? ` <button class="toast-act">${esc(actionLabel)}</button>` : '');
    el.classList.toggle('has-act', !!actionLabel);
    el.classList.add('on');
    if (actionLabel) {
        el.querySelector('.toast-act').onclick = () => { el.classList.remove('on'); onAction(); };
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), actionLabel ? 7000 : 2200);
}

/* 削除は訊かずに実行し、代わりに戻せるようにする。
   確認を外すなら、取り返しがつくようにしておかないと釣り合わない */
let lastUndo = null;
function softDelete(label, items) {
    items.forEach(it => drop(it.name, it.obj.id));
    lastUndo = items;
    render();
    toast(label, '元に戻す', () => {
        if (!lastUndo) return;
        lastUndo.forEach(it => put(it.name, it.obj));
        lastUndo = null;
        render();
        toast('戻しました');
    });
}

function inlineInput(row, onCommit) {
    const input = row.querySelector('input, textarea');
    if (!input) return;
    input.focus();
    if (input.select) input.select();
    let done = false;
    input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
            if (isImeEnter(ev)) return;          // 変換の確定なので、まだ閉じない
            ev.preventDefault();
            const v = input.value.trim();
            done = true;
            input.blur();          // 焦点を外してから描く。残すと描き直しが後回しになる
            if (v) onCommit(v); else render();
        } else if (ev.key === 'Escape') {
            if (isImeEnter(ev)) return;          // 変換の取り消しを奪わない
            done = true; render();
        }
    });
    input.addEventListener('blur', () => { if (!done) { done = true; render(); } });
}

/* 小さなメニュー */
function openMenu(x, y, items) {
    const m = document.getElementById('menu') || (() => {
        const d = document.createElement('div'); d.id = 'menu'; document.body.appendChild(d); return d;
    })();
    m.innerHTML = items.map((it, i) => `<div data-mi="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</div>`).join('');
    m.style.left = Math.min(x, window.innerWidth - 170) + 'px';
    m.style.top = Math.min(y, window.innerHeight - items.length * 34 - 16) + 'px';
    m.classList.add('on');
    m.onclick = e => {
        const n = e.target.closest('[data-mi]');
        if (!n) return;
        m.classList.remove('on');
        items[Number(n.dataset.mi)].run();
    };
}
function closeMenu() {
    const m = document.getElementById('menu');
    if (m) m.classList.remove('on');
}

/* ============================================================
 * 取り出し
 * ============================================================ */
const live = () => state.tasks.filter(x => !x.completedAt);
const archived = () => state.tasks.filter(x => x.completedAt)
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
const projectOf = id => state.projects.find(p => p.id === id);
const sectionsOf = pid => state.sections.filter(s => s.projectId === pid).sort(byOrder);
const nextOrder = arr => arr.reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;

function currentProject() {
    return projectOf(view.id) || state.projects[0] || null;
}

/* ============================================================
 * 描画
 * ============================================================ */
function go(v) {
    view = v;
    openNote = null;
    editing = null;
    document.body.classList.remove('nav-open');
    render();
}

function tagCount(g) {
    return live().filter(x => extractTags(x.body).includes(g)).length
        + state.notes.filter(x => extractTags(x.title + ' ' + x.body).includes(g)).length
        + state.projects.filter(p => extractTags(p.scratch).includes(g)).length;
}

function sideItem(ico, label, cnt, target, active) {
    return `<div class="side-item ${active ? 'active' : ''}" data-go="${target}">
        <span class="ico">${ico}</span><span class="nm">${esc(label)}</span>
        ${cnt ? `<span class="cnt">${cnt}</span>` : ''}</div>`;
}

function renderSidebar() {
    const h = [];
    h.push(sideItem('⚲', '検索', null, 'search', view.kind === 'search'));
    h.push(sideItem('≡', 'メモ', state.notes.length, 'memo', view.kind === 'memo'));
    h.push(sideItem('⧉', 'アーカイブ', archived().length, 'archive', view.kind === 'archive'));

    h.push('<div class="side-head">プロジェクト</div>');
    state.projects.slice().sort(byOrder).forEach(p => {
        const n = live().filter(x => x.projectId === p.id).length;
        const on = view.kind === 'project' && view.id === p.id;
        h.push(`<div class="side-item ${on ? 'active' : ''}" data-go="project:${p.id}">
            <span class="ico">▸</span><span class="nm">${esc(p.name)}</span>
            ${n ? `<span class="cnt">${n}</span>` : ''}
            <span class="dots" data-pmenu="${p.id}">⋯</span></div>`);
    });
    h.push(`<div class="side-item add" data-addproject="1"><span class="ico">＋</span><span class="nm">プロジェクト</span></div>`);

    h.push('<div class="side-head">タグ</div>');

    /* 固定枠。中身が空でも、順番と色は動かさずに出しておく */
    state.tagSlots.forEach((g, i) => {
        if (!g) {
            h.push(`<div class="side-item slot-empty" data-setslot="${i}">
                <span class="tag-dot" style="background:${PALETTE[i]}"></span>
                <span class="nm">枠${i + 1}</span></div>`);
            return;
        }
        h.push(`<div class="side-item ${view.kind === 'tag' && view.id === g ? 'active' : ''}" data-go="tag:${esc(g)}">
            <span class="tag-dot" style="background:${PALETTE[i]}"></span>
            <span class="nm">${esc(g)}</span>
            ${tagCount(g) ? `<span class="cnt">${tagCount(g)}</span>` : ''}
            <span class="dots" data-slotmenu="${i}">⋯</span></div>`);
    });

    /* 枠に入っていないタグ。五十音・アルファベット順 */
    allTags().filter(g => slotIndexOf(g) < 0)
        .sort((a, b) => a.localeCompare(b, 'ja'))
        .forEach(g => {
            h.push(`<div class="side-item ${view.kind === 'tag' && view.id === g ? 'active' : ''}" data-go="tag:${esc(g)}">
                <span class="tag-dot" style="background:${tagColor(g)}"></span>
                <span class="nm">${esc(g)}</span><span class="cnt">${tagCount(g)}</span></div>`);
        });

    /* 「同期」は下端に固定する。上のリストだけがスクロールする */
    const s = syncDot();
    document.getElementById('sidebar').innerHTML =
        `<div id="sideScroll">${h.join('')}</div>
         <div class="side-foot">
            <div class="side-item ${view.kind === 'settings' ? 'active' : ''}" data-go="settings" title="${esc(s.text)}">
                <span class="sync-dot ${s.cls}" style="background:${s.color}"></span>
                <span class="nm">同期</span>
            </div>
         </div>`;
}

/* 入切は色で見せる。緑＝つながっている、赤＝切れている、橙＝接続中 */
function syncDot() {
    if (!config.enabled) return { color: '#e74c3c', cls: '', text: '同期は切（この端末の中だけ）' };
    if (syncState === 'on') return { color: '#2ecc71', cls: '', text: 'つながっています' };
    if (syncState === 'connecting') return { color: '#f39c12', cls: 'pulse', text: '接続中…' };
    if (syncState === 'error') return { color: '#e74c3c', cls: 'pulse', text: 'エラー：' + (syncError || '接続できません') };
    return { color: '#e74c3c', cls: '', text: '停止中' };
}

function taskHTML(x, showSection) {
    if (editing && editing.kind === 'task-body' && editing.id === x.id) {
        return `<div class="task"><div class="check"></div><div class="task-body">
            <input class="task-edit" data-edittask="${x.id}" value="${esc(x.body)}"></div></div>`;
    }
    if (editing && editing.kind === 'task-note' && editing.id === x.id) {
        return `<div class="task"><div class="check"></div><div class="task-body">
            <div class="task-title">${withTags(x.body)}</div>
            <textarea class="task-edit" rows="3" data-editnote="${x.id}">${esc(x.note)}</textarea></div></div>`;
    }
    return `<div class="task">
        <div class="check" data-done="${x.id}"></div>
        <div class="task-body">
            <div class="task-title" data-opentask="${x.id}">${withTags(x.body)}</div>
            <div class="task-note ${x.note ? '' : 'empty-note'}" data-opennote="${x.id}">${x.note ? esc(x.note) : '説明'}</div>
            ${showSection && x.sectionName ? `<div class="task-meta">${esc(x.sectionName)}</div>` : ''}
        </div>
        <span class="kill" data-killtask="${x.id}">×</span></div>`;
}

function addRow(projectId, sectionId) {
    return `<div class="add-row" data-add="${projectId}|${sectionId || ''}">
        <span class="plus">＋</span><span>タスクを追加</span></div>`;
}

/* --- プロジェクト：上にMEMO、下にタスク --- */
function renderProject(p) {
    const mine = live().filter(x => x.projectId === p.id).sort(byOrder);
    const loose = mine.filter(x => !x.sectionId);

    const memo = `<div class="pane-memo ${memoFolded ? 'folded' : ''}" style="height:${memoFolded ? 'auto' : memoH + '%'}">
        <div class="bar-top">
            <span class="ttl">MEMO</span>
            <span class="spacer"></span>
            ${MARKS.map(m => `<button class="swatch ${m.css}" data-mark="1" data-d="${m.d}" title="マーカー（${m.label}）"></button>`).join('')}
            <button class="mini" data-cut="${p.id}">メモ切りだし</button>
            <button class="mini" data-foldmemo="1">${memoFolded ? '開く' : 'たたむ'}</button>
        </div>
        <div class="editor">
            <div class="backdrop">${paintMark(p.scratch)}
</div>
            <textarea data-scratch="${p.id}" placeholder="思いついたことをここへ。#タグ を書くと左のタグから引けます。">${esc(p.scratch)}</textarea>
        </div>
        ${(() => { const h = tagBarHTML(); return h ? `<div class="tagline">${h}</div>` : ''; })()}
    </div><div class="divider" id="divider"></div>`;

    let body = `<div class="wrap"><div class="crumb">プロジェクト /</div>
        <h1><span class="rename" data-renameproject="${p.id}">${esc(p.name)}</span></h1>`;
    body += loose.map(x => taskHTML(x)).join('') + addRow(p.id, null);

    sectionsOf(p.id).forEach(s => {
        const list = mine.filter(x => x.sectionId === s.id);
        const off = collapsed.has(s.id);
        const editingThis = editing && editing.kind === 'section' && editing.id === s.id;
        body += `<div class="section">
            <div class="section-head ${off ? 'collapsed' : ''}">
                <span class="caret" data-fold="${s.id}">▼</span>
                ${editingThis
                    ? `<input class="task-edit" data-editsection="${s.id}" value="${esc(s.name)}">`
                    : `<span class="nm" data-fold="${s.id}">${esc(s.name)}</span>
                       ${list.length ? `<span class="cnt">${list.length}</span>` : ''}
                       <span class="dots" data-smenu="${s.id}">⋯</span>`}</div>
            ${off ? '' : list.map(x => taskHTML(x)).join('') + addRow(p.id, s.id)}
        </div>`;
    });
    body += `<div class="add-row" data-addsection="${p.id}">
        <span class="plus">＋</span><span>セクションを追加</span></div></div>`;

    return memo + `<div class="pane-tasks">${body}</div>`;
}

/* --- タグ --- */
function renderTag(tag) {
    const ts = live().filter(x => extractTags(x.body).includes(tag)).sort(byOrder);
    const ns = state.notes.filter(x => extractTags(x.title + ' ' + x.body).includes(tag));
    const ss = state.projects.filter(p => extractTags(p.scratch).includes(tag));

    let h = `<div class="crumb">タグ /</div>
        <h1><span class="tag" style="background:${tagColor(tag)};font-size:20px;padding:2px 10px">${esc(tag)}</span></h1>`;
    if (!ts.length && !ns.length && !ss.length) return h + '<div class="empty">このタグの項目はありません。</div>';

    const byProject = {};
    ts.forEach(x => (byProject[x.projectName] = byProject[x.projectName] || []).push(x));
    Object.keys(byProject).forEach(name => {
        h += `<div class="group-label">${esc(name)}</div>`;
        h += byProject[name].map(x => taskHTML(x, true)).join('');
    });
    if (ss.length) {
        h += '<div class="group-label">MEMO</div>';
        h += ss.map(p => `<div class="note-card" data-go="project:${p.id}">
            <div class="nt">${esc(p.name)}</div>
            <div class="np">${renderMark(String(p.scratch).replace(/\n/g, ' '))}</div></div>`).join('');
    }
    if (ns.length) {
        h += '<div class="group-label">メモ</div>';
        h += ns.map(n => `<div class="note-card" data-note="${n.id}">
            <div class="nt">${esc(n.title)}</div>
            <div class="np">${renderMark(String(n.body).replace(/\n/g, ' '))}</div></div>`).join('');
    }
    return h;
}

/* --- 検索 --- */
function hit(text, q) { return String(text || '').toLowerCase().includes(q); }
/* 当たった箇所を全部光らせる。
   照合は素の文字列でやり、切ったあとに逃がす。
   逃がしてから探すと &amp; のような置き換えの途中で切れる */
function mark(text, q) {
    const raw = String(text == null ? '' : text);
    if (!q) return esc(raw);
    const low = raw.toLowerCase();
    let out = '', i = 0;
    for (;;) {
        const k = low.indexOf(q, i);
        if (k < 0) { out += esc(raw.slice(i)); break; }
        out += esc(raw.slice(i, k)) + '<mark>' + esc(raw.slice(k, k + q.length)) + '</mark>';
        i = k + q.length;
    }
    return out;
}
function renderSearch() {
    const q = searchQ.trim().toLowerCase();
    let h = `<div class="crumb">検索 /</div><h1>検索</h1>
        <input class="search-box" id="searchBox" placeholder="タスク・メモ・MEMOを探す" value="${esc(searchQ)}">`;
    if (!q) return h + '<div class="empty">語を入れてください。</div>';

    const ts = state.tasks.filter(x => hit(x.body, q) || hit(x.note, q));
    const ns = state.notes.filter(x => hit(x.title, q) || hit(stripMark(x.body), q));
    const ss = state.projects.filter(p => hit(stripMark(p.scratch), q));
    if (!ts.length && !ns.length && !ss.length) return h + '<div class="empty">見つかりませんでした。</div>';

    if (ts.length) {
        h += `<div class="group-label">タスク ${ts.length}件</div>`;
        h += ts.map(x => `<div class="task"><div class="check" data-done="${x.completedAt ? '' : x.id}"></div>
            <div class="task-body"><div class="task-title">${mark(x.body, q)}</div>
            ${x.note ? `<div class="task-note">${mark(x.note, q)}</div>` : ''}
            <div class="task-meta">${esc(x.projectName)}${x.sectionName ? ' / ' + esc(x.sectionName) : ''}${x.completedAt ? '　·　完了' : ''}</div>
            </div></div>`).join('');
    }
    if (ss.length) {
        h += `<div class="group-label">MEMO ${ss.length}件</div>`;
        h += ss.map(p => `<div class="note-card" data-go="project:${p.id}">
            <div class="nt">${esc(p.name)}</div><div class="np">${mark(stripMark(p.scratch).replace(/\n/g, ' '), q)}</div></div>`).join('');
    }
    if (ns.length) {
        h += `<div class="group-label">メモ ${ns.length}件</div>`;
        h += ns.map(n => `<div class="note-card" data-note="${n.id}">
            <div class="nt">${mark(n.title, q)}</div><div class="np">${mark(stripMark(n.body).replace(/\n/g, ' '), q)}</div></div>`).join('');
    }
    return h;
}

/* --- アーカイブ --- */
function renderArchive() {
    const list = archived();
    let h = `<div class="crumb">アーカイブ /</div><h1>アーカイブ</h1>
        <div class="bar">
            <button class="btn" data-export="1">JSONで書き出し</button>
            <button class="btn danger" data-purge="30">30日より前を削除</button>
            <button class="btn danger" data-purge="all">すべて削除</button>
        </div>`;
    if (!list.length) return h + '<div class="empty">アーカイブは空です。</div>';
    let day = '';
    list.forEach(x => {
        const d = localDay(x.completedAt);
        if (d !== day) { day = d; h += `<div class="arc-day">${d}</div>`; }
        h += `<div class="arc-item">
            <div class="done"><span class="t">${esc(x.body)}</span>
                <div class="task-meta">${esc(x.projectName)}${x.sectionName ? ' / ' + esc(x.sectionName) : ''}</div></div>
            <span class="undo" data-undo="${x.id}">元に戻す</span></div>`;
    });
    return h;
}

/* --- メモ --- */
function renderMemo() {
    let h = `<div class="crumb">メモ /</div><h1>メモ</h1>
        <div class="bar"><button class="btn" data-newnote="1">＋ 新しいメモ</button></div>`;
    if (!state.notes.length) return h + '<div class="empty">メモはありません。</div>';
    const sorted = state.notes.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    h += sorted.map(n => {
        if (openNote === n.id) {
            return `<div class="note-card open">
                <input class="title-input" data-notetitle="${n.id}" value="${esc(n.title)}">
                <div class="note-tools">${MARKS.map(m => `<button class="swatch ${m.css}" data-mark="1" data-d="${m.d}" title="マーカー（${m.label}）"></button>`).join('')}</div>
                <div class="editor">
                    <div class="backdrop">${paintMark(n.body)}
</div>
                    <textarea data-notebody="${n.id}">${esc(n.body)}</textarea>
                </div>
                ${(() => { const b = tagBarHTML(); return b ? `<div class="tagline">${b}</div>` : ''; })()}
                <div class="stamp">更新 ${localDay(n.updatedAt)}
                    <span class="kill" data-killnote="${n.id}">このメモを削除</span></div></div>`;
        }
        return `<div class="note-card" data-note="${n.id}">
            <div class="nt">${esc(n.title)}</div>
            <div class="np">${renderMark(String(n.body).replace(/\n/g, ' '))}</div></div>`;
    }).join('');
    return h;
}

/* --- 設定 --- */
function renderSettings() {
    const cfgText = JSON.stringify(config.firebaseConfig || DEFAULT_FIREBASE_CONFIG, null, 2);
    const st = config.enabled
        ? (syncState === 'on' ? ['on', 'つながっています']
            : syncState === 'connecting' ? ['', '接続中…']
                : syncState === 'error' ? ['err', 'エラー'] : ['', '停止中'])
        : ['', 'この端末の中だけ'];

    return `<div class="crumb">設定 /</div><h1>設定</h1>

    <div class="group-label">書き出しと読み込み</div>
    <div class="bar">
        <button class="btn" data-export="1">JSONで書き出し</button>
        <button class="btn" data-import="1">JSONを読み込む</button>
    </div>
    <div class="warn">読み込むと、いまのデータは<b>すべて置き換わります</b>。先に書き出しておいてください。</div>

    <div class="group-label" style="margin-top:40px">端末をまたいで使う</div>
    <p style="color:var(--muted);font-size:13px;margin:4px 0 0">
        切のままなら、記録はこの端末の中だけに保存され、外へは何も送りません。
        入にすると Firestore が正本になり、Mac と iPhone で同じリストを見られます。</p>

    <div class="switch-row">
        <label class="toggle">
            <input type="checkbox" id="syncToggle" ${config.enabled ? 'checked' : ''}>
            <span class="track"></span>
        </label>
        <span class="lbl">同期</span>
        <span class="st ${st[0]}">${st[1]}${syncError ? '：' + esc(syncError) : ''}</span>
    </div>

    <div class="field">
        <label>同期キー</label>
        <div class="help">認証の代わりのパスワードです。1台目は「キーを作る」、2台目からは
            <b>1台目と同じキー</b>を入れて「接続」。
            <b>このキーを知っている人は、あなたのタスクとメモを読み書きできます。</b>
            失うと、保存したものを取り出せなくなります。</div>
        <input type="text" id="fbKey" value="${esc(config.key)}" placeholder="例：todotobe-9f3c1a7e5b2d4088">
    </div>
    <div class="bar">
        <button class="btn" data-genkey="1">キーを作る</button>
        <button class="btn primary" data-savesync="1">接続</button>
    </div>

    <details class="adv">
        <summary>Firebase の設定（ふだん触りません）</summary>
        <div class="field">
            <textarea id="fbConfig" rows="7" placeholder='{"apiKey":"…","projectId":"…","appId":"…"}'>${esc(cfgText)}</textarea>
        </div>
    </details>`;
}

/* 打っている最中に描き直すと、入力欄そのものが作り直されてカーソルが飛ぶ。
   同期の反映は打鍵中でも返ってくるので、必ずここで止める */
function isTyping() {
    const a = document.activeElement;
    if (!a || (a.tagName !== 'TEXTAREA' && a.tagName !== 'INPUT')) return false;
    return a.type !== 'checkbox' && a.type !== 'file';
}
let renderPending = false;
let sidebarTimer = null;

/* 打鍵中でも、入力欄に触らない部分は更新してよい。
   ここを止めると、メモに #タグ を書いても左にも下にも出てこない */
function scheduleSidebar() {
    clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(() => {
        const a = document.activeElement;
        if (a && document.getElementById('sidebar').contains(a)) return;   // 枠の名前を打っている最中
        renderSidebar();
        refreshTagline();
    }, 250);
}

/* 挿入バーは1本だけ。サイドバーと同じ並び（枠→五十音）で、
   いま書いている欄（MEMO・メモ本文・タスク名・説明）へ挿す */
function tagBarHTML() {
    const tags = state.tagSlots.filter(Boolean)
        .concat(allTags().filter(g => slotIndexOf(g) < 0).sort((a, b) => a.localeCompare(b, 'ja')));
    if (!tags.length) return '';
    return tags.map(g =>
        `<span class="tag-chip" data-inserttag="${esc(g)}" title="押すと、いま書いている欄に入ります">
            <span class="chip-dot" style="background:${tagColor(g)}"></span>${esc(g)}</span>`).join('');
}

/* チップを押してもフォーカスを奪わないようにしてあるので、
   その瞬間の activeElement が「いま書いている欄」。
   どこにも入っていないときのために、開いている欄をたどる道も残す */
function fieldFor() {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.type !== 'checkbox') return a;
    return document.querySelector('.add-row input, [data-edittask], [data-editnote], [data-editsection]')
        || document.querySelector('[data-notebody]')
        || document.querySelector('[data-scratch]');
}

/* 入力欄には触らずにバーだけ差し替える */
function refreshTagline() {
    const pane = document.querySelector('.pane-memo');
    if (!pane || view.kind !== 'project') return;
    const html = tagBarHTML();
    let el = pane.querySelector('.tagline');
    if (!html) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement('div');
        el.className = 'tagline';
        pane.appendChild(el);
    }
    el.innerHTML = html;
}

/* Guevara と同じ入れ方。前後が空白でなければスペースを補い、
   カーソルはタグの直後。input を出して、ふつうの入力と同じ扱いにする */
function insertTag(ta, tag) {
    const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const e = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
    const before = ta.value.slice(0, s), after = ta.value.slice(e);
    const lead = before.length && !/\s$/.test(before) ? ' ' : '';
    const trail = after.length && !/^\s/.test(after) ? ' ' : '';
    const ins = lead + tag + trail;
    ta.value = before + ins + after;
    ta.focus();
    const pos = before.length + ins.length;
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/* blur は伝わらないことがある。focusout は必ず上がってくる */
document.addEventListener('focusout', () => {
    setTimeout(() => { if (renderPending && !isTyping()) render(); }, 0);
});

/* スマホのメニューボタン。押すと何が起きるかではなく、いまどこにいるかを出す */
function renderBurger() {
    const el = document.getElementById('burger');
    if (!el) return;
    let label = 'メニュー';
    if (view.kind === 'project') { const p = currentProject(); label = p ? p.name : 'TODOTOBE'; }
    else if (view.kind === 'memo') label = 'メモ';
    else if (view.kind === 'archive') label = 'アーカイブ';
    else if (view.kind === 'search') label = '検索';
    else if (view.kind === 'settings') label = '設定';
    else if (view.kind === 'tag') label = view.id;
    el.innerHTML = `<span class="bars"><i></i><i></i><i></i></span>
        <span class="lbl">${esc(label)}</span><span class="caret">▼</span>`;
}

function render(force) {
    if (!force && isTyping()) { renderPending = true; scheduleSidebar(); return; }
    renderPending = false;
    renderBurger();
    allTags().forEach(tagColor);
    renderSidebar();
    const el = document.getElementById('view');

    if (view.kind === 'project') {
        const p = currentProject();
        if (!p) {
            el.innerHTML = `<div class="scrollwrap"><div class="wrap">
                <h1>TODOTOBE</h1>
                <div class="empty">左の「＋ プロジェクト」から最初のプロジェクトを作ってください。</div>
                </div></div>`;
            return;
        }
        view.id = p.id;
        el.innerHTML = renderProject(p);
        return;
    }

    let h = '';
    if (view.kind === 'tag') h = renderTag(view.id);
    else if (view.kind === 'archive') h = renderArchive();
    else if (view.kind === 'memo') h = renderMemo();
    else if (view.kind === 'search') h = renderSearch();
    else if (view.kind === 'settings') h = renderSettings();
    el.innerHTML = `<div class="scrollwrap"><div class="wrap">${h}</div></div>`;

    if (view.kind === 'search') {
        const box = document.getElementById('searchBox');
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
}

/* ============================================================
 * 操作
 * ============================================================ */
document.addEventListener('click', e => {
    if (e.target.closest('#menu')) return;
    closeMenu();
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    /* 打鍵中に見送った描き直しを、ここでも取り戻す（focusout を取りこぼしたとき用） */
    if (renderPending && !isTyping()) render();
    const el = t => e.target.closest(t);
    let n;

    /* ⋯ メニューは行の内側にある。行のクリック（移動・折りたたみ）より先に見る */
    if ((n = el('[data-pmenu]'))) {
        e.stopPropagation();
        const p = projectOf(n.dataset.pmenu);
        const r = n.getBoundingClientRect();
        return openMenu(r.left - 120, r.bottom + 4, [
            { label: '名前を変更', run: () => { go({ kind: 'project', id: p.id }); setTimeout(() => startRenameProject(p), 0); } },
            { label: 'プロジェクトを削除', danger: true, run: () => killProject(p) },
        ]);
    }
    if ((n = el('[data-slotmenu]'))) {
        e.stopPropagation();
        const i = Number(n.dataset.slotmenu);
        const r = n.getBoundingClientRect();
        return openMenu(r.left - 120, r.bottom + 4, [
            { label: 'タグ名を変える', run: () => editSlot(i) },
            { label: '枠を空ける', run: () => setSlot(i, '') },
        ]);
    }
    if ((n = el('[data-setslot]'))) return editSlot(Number(n.dataset.setslot));
    if ((n = el('[data-smenu]'))) {
        e.stopPropagation();
        const s = state.sections.find(x => x.id === n.dataset.smenu);
        const r = n.getBoundingClientRect();
        return openMenu(r.left - 120, r.bottom + 4, [
            { label: '名前を変更', run: () => renameSection(s) },
            { label: 'セクションを削除', danger: true, run: () => killSection(s) },
        ]);
    }

    /* --- 追加 --- */
    if ((n = el('[data-addproject]'))) {
        n.innerHTML = '<span class="ico">＋</span><input placeholder="プロジェクト名">';
        return inlineInput(n, name => {
            const p = put('projects', { id: uid(), name, scratch: '', order: nextOrder(state.projects) });
            go({ kind: 'project', id: p.id });
        });
    }
    if ((n = el('[data-addsection]'))) {
        const pid = n.dataset.addsection;
        n.innerHTML = '<span class="plus">＋</span><input placeholder="セクション名">';
        return inlineInput(n, name => {
            put('sections', { id: uid(), projectId: pid, name, order: nextOrder(sectionsOf(pid)) });
            render();
        });
    }
    if ((n = el('[data-add]'))) {
        const [pid, sid] = n.dataset.add.split('|');
        n.innerHTML = '<span class="plus">＋</span><input placeholder="タスク名（#タグ が使えます）">';
        return inlineInput(n, body => {
            const p = projectOf(pid);
            const s = sid ? state.sections.find(x => x.id === sid) : null;
            put('tasks', {
                id: uid(), projectId: pid, projectName: p ? p.name : '',
                sectionId: sid || null, sectionName: s ? s.name : null,
                body, note: '', order: nextOrder(state.tasks.filter(t => t.sectionId === (sid || null))),
                completedAt: null
            });
            render();
        });
    }

    /* --- タスク --- */
    if ((n = el('[data-done]')) && n.dataset.done) {
        const x = state.tasks.find(y => y.id === n.dataset.done);
        if (x) { x.completedAt = now(); put('tasks', x); render(); }
        return;
    }
    if ((n = el('[data-undo]'))) {
        const x = state.tasks.find(y => y.id === n.dataset.undo);
        if (x) { x.completedAt = null; put('tasks', x); render(); }
        return;
    }
    if ((n = el('[data-opentask]'))) { editing = { kind: 'task-body', id: n.dataset.opentask }; return render(); }
    if ((n = el('[data-opennote]'))) { editing = { kind: 'task-note', id: n.dataset.opennote }; return render(); }
    if ((n = el('[data-killtask]'))) {
        const x = state.tasks.find(y => y.id === n.dataset.killtask);
        if (x) softDelete(`「${x.body}」を削除しました`, [{ name: 'tasks', obj: x }]);
        return;
    }

    /* --- タグ・移動 --- */
    if ((n = el('.tag[data-tag]'))) return go({ kind: 'tag', id: n.dataset.tag });
    if ((n = el('[data-go]'))) {
        const [kind, id] = n.dataset.go.split(/:(.*)/);
        return go({ kind, id });
    }

    /* --- セクション --- */
    if ((n = el('[data-fold]'))) {
        const id = n.dataset.fold;
        collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
        return render();
    }
    if ((n = el('[data-renameproject]'))) return startRenameProject(projectOf(n.dataset.renameproject));

    /* --- マーカー --- */
    if ((n = el('[data-inserttag]'))) {
        const ta = fieldFor();
        if (ta) insertTag(ta, n.dataset.inserttag);
        return;
    }
    if ((n = el('[data-mark]'))) {
        const ta = fieldFor();          // チップと同じく、いま書いている欄に効かせる
        if (ta) toggleMark(ta, n.dataset.d);
        return;
    }

    /* --- MEMOペイン --- */
    if (el('[data-foldmemo]')) { memoFolded = !memoFolded; return render(); }
    if ((n = el('[data-cut]'))) {
        const p = projectOf(n.dataset.cut);
        const text = String(p.scratch || '').trim();
        if (!text) return toast('MEMOが空です');
        put('notes', { id: uid(), title: text.split('\n')[0].slice(0, 40), body: text });
        p.scratch = '';
        put('projects', p);
        toast('メモに切りだしました');
        return render();
    }

    /* --- メモ --- */
    if ((n = el('[data-note]'))) { openNote = n.dataset.note; view = { kind: 'memo' }; return render(); }
    if (el('[data-newnote]')) {
        const nn = put('notes', { id: uid(), title: '新しいメモ', body: '' });
        openNote = nn.id;
        return render();
    }
    if ((n = el('[data-killnote]'))) {
        const nt = state.notes.find(x => x.id === n.dataset.killnote);
        if (nt) { openNote = null; softDelete(`「${nt.title}」を削除しました`, [{ name: 'notes', obj: nt }]); }
        return;
    }

    /* --- アーカイブ --- */
    if ((n = el('[data-purge]'))) {
        const mode = n.dataset.purge;
        const target = mode === 'all' ? archived()
            : archived().filter(x => (Date.now() - Date.parse(x.completedAt)) > 30 * 864e5);
        if (!target.length) return toast('削除対象はありません');
        return softDelete(`${target.length}件を削除しました`, target.map(x => ({ name: 'tasks', obj: x })));
    }

    /* --- 設定 --- */
    if (el('[data-export]')) return exportJSON();
    if (el('[data-import]')) return importJSON();
    if (el('[data-genkey]')) {
        const k = 'todotobe-' + [...crypto.getRandomValues(new Uint8Array(10))].map(b => b.toString(16).padStart(2, '0')).join('');
        document.getElementById('fbKey').value = k;
        return;
    }
    if (el('[data-savesync]')) return saveSyncSettings();

    if (el('#burger') || el('#scrim')) return document.body.classList.toggle('nav-open');
});

/* 入力中は本体を描き直さない（カーソルが飛ぶ）。左だけ更新する */
document.addEventListener('input', e => {
    const d = e.target.dataset;
    if (d.scratch) {
        const p = projectOf(d.scratch);
        p.scratch = e.target.value;
        syncBackdrop(e.target);
        scheduleSave('projects', p);
        scheduleSidebar();
    } else if (d.notebody) {
        const nt = state.notes.find(x => x.id === d.notebody);
        nt.body = e.target.value;
        syncBackdrop(e.target);
        scheduleSave('notes', nt);
        scheduleSidebar();
    } else if (d.notetitle) {
        const nt = state.notes.find(x => x.id === d.notetitle);
        nt.title = e.target.value;
        scheduleSave('notes', nt);
    } else if (e.target.id === 'searchBox') {
        searchQ = e.target.value;
        const box = e.target;
        const pos = box.selectionStart;
        render(true);
        const nb = document.getElementById('searchBox');
        if (nb) { nb.focus(); nb.setSelectionRange(pos, pos); }
    }
});

document.addEventListener('change', e => {
    if (e.target.id === 'syncToggle') toggleSync(e.target.checked);
});

/* 下敷きを入力欄と一緒にスクロールさせる */
document.addEventListener('scroll', e => {
    const d = e.target.dataset || {};
    if (d.scratch || d.notebody) {
        const bd = e.target.parentElement.querySelector('.backdrop');
        if (bd) bd.scrollTop = e.target.scrollTop;
    }
}, true);

/* ボタンを押しても入力欄のフォーカスと選択を失わせない */
document.addEventListener('mousedown', e => {
    if (e.target.closest('[data-mark]') || e.target.closest('[data-inserttag]')) e.preventDefault();
});

/* 打っている間は書き込みを間引く */
const saveTimers = {};
function scheduleSave(name, obj) {
    saveLocal();
    clearTimeout(saveTimers[obj.id]);
    saveTimers[obj.id] = setTimeout(() => put(name, obj), 700);
}

/* 編集の確定 */
document.addEventListener('keydown', e => {
    const d = e.target.dataset || {};

    /* ⌘B / Ctrl+B でマーカー */
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && (d.scratch || d.notebody)) {
        e.preventDefault();
        return toggleMark(e.target, MARKS[0].d);
    }

    if ((e.key === 'Enter' || e.key === 'Escape') && isImeEnter(e)) return;   // 変換中は横取りしない
    if (d.editsection && e.key === 'Enter') {
        e.preventDefault();
        commitSectionName(d.editsection, e.target.value);
    } else if (d.editsection && e.key === 'Escape') {
        editing = null; render();
    } else if (d.edittask && e.key === 'Enter') {
        e.preventDefault();
        const x = state.tasks.find(y => y.id === d.edittask);
        const v = e.target.value.trim();
        if (v) { x.body = v; put('tasks', x); }
        editing = null; render();
    } else if ((d.edittask || d.editnote) && e.key === 'Escape') {
        editing = null; render();
    } else if (e.key === 'Escape') {
        closeMenu();
    }
});
document.addEventListener('blur', e => {
    const d = e.target.dataset || {};
    if (d.editsection) {
        commitSectionName(d.editsection, e.target.value);
    } else if (d.edittask) {
        const x = state.tasks.find(y => y.id === d.edittask);
        const v = e.target.value.trim();
        if (x && v && v !== x.body) { x.body = v; put('tasks', x); }
        editing = null; render();
    } else if (d.editnote) {
        const x = state.tasks.find(y => y.id === d.editnote);
        if (x && e.target.value !== x.note) { x.note = e.target.value; put('tasks', x); }
        editing = null; render();
    }
}, true);

/* 枠の行をその場で入力欄に変える */
function editSlot(i) {
    const row = document.querySelector(`[data-setslot="${i}"], [data-slotmenu="${i}"]`);
    const item = row && row.closest('.side-item');
    if (!item) return;
    item.innerHTML = `<span class="tag-dot" style="background:${PALETTE[i]}"></span>
        <input value="${esc(state.tagSlots[i])}" placeholder="#タグ名">`;
    inlineInput(item, v => setSlot(i, v));
}

/* --- 名前の変更・削除 --- */
function startRenameProject(p) {
    if (!p) return;
    const h1 = document.querySelector('h1 .rename');
    if (!h1) return;
    h1.outerHTML = `<input class="title-input" id="pname" value="${esc(p.name)}" style="font:inherit;border:0;outline:0;width:100%">`;
    const row = document.querySelector('h1');
    inlineInput(row, name => {
        p.name = name;
        put('projects', p);
        state.tasks.filter(t => t.projectId === p.id).forEach(t => { t.projectName = name; put('tasks', t); });
        render();
    });
}
/* その場編集にする。他の名前（プロジェクト・タグ枠・タスク）と揃える */
function renameSection(s) {
    editing = { kind: 'section', id: s.id };
    render();
    const inp = document.querySelector(`[data-editsection="${s.id}"]`);
    if (inp) { inp.focus(); inp.select(); }
}
function commitSectionName(id, raw) {
    const s = state.sections.find(x => x.id === id);
    const name = String(raw || '').trim();
    if (s && name && name !== s.name) {
        s.name = name;
        put('sections', s);
        state.tasks.filter(t => t.sectionId === s.id).forEach(t => { t.sectionName = name; put('tasks', t); });
    }
    editing = null;
    render();
}
function killSection(s) {
    const inside = live().filter(t => t.sectionId === s.id);
    softDelete(`セクション「${s.name}」を削除しました${inside.length ? `（タスク${inside.length}件）` : ''}`,
        inside.map(t => ({ name: 'tasks', obj: t })).concat([{ name: 'sections', obj: s }]));
}
function killProject(p) {
    const inside = live().filter(t => t.projectId === p.id);
    const secs = sectionsOf(p.id);
    if (view.kind === 'project' && view.id === p.id) view = { kind: 'project', id: null };
    softDelete(`プロジェクト「${p.name}」を削除しました${inside.length ? `（タスク${inside.length}件）` : ''}`,
        inside.map(t => ({ name: 'tasks', obj: t }))
            .concat(secs.map(s => ({ name: 'sections', obj: s })))
            .concat([{ name: 'projects', obj: p }]));
}

/* --- 境目のドラッグ --- */
document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#divider')) return;
    e.preventDefault();
    const box = document.getElementById('view').getBoundingClientRect();
    const move = ev => {
        memoH = Math.min(75, Math.max(8, ((ev.clientY - box.top) / box.height) * 100));
        const pane = document.querySelector('.pane-memo');
        if (pane) pane.style.height = memoH + '%';
    };
    const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        try { localStorage.setItem('todotobe_memoh', String(memoH)); } catch (err) {}
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
});

/* --- 書き出し・読み込み --- */
function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'todotobe-' + localDay() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('書き出しました');
}
function importJSON() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = () => {
        const f = inp.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
            try {
                const p = JSON.parse(r.result);
                if (!COLLECTIONS.every(c => Array.isArray(p[c]))) throw new Error('形が違います');
                if (!confirm('いまのデータをすべて置き換えます。よろしいですか？')) return;
                COLLECTIONS.forEach(c => state[c] = p[c]);
                state.tagColors = p.tagColors || {};
                state.tagSlots = normalizeSlots(p.tagSlots);
                saveLocal();
                if (fb) pushAll();
                render();
                toast('読み込みました');
            } catch (err) { alert('読み込めませんでした：' + err.message); }
        };
        r.readAsText(f);
    };
    inp.click();
}

/* --- 同期設定 --- */
/* スイッチはその場で効く。キーが無いまま入にはできない */
async function toggleSync(on) {
    if (!on) {
        config.enabled = false;
        saveConfig(); stopSync(); render();
        return toast('同期を切りました');
    }
    if (!config.key || config.key.length < 16) {
        render();                       // スイッチを切に戻す
        return toast('同期キーを入れて「接続」を押してください');
    }
    config.enabled = true;
    saveConfig();
    await startSync(false);
    toast(syncState === 'on' ? 'つながりました' : '接続できませんでした');
}

/* 「接続」ボタン。キーと構成を保存して入にする */
async function saveSyncSettings() {
    const key = document.getElementById('fbKey').value.trim();
    const txt = document.getElementById('fbConfig').value.trim();

    let cfg = DEFAULT_FIREBASE_CONFIG;
    if (txt) {
        try { cfg = JSON.parse(txt); }
        catch (e) { return alert('Firebase の設定がJSONとして読めません。\n' + e.message); }
    }
    if (!key) return alert('同期キーを入れてください。1台目なら「キーを作る」を押してください。');
    if (key.length < 16) return alert('同期キーが短すぎます。16文字以上にしてください。');

    const first = !config.enabled || config.key !== key;
    config = { enabled: true, firebaseConfig: cfg, key };
    saveConfig();

    await startSync(first);
    toast(syncState === 'on' ? 'つながりました' : '接続できませんでした');
}

/* ============================================================
 * 起動
 * ============================================================ */
/* 最初の1つを作る。ただし同期が入なら、向こうの中身が届くまで待つ。
   待たずに作ると、新しい端末で開くたびに空のプロジェクトが増える */
let seeded = false;
function ensureFirstProject() {
    if (seeded || state.projects.length) return;
    if (lastUndo) return;                      // 削除の取り消し待ちに割り込まない
    if (config.enabled && config.key && syncState !== 'on') return;
    seeded = true;
    const p = put('projects', { id: uid(), name: 'はじめてのプロジェクト', scratch: '', order: 1 });
    view = { kind: 'project', id: p.id };
    render();
}

function boot() {
    loadLocal();
    try {
        const h = Number(localStorage.getItem('todotobe_memoh'));
        if (h >= 8 && h <= 75) memoH = h;
    } catch (e) {}

    migrateGreenMark();
    view = { kind: 'project', id: state.projects.length ? state.projects[0].id : null };
    render();
    if (config.enabled) startSync(false);
    ensureFirstProject();

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
}
boot();
