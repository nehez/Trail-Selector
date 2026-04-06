import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js';
import {
  getFirestore, collection, doc,
  addDoc, setDoc, deleteDoc, getDocs,
  onSnapshot, query, orderBy,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

const app = initializeApp(FIREBASE_CONFIG);
const db  = getFirestore(app);

const VERSION = 'v2.1';

// ── Test Mode ─────────────────────────────────────────────────
function getEffectiveNow() {
  const stored = localStorage.getItem('testDate');
  return stored ? new Date(stored) : new Date();
}

// ── State ─────────────────────────────────────────────────────
let currentUser       = null;
let currentRuckId     = null;
let unsubscribeDetail = null;
let unsubscribeList   = null;
let lastDetailData    = { ruck: null, submissions: [], votes: [], attendees: [] };

// ── Date Helpers ──────────────────────────────────────────────
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function fmt(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toDate(val) {
  return val?.toDate ? val.toDate() : new Date(val);
}

// ── Phase Helpers ─────────────────────────────────────────────
// Returns the fixed voting-open and closed thresholds for a ruck.
// Standard rucks (21+ days lead time): fixed 14/7-day windows.
// Last-minute rucks: proportional thirds anchored to createdAt.
function getRuckPhases(ruckDate, createdAt) {
  const d       = toDate(ruckDate);
  const created = createdAt ? toDate(createdAt) : addDays(d, -30);
  const spanMs  = d.getTime() - created.getTime();
  const DAY     = 86400000;
  if (spanMs >= 21 * DAY) {
    return {
      votingOpen: addDays(d, -14),
      closedAt:   addDays(d, -7),
    };
  }
  const third = spanMs / 3;
  return {
    votingOpen: new Date(created.getTime() + third),
    closedAt:   new Date(created.getTime() + 2 * third),
  };
}

// Submissions are always open from creation until 'closed'.
// No 'upcoming' phase — submit trails at any time before results.
function getRuckStatus(ruckDate, createdAt) {
  const now    = getEffectiveNow();
  const phases = getRuckPhases(ruckDate, createdAt);
  if (now < phases.votingOpen) return 'submissions-open';
  if (now < phases.closedAt)   return 'voting-open';
  return 'closed';
}

const STATUS_LABEL = {
  'submissions-open': '📋 Submit Trails',
  'voting-open':      '🗳️ Voting Open',
  'closed':           '🏆 Results',
};

// ── Avatar Helpers ────────────────────────────────────────────
function getInitials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function getAvatarColor(userId) {
  let hash = 0;
  for (const c of (userId || '')) hash = (Math.imul(31, hash) + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 48%, 36%)`;
}

function renderAvatar(userId, userName, emoji) {
  const color   = getAvatarColor(userId);
  const content = emoji || getInitials(userName);
  return `<div class="avatar" style="background:${color}">${content}</div>`;
}

// ── Trail Preview ─────────────────────────────────────────────
async function fetchTrailPreview(url) {
  if (!url) return null;
  const key    = 'preview_' + url;
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);
  try {
    const res     = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}`);
    const json    = await res.json();
    const image   = json.data?.image?.url
                 || json.data?.screenshot?.url
                 || json.data?.logo?.url
                 || null;
    const preview = { image, title: json.data?.title || null };
    sessionStorage.setItem(key, JSON.stringify(preview));
    return preview;
  } catch (err) {
    console.warn('Trail preview fetch failed:', err);
    return null;
  }
}

function attachPreview(url, containerId) {
  if (!url) return;
  fetchTrailPreview(url).then(preview => {
    if (!preview?.image) return;
    const el = document.getElementById(containerId);
    if (!el) return;
    const img       = document.createElement('img');
    img.className   = 'trail-preview-img';
    img.alt         = preview.title || 'Trail preview';
    img.onload      = () => img.classList.add('loaded');
    img.src         = preview.image;
    el.prepend(img);
  });
}

// ── Winner Cache (for list screen) ───────────────────────────
async function getWinnerForRuck(ruckId) {
  const cacheKey = 'winner_' + ruckId;
  const cached   = sessionStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);
  try {
    const [subsSnap, votesSnap] = await Promise.all([
      getDocs(query(collection(db, 'rucks', ruckId, 'submissions'), orderBy('submittedAt', 'asc'))),
      getDocs(collection(db, 'rucks', ruckId, 'votes')),
    ]);
    const subs  = subsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const votes = votesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const tally = tallyVotes(subs, votes);
    const w     = tally[0] || null;
    const result = w ? { trailName: w.trailName, trailLink: w.trailLink || null } : null;
    sessionStorage.setItem(cacheKey, JSON.stringify(result));
    return result;
  } catch { return null; }
}

