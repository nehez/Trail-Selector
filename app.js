import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js';
import {
  getFirestore, collection, doc,
  addDoc, setDoc, deleteDoc,
  onSnapshot, query, orderBy,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

const app = initializeApp(FIREBASE_CONFIG);
const db  = getFirestore(app);

// ── State ────────────────────────────────────────────────────
let currentUser      = null;   // { userId, userName }
let currentRuckId    = null;
let unsubscribeDetail = null;
let unsubscribeList   = null;

// ── Date Helpers ─────────────────────────────────────────────
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function fmt(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toDate(val) {
  // Handles Firestore Timestamp or plain JS Date
  return val?.toDate ? val.toDate() : new Date(val);
}

// ── Status ───────────────────────────────────────────────────
function getRuckStatus(ruckDate) {
  const now = new Date();
  const d   = toDate(ruckDate);
  if (now < addDays(d, -21)) return 'upcoming';
  if (now < addDays(d, -14)) return 'submissions-open';
  if (now < addDays(d, -7))  return 'voting-open';
  return 'closed';
}

const STATUS_LABEL = {
  'upcoming':         'Upcoming',
  'submissions-open': 'Submit Trails',
  'voting-open':      'Voting Open',
  'closed':           'Results',
};

// ── User ─────────────────────────────────────────────────────
function getOrCreateUser() {
  const stored = localStorage.getItem('ruckUser');
  if (stored) {
    currentUser = JSON.parse(stored);
    initApp();
  } else {
    showScreen('name');
  }
}

async function saveUser(name) {
  const ref = await addDoc(collection(db, 'users'), {
    name,
    createdAt: serverTimestamp(),
  });
  currentUser = { userId: ref.id, userName: name };
  localStorage.setItem('ruckUser', JSON.stringify(currentUser));
  initApp();
}

// ── App Init ─────────────────────────────────────────────────
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

  // Coordinate four async listeners before first render
  let ruck = null, submissions = [], votes = [], attendees = [];
  let loaded = { ruck: false, subs: false, votes: false, attendees: false };

  function tryRender() {
    if (Object.values(loaded).every(Boolean)) {
      renderRuckDetail(ruck, submissions, votes, attendees);
    }
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
  // Append noon to avoid UTC-midnight timezone rollover issues
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
    userId:    currentUser.userId,
    userName:  currentUser.userName,
    trailName,
    trailLink: trailLink || '',
    submittedAt: serverTimestamp(),
  });
}