// ── User ──────────────────────────────────────────────────────
function getOrCreateUser() {
  const stored = localStorage.getItem('ruckUser');
  if (stored) {
    currentUser = JSON.parse(stored);
    initApp();
  } else {
    showScreen('name');
  }
}

async function saveUser(name, emoji) {
  const ref = await addDoc(collection(db, 'users'), {
    name,
    createdAt: serverTimestamp(),
  });
  currentUser = { userId: ref.id, userName: name, emoji: emoji || null };
  localStorage.setItem('ruckUser', JSON.stringify(currentUser));
  initApp();
}

// ── App Init ──────────────────────────────────────────────────
function initApp() {
  subscribeToRucks();
  showScreen('list');
}

// ── Firestore: Reads ──────────────────────────────────────────
function subscribeToRucks() {
  if (unsubscribeList) unsubscribeList();
  const q = query(collection(db, 'rucks'), orderBy('ruckDate', 'asc'));
  unsubscribeList = onSnapshot(q, snap => {
    renderRuckList(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

function subscribeToRuckDetail(ruckId) {
  if (unsubscribeDetail) unsubscribeDetail();

  let ruck = null, submissions = [], votes = [], attendees = [];
  let loaded = { ruck: false, subs: false, votes: false, attendees: false };

  function tryRender() {
    if (!Object.values(loaded).every(Boolean)) return;
    lastDetailData = { ruck, submissions, votes, attendees };
    renderRuckDetail(ruck, submissions, votes, attendees);
  }

  const u1 = onSnapshot(doc(db, 'rucks', ruckId), snap => {
    ruck = { id: snap.id, ...snap.data() };
    loaded.ruck = true;
    tryRender();
  });

  const u2 = onSnapshot(
    query(collection(db, 'rucks', ruckId, 'submissions'), orderBy('submittedAt', 'asc')),
    snap => {
      submissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      loaded.subs = true;
      tryRender();
    }
  );

  const u3 = onSnapshot(collection(db, 'rucks', ruckId, 'votes'), snap => {
    votes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded.votes = true;
    tryRender();
  });

  const u4 = onSnapshot(collection(db, 'rucks', ruckId, 'attendees'), snap => {
    attendees = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded.attendees = true;
    tryRender();
  });

  unsubscribeDetail = () => { u1(); u2(); u3(); u4(); };
}

// ── Firestore: Writes ─────────────────────────────────────────
async function createRuck(name, dateStr) {
  const ruckDate = new Date(dateStr + 'T12:00:00');
  await addDoc(collection(db, 'rucks'), {
    name,
    ruckDate,
    createdBy: currentUser.userId,
    createdAt: serverTimestamp(),
  });
}

async function submitTrail(ruckId, trailName, trailLink) {
  await addDoc(collection(db, 'rucks', ruckId, 'submissions'), {
    userId:      currentUser.userId,
    userName:    currentUser.userName,
    trailName,
    trailLink:   trailLink || '',
    submittedAt: serverTimestamp(),
  });
}

async function castVote(ruckId, submissionId) {
  await setDoc(doc(db, 'rucks', ruckId, 'votes', currentUser.userId), {
    userId:       currentUser.userId,
    submissionId,
    votedAt:      serverTimestamp(),
  });
}

async function toggleAttendance(ruckId, isAttending) {
  const ref = doc(db, 'rucks', ruckId, 'attendees', currentUser.userId);
  if (isAttending) {
    await deleteDoc(ref);
  } else {
    await setDoc(ref, {
      userId:   currentUser.userId,
      userName: currentUser.userName,
      rsvpAt:   serverTimestamp(),
    });
  }
}

// Admin: cascade-delete a ruck and all its subcollections
async function deleteRuckCascade(ruckId) {
  const [subsSnap, votesSnap, attendeesSnap] = await Promise.all([
    getDocs(collection(db, 'rucks', ruckId, 'submissions')),
    getDocs(collection(db, 'rucks', ruckId, 'votes')),
    getDocs(collection(db, 'rucks', ruckId, 'attendees')),
  ]);
  await Promise.all([
    ...subsSnap.docs.map(d => deleteDoc(d.ref)),
    ...votesSnap.docs.map(d => deleteDoc(d.ref)),
    ...attendeesSnap.docs.map(d => deleteDoc(d.ref)),
  ]);
  await deleteDoc(doc(db, 'rucks', ruckId));
  // Clear winner cache
  sessionStorage.removeItem('winner_' + ruckId);
}

// ── Tally ─────────────────────────────────────────────────────
function tallyVotes(submissions, votes) {
  const counts = {};
  votes.forEach(v => { counts[v.submissionId] = (counts[v.submissionId] || 0) + 1; });
  return submissions
    .map(s => ({ ...s, voteCount: counts[s.id] || 0 }))
    .sort((a, b) => {
      if (b.voteCount !== a.voteCount) return b.voteCount - a.voteCount;
      return (a.submittedAt?.toMillis?.() ?? 0) - (b.submittedAt?.toMillis?.() ?? 0);
    });
}

// ── Screen Navigation ─────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('screen-' + name).classList.remove('hidden');
}

function navigateToRuck(ruckId) {
  currentRuckId = ruckId;
  showScreen('detail');
  subscribeToRuckDetail(ruckId);
}

function navigateBack() {
  if (unsubscribeDetail) { unsubscribeDetail(); unsubscribeDetail = null; }
  lastDetailData = { ruck: null, submissions: [], votes: [], attendees: [] };
  currentRuckId  = null;
  showScreen('list');
}

// ── Render: Ruck List ─────────────────────────────────────────
function renderRuckList(rucks) {
  const list = document.getElementById('ruck-list');
  if (!rucks.length) {
    list.innerHTML = '<p class="empty">No rucks yet — create one!</p>';
    return;
  }
  list.innerHTML = rucks.map(r => {
    const date   = toDate(r.ruckDate);
    const status = getRuckStatus(r.ruckDate, r.createdAt);
    return `
      <div class="ruck-card status-${status}" data-id="${r.id}">
        <div class="ruck-card-strip"></div>
        <div class="ruck-card-main">
          <div class="ruck-name">${esc(r.name)}</div>
          <div class="ruck-date">${fmt(date)}</div>
          ${status === 'closed' ? `<div class="list-winner" id="lw-${r.id}"></div>` : ''}
        </div>
        <span class="badge badge-${status}">${STATUS_LABEL[status]}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.ruck-card').forEach(card =>
    card.addEventListener('click', () => navigateToRuck(card.dataset.id))
  );

  // Lazy-load winning trail for closed rucks
  rucks.filter(r => getRuckStatus(r.ruckDate, r.createdAt) === 'closed').forEach(r => {
    getWinnerForRuck(r.id).then(winner => {
      const el = document.getElementById('lw-' + r.id);
      if (!el || !winner) return;
      el.innerHTML = `🏆 ${esc(winner.trailName)}${winner.trailLink
        ? ` <a href="${esc(winner.trailLink)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a>`
        : ''}`;
    });
  });
}

// ── Render: Ruck Detail ───────────────────────────────────────
function renderRuckDetail(ruck, submissions, votes, attendees) {
  const date        = toDate(ruck.ruckDate);
  const phases      = getRuckPhases(ruck.ruckDate, ruck.createdAt);
  const status      = getRuckStatus(ruck.ruckDate, ruck.createdAt);
  const tally       = tallyVotes(submissions, votes);
  const myVote      = votes.find(v => v.userId === currentUser.userId);
  const mySubs      = submissions.filter(s => s.userId === currentUser.userId);
  const isAttending = attendees.some(a => a.userId === currentUser.userId);
  const testMode    = !!localStorage.getItem('testDate');

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-header">
      <button id="back-btn" class="back-btn">← Back</button>
      <div class="detail-title">
        <div class="detail-name">${esc(ruck.name)}</div>
        <div class="detail-date">${fmt(date)}</div>
      </div>
      <div class="detail-badges">
        <span class="badge badge-${status}">${STATUS_LABEL[status]}</span>
        ${testMode ? '<span class="badge badge-test">TEST</span>' : ''}
      </div>
    </div>
    ${renderPhase(status, date, tally, myVote, mySubs, submissions, phases)}
    <div class="divider"></div>
    ${renderAttendance(attendees, isAttending)}
  `;

  document.getElementById('back-btn').addEventListener('click', navigateBack);

  // Submit form listener — active in both submissions-open and voting-open phases
  if (status === 'submissions-open' || status === 'voting-open') {
    document.getElementById('submit-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const name = document.getElementById('trail-name').value.trim();
      const link = document.getElementById('trail-link').value.trim();
      if (!name) return;
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await submitTrail(currentRuckId, name, link);
        e.target.reset();
      } catch (err) { showError(err); }
      btn.disabled = false;
    });
  }

  if (status === 'voting-open') {
    document.querySelectorAll('.vote-btn').forEach(btn =>
      btn.addEventListener('click', () => castVote(currentRuckId, btn.dataset.subId))
    );
  }

  document.getElementById('attendance-btn')?.addEventListener('click', () =>
    toggleAttendance(currentRuckId, isAttending)
  );

  // Lazy-load trail previews
  document.querySelectorAll('[data-preview-url]').forEach(el => {
    attachPreview(el.dataset.previewUrl, el.dataset.previewId);
  });
}

// ── Render: Phase Content ─────────────────────────────────────
function renderPhase(status, date, tally, myVote, mySubs, rawSubmissions, phases) {
  const overLimit    = mySubs.length >= 2;
  const submitForm   = `
    <h3>Submit a Trail</h3>
    ${overLimit ? '<p class="warn">You\'ve submitted your 2 trails already.</p>' : ''}
    <form id="submit-form">
      <input type="text" id="trail-name" placeholder="Trail name" required maxlength="100" ${overLimit ? 'disabled' : ''}>
      <input type="url"  id="trail-link" placeholder="AllTrails link (optional)">
      <button type="submit" class="btn-primary" ${overLimit ? 'disabled' : ''}>Submit Trail</button>
    </form>`;

  if (status === 'submissions-open') {
    return `
      <div class="phase-box">
        ${rawSubmissions.length ? `<h3>Submitted Trails</h3>${renderSubList(rawSubmissions, false)}<div class="divider"></div>` : ''}
        ${submitForm}
        <p class="hint">Voting opens ${fmt(phases.votingOpen)} · Results ${fmt(phases.closedAt)}.</p>
      </div>`;
  }

  if (status === 'voting-open') {
    return `
      <div class="phase-box">
        <h3>Vote for a Trail</h3>
        <p class="hint">${myVote ? 'Your vote is highlighted. You can change it.' : 'Pick one trail below.'}</p>
        <div class="vote-list">
          ${tally.map(s => {
            const voted    = myVote?.submissionId === s.id;
            const prevId   = `prev-${s.id}`;
            const prevAttrs = s.trailLink ? `data-preview-url="${esc(s.trailLink)}" data-preview-id="${prevId}"` : '';
            return `
              <div class="vote-item ${voted ? 'voted' : ''}">
                <div class="vote-card-body" id="${prevId}" ${prevAttrs}>
                  <div class="vote-trail">${esc(s.trailName)}</div>
                  <div class="vote-meta">by ${esc(s.userName)}${s.trailLink ? ` · <a href="${esc(s.trailLink)}" target="_blank" rel="noopener">view trail</a>` : ''}</div>
                </div>
                <button class="vote-btn ${voted ? 'active' : ''}" data-sub-id="${s.id}">
                  ${voted ? '✓ Voted' : 'Vote'}
                </button>
              </div>`;
          }).join('')}
        </div>
        <div class="divider"></div>
        ${submitForm}
        <p class="hint">Voting closes ${fmt(phases.closedAt)}.</p>
      </div>`;
  }

  // closed / results
  const winner = tally[0];
  const isTied = tally.length > 1 && winner && tally[1].voteCount === winner.voteCount;
  const winId  = 'winner-preview';
  const winAttrs = winner?.trailLink ? `data-preview-url="${esc(winner.trailLink)}" data-preview-id="${winId}"` : '';
  return `
    <div class="phase-box">
      <h3>Results</h3>
      ${winner ? `
        <div class="winner-box" id="${winId}" ${winAttrs}>
          <div class="winner-trophy">🏆</div>
          <div class="winner-label">Winning Trail</div>
          <div class="winner-name">${esc(winner.trailName)}</div>
          <div class="winner-meta">${winner.voteCount} vote${winner.voteCount !== 1 ? 's' : ''} · submitted by ${esc(winner.userName)}</div>
          ${winner.trailLink ? `<a href="${esc(winner.trailLink)}" target="_blank" rel="noopener" class="trail-link-btn">View on AllTrails →</a>` : ''}
          ${isTied ? '<p class="tie-note">* Tie broken by earliest submission</p>' : ''}
        </div>
        <div class="divider"></div>
        <h3>All Trails</h3>
        ${renderSubList(tally, true)}
      ` : '<p class="empty">No trails were submitted.</p>'}
    </div>`;
}

// ── Render: Submission List ───────────────────────────────────
function renderSubList(submissions, showVotes) {
  if (!submissions.length) return '<p class="empty">None yet.</p>';
  return `<div class="sub-list">${submissions.map((s, i) => {
    const prevId    = `sub-prev-${s.id || i}`;
    const prevAttrs = s.trailLink ? `data-preview-url="${esc(s.trailLink)}" data-preview-id="${prevId}"` : '';
    return `
      <div class="sub-item">
        ${showVotes ? `<div class="sub-rank">${i + 1}</div>` : ''}
        <div class="sub-body" id="${prevId}" ${prevAttrs}>
          <div class="sub-trail">${esc(s.trailName)}${s.trailLink ? ` <a href="${esc(s.trailLink)}" target="_blank" rel="noopener" class="sub-link">↗</a>` : ''}</div>
          <div class="sub-meta">by ${esc(s.userName)}</div>
        </div>
        ${showVotes ? `<div class="sub-votes">${s.voteCount}v</div>` : ''}
      </div>`;
  }).join('')}</div>`;
}

// ── Render: Attendance ────────────────────────────────────────
function renderAttendance(attendees, isAttending) {
  const avatars = attendees.map(a => {
    const emoji = (a.userId === currentUser?.userId) ? currentUser.emoji : null;
    return `<div class="attendee-avatar" title="${esc(a.userName)}">${renderAvatar(a.userId, a.userName, emoji)}</div>`;
  }).join('');

  return `
    <div class="attendance">
      <div class="attendance-header">
        <h3>Who's Going <span class="count">${attendees.length}</span></h3>
        <button id="attendance-btn" class="attendance-btn ${isAttending ? 'out' : 'in'}">
          ${isAttending ? "I'm Out" : "I'm In"}
        </button>
      </div>
      ${attendees.length
        ? `<div class="attendee-avatars">${avatars}</div>`
        : '<p class="empty">No one yet — be the first!</p>'}
    </div>`;
}

// ── Admin Panel ───────────────────────────────────────────────
async function renderAdminPanel() {
  showScreen('admin');
  const listEl = document.getElementById('admin-user-list');
  listEl.innerHTML = '<p class="hint">Loading...</p>';
  try {
    const [usersSnap, rucksSnap] = await Promise.all([
      getDocs(collection(db, 'users')),
      getDocs(query(collection(db, 'rucks'), orderBy('ruckDate', 'asc'))),
    ]);
    const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const rucks = rucksSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    listEl.innerHTML = `
      <h3>Users (${users.length})</h3>
      <div class="admin-section">
        ${users.map(u => `
          <div class="admin-row" id="arow-user-${u.id}">
            <div class="admin-row-info">
              <div class="admin-row-name">${esc(u.name)}</div>
              <div class="admin-row-sub">${u.id}</div>
            </div>
            <button class="btn-secondary admin-del-btn" data-type="user" data-id="${u.id}" data-label="${esc(u.name)}">Delete</button>
          </div>`).join('') || '<p class="empty">No users.</p>'}
      </div>
      <div class="divider"></div>
      <h3>Rucks (${rucks.length})</h3>
      <div class="admin-section">
        ${rucks.map(r => `
          <div class="admin-row" id="arow-ruck-${r.id}">
            <div class="admin-row-info">
              <div class="admin-row-name">${esc(r.name)}</div>
              <div class="admin-row-sub">${fmt(toDate(r.ruckDate))}</div>
            </div>
            <button class="btn-secondary admin-del-btn" data-type="ruck" data-id="${r.id}" data-label="${esc(r.name)}">Delete</button>
          </div>`).join('') || '<p class="empty">No rucks.</p>'}
      </div>`;

    listEl.querySelectorAll('.admin-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const type  = btn.dataset.type;
        const id    = btn.dataset.id;
        const label = btn.dataset.label;
        const msg   = type === 'ruck'
          ? `Delete ruck "${label}"?\n\nThis permanently removes the ruck, all submitted trails, votes, and RSVPs.`
          : `Delete user "${label}"?\n\nTheir trail submissions and votes are kept.`;
        if (!confirm(msg)) return;
        btn.disabled = true;
        try {
          if (type === 'user') {
            await deleteDoc(doc(db, 'users', id));
          } else {
            await deleteRuckCascade(id);
          }
          document.getElementById(`arow-${type}-${id}`)?.remove();
        } catch (err) {
          showError(err);
          btn.disabled = false;
        }
      });
    });
  } catch (err) { showError(err); }
}

// ── Test Mode Panel ───────────────────────────────────────────
function initTestMode() {
  const btn      = document.getElementById('test-mode-btn');
  const panel    = document.getElementById('test-mode-panel');
  const input    = document.getElementById('test-date-input');
  const setBtn   = document.getElementById('test-date-set');
  const clearBtn = document.getElementById('test-date-clear');
  const hint     = document.getElementById('test-phase-hint');

  const stored = localStorage.getItem('testDate');
  if (stored) input.value = stored.split('T')[0];

  btn.addEventListener('click', () => panel.classList.toggle('hidden'));

  // Live phase preview as user types a test date
  input.addEventListener('input', () => {
    if (!input.value || !lastDetailData.ruck) { hint.textContent = ''; return; }
    const testDate = new Date(input.value + 'T12:00:00');
    const phases   = getRuckPhases(lastDetailData.ruck.ruckDate, lastDetailData.ruck.createdAt);
    let status;
    if (testDate < phases.votingOpen)    status = 'submissions-open';
    else if (testDate < phases.closedAt) status = 'voting-open';
    else                                  status = 'closed';
    hint.textContent = `→ ${STATUS_LABEL[status]} for this ruck`;
  });

  setBtn.addEventListener('click', () => {
    if (!input.value) return;
    localStorage.setItem('testDate', input.value + 'T12:00:00');
    panel.classList.add('hidden');
    hint.textContent = '';
    // Re-render detail directly from cached data (no re-subscription timing issues)
    const onDetail = !document.getElementById('screen-detail').classList.contains('hidden');
    if (onDetail && lastDetailData.ruck) {
      renderRuckDetail(lastDetailData.ruck, lastDetailData.submissions, lastDetailData.votes, lastDetailData.attendees);
    }
    // Always refresh the list too
    subscribeToRucks();
  });

  clearBtn.addEventListener('click', () => {
    localStorage.removeItem('testDate');
    input.value = '';
    hint.textContent = '';
    panel.classList.add('hidden');
    const onDetail = !document.getElementById('screen-detail').classList.contains('hidden');
    if (onDetail && lastDetailData.ruck) {
      renderRuckDetail(lastDetailData.ruck, lastDetailData.submissions, lastDetailData.votes, lastDetailData.attendees);
    }
    subscribeToRucks();
  });
}