async function castVote(ruckId, submissionId) {
  // Document ID = userId → writing twice just overwrites (one vote per person)
  await setDoc(doc(db, 'rucks', ruckId, 'votes', currentUser.userId), {
    userId: currentUser.userId,
    submissionId,
    votedAt: serverTimestamp(),
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

// ── Tally ────────────────────────────────────────────────────
function tallyVotes(submissions, votes) {
  const counts = {};
  votes.forEach(v => { counts[v.submissionId] = (counts[v.submissionId] || 0) + 1; });
  return submissions
    .map(s => ({ ...s, voteCount: counts[s.id] || 0 }))
    .sort((a, b) => {
      if (b.voteCount !== a.voteCount) return b.voteCount - a.voteCount;
      // Tie-break: earliest submission wins
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
  currentRuckId = null;
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
    const status = getRuckStatus(date);
    return `
      <div class="ruck-card" data-id="${r.id}">
        <div class="ruck-card-main">
          <div class="ruck-name">${esc(r.name)}</div>
          <div class="ruck-date">${fmt(date)}</div>
        </div>
        <span class="badge badge-${status}">${STATUS_LABEL[status]}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.ruck-card').forEach(card =>
    card.addEventListener('click', () => navigateToRuck(card.dataset.id))
  );
}

// ── Render: Ruck Detail ───────────────────────────────────────
function renderRuckDetail(ruck, submissions, votes, attendees) {
  const date        = toDate(ruck.ruckDate);
  const status      = getRuckStatus(date);
  const tally       = tallyVotes(submissions, votes);
  const myVote      = votes.find(v => v.userId === currentUser.userId);
  const mySubs      = submissions.filter(s => s.userId === currentUser.userId);
  const isAttending = attendees.some(a => a.userId === currentUser.userId);

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-header">
      <button id="back-btn" class="back-btn">← Back</button>
      <div class="detail-title">
        <div class="detail-name">${esc(ruck.name)}</div>
        <div class="detail-date">${fmt(date)}</div>
      </div>
      <span class="badge badge-${status}">${STATUS_LABEL[status]}</span>
    </div>
    ${renderPhase(status, date, tally, myVote, mySubs, submissions)}
    <div class="divider"></div>
    ${renderAttendance(attendees, isAttending)}
  `;

  // ── Bind events ───────────────────────────────────────────
  document.getElementById('back-btn').addEventListener('click', navigateBack);

  if (status === 'submissions-open') {
    document.getElementById('submit-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const name = document.getElementById('trail-name').value.trim();
      const link = document.getElementById('trail-link').value.trim();
      if (!name) return;
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      await submitTrail(currentRuckId, name, link);
      e.target.reset();
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
}

// ── Render: Phase Content ─────────────────────────────────────
function renderPhase(status, date, tally, myVote, mySubs, rawSubmissions) {
  if (status === 'upcoming') {
    return `
      <div class="phase-box">
        <h3>Timeline</h3>
        <p>Submissions open on <strong>${fmt(addDays(date, -21))}</strong>.</p>
        <p>Voting opens <strong>${fmt(addDays(date, -14))}</strong>.</p>
        <p>Results on <strong>${fmt(addDays(date, -7))}</strong>.</p>
      </div>`;
  }

  if (status === 'submissions-open') {
    const overLimit = mySubs.length >= 2;
    return `
      <div class="phase-box">
        <h3>Submitted Trails</h3>
        ${renderSubList(rawSubmissions, false)}
        <div class="divider"></div>
        <h3>Submit a Trail</h3>
        ${overLimit ? '<p class="warn">You\'ve already submitted 2 trails.</p>' : ''}
        <form id="submit-form">
          <input type="text"  id="trail-name" placeholder="Trail name" required maxlength="100" ${overLimit ? 'disabled' : ''}>
          <input type="url"   id="trail-link" placeholder="Link to trail (optional)">
          <button type="submit" class="btn-primary" ${overLimit ? 'disabled' : ''}>Submit Trail</button>
        </form>
        <p class="hint">Voting opens ${fmt(addDays(date, -14))}.</p>
      </div>`;
  }

  if (status === 'voting-open') {
    return `
      <div class="phase-box">
        <h3>Vote for a Trail</h3>
        <p class="hint">${myVote ? 'Your vote is highlighted — you can change it.' : 'Pick one trail below.'}</p>
        <div class="vote-list">
          ${tally.map(s => {
            const voted = myVote?.submissionId === s.id;
            return `
              <div class="vote-item ${voted ? 'voted' : ''}">
                <div class="vote-info">
                  <div class="vote-trail">${esc(s.trailName)}</div>
                  <div class="vote-meta">by ${esc(s.userName)}${s.trailLink ? ` &mdash; <a href="${esc(s.trailLink)}" target="_blank" rel="noopener">link</a>` : ''}</div>
                </div>
                <button class="vote-btn ${voted ? 'active' : ''}" data-sub-id="${s.id}">${voted ? 'Voted' : 'Vote'}</button>
              </div>`;
          }).join('')}
        </div>
        <p class="hint">Voting closes ${fmt(addDays(date, -7))}.</p>
      </div>`;
  }

  // closed / results
  const winner = tally[0];
  const isTied = tally.length > 1 && winner && tally[1].voteCount === winner.voteCount;
  return `
    <div class="phase-box">
      <h3>Results</h3>
      ${winner ? `
        <div class="winner-box">
          <div class="winner-label">Winning Trail</div>
          <div class="winner-name">${esc(winner.trailName)}</div>
          <div class="winner-meta">${winner.voteCount} vote${winner.voteCount !== 1 ? 's' : ''} &mdash; submitted by ${esc(winner.userName)}</div>
          ${winner.trailLink ? `<a href="${esc(winner.trailLink)}" target="_blank" rel="noopener" class="trail-link">View Trail</a>` : ''}
          ${isTied ? '<p class="tie-note">* Tie broken by earliest submission time</p>' : ''}
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
  return `<div class="sub-list">${submissions.map((s, i) => `
    <div class="sub-item">
      ${showVotes ? `<div class="sub-rank">${i + 1}</div>` : ''}
      <div class="sub-info">
        <div class="sub-trail">${esc(s.trailName)}${s.trailLink ? ` <a href="${esc(s.trailLink)}" target="_blank" rel="noopener" class="sub-link">link</a>` : ''}</div>
        <div class="sub-meta">by ${esc(s.userName)}</div>
      </div>
      ${showVotes ? `<div class="sub-votes">${s.voteCount} vote${s.voteCount !== 1 ? 's' : ''}</div>` : ''}
    </div>`).join('')}</div>`;
}

// ── Render: Attendance ────────────────────────────────────────
function renderAttendance(attendees, isAttending) {
  const names = attendees.map(a => esc(a.userName));
  return `
    <div class="attendance">
      <div class="attendance-header">
        <h3>Who's Going <span class="count">${attendees.length}</span></h3>
        <button id="attendance-btn" class="attendance-btn ${isAttending ? 'out' : 'in'}">
          ${isAttending ? "I'm Out" : "I'm In"}
        </button>
      </div>
      ${names.length
        ? `<div class="attendee-list">${names.join(', ')}</div>`
        : '<p class="empty">No one yet — be the first!</p>'}
    </div>`;
}

// ── Error Display ─────────────────────────────────────────────
function showError(err) {
  console.error(err);
  const msg = err?.code === 'permission-denied'
    ? 'Firestore permission denied. Make sure the database exists in Firebase Console and is in test mode.'
    : err?.code === 'unavailable' || err?.message?.includes('fetch')
    ? 'Cannot reach Firebase. Check your internet connection.'
    : `Error: ${err?.message || err}`;
  alert(msg);
}

// ── Utility ───────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Name form
  document.getElementById('name-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('user-name-input').value.trim();
    if (!name) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await saveUser(name);
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
    } catch (err) {
      showError(err);
    }
    btn.disabled = false;
  });

  document.getElementById('create-cancel').addEventListener('click', () => showScreen('list'));
  document.getElementById('create-ruck-btn').addEventListener('click', () => {
    // Set min date to tomorrow so rucks are always in the future
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('ruck-date-input').min = tomorrow.toISOString().split('T')[0];
    showScreen('create');
  });

  getOrCreateUser();
});