// ── Error Display ─────────────────────────────────────────────
function showError(err) {
  console.error(err);
  const msg = err?.code === 'permission-denied'
    ? 'Firestore permission denied. Check your database rules.'
    : err?.code === 'unavailable'
    ? 'Cannot reach Firebase. Check your internet connection.'
    : `Error: ${err?.message || err}`;
  alert(msg);
}

// ── Utility ───────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Version — visible in header and browser tab
  document.querySelectorAll('.version-tag').forEach(el => el.textContent = VERSION);
  document.getElementById('app-version').textContent = VERSION;
  document.title = `Trail Selector ${VERSION}`;

  initTestMode();

  // Admin easter egg: tap version badge 5× quickly
  let adminTaps = 0, adminTimer = null;
  document.getElementById('app-version').style.cursor = 'default';
  document.getElementById('app-version').addEventListener('click', () => {
    adminTaps++;
    clearTimeout(adminTimer);
    if (adminTaps >= 5) {
      adminTaps = 0;
      renderAdminPanel();
    } else {
      adminTimer = setTimeout(() => { adminTaps = 0; }, 2000);
    }
  });

  document.getElementById('admin-back-btn').addEventListener('click', () => showScreen('list'));

  // Emoji picker
  let selectedEmoji = null;
  document.querySelectorAll('.emoji-option').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.emoji-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedEmoji = btn.dataset.emoji;
    });
  });

  // Name form
  document.getElementById('name-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('user-name-input').value.trim();
    if (!name) return;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await saveUser(name, selectedEmoji);
    } catch (err) {
      showError(err);
      btn.disabled = false;
    }
  });

  // Create ruck form
  document.getElementById('create-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('ruck-name-input').value.trim();
    const date = document.getElementById('ruck-date-input').value;
    if (!name || !date) return;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await createRuck(name, date);
      e.target.reset();
      showScreen('list');
    } catch (err) { showError(err); }
    btn.disabled = false;
  });

  document.getElementById('create-cancel').addEventListener('click', () => showScreen('list'));

  document.getElementById('create-ruck-btn').addEventListener('click', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('ruck-date-input').min = tomorrow.toISOString().split('T')[0];
    showScreen('create');
  });

  getOrCreateUser();
});
