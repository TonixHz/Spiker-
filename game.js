import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getDatabase, ref, set, onValue, onDisconnect, remove } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

// ============================================================
//  FIREBASE
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyBHeinJrRrlXa0IqN8_82n0XtkQ2a9w4Rg",
    authDomain: "spiker-45a82.firebaseapp.com",
    databaseURL: "https://spiker-45a82-default-rtdb.firebaseio.com",
    projectId: "spiker-45a82",
    storageBucket: "spiker-45a82.firebasestorage.app",
    messagingSenderId: "408879159265",
    appId: "1:408879159265:web:1b89adc89a2d4c15f1e4a0"
};
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ============================================================
//  CONSTANTS
// ============================================================
const CANVAS_W    = 800;
const CANVAS_H    = 480;
const GROUND_Y    = CANVAS_H - 20;
const NET_X       = CANVAS_W / 2;
const NET_H       = 110;
const NET_TOP_Y   = GROUND_Y - NET_H;
const BALL_R      = 14;
const PLAYER_R    = 22;
const GRAVITY     = 0.38;
const JUMP_VY     = -10.5;
const P_SPEED     = 5.5;
const FRICTION    = 0.80;
const BALL_BOUNCE = 0.72;
const MAX_BVX     = 14;
const MAX_BVY     = 14;

// Spawn positions per slot index within a team (up to 4 per side)
const RED_SPAWNS  = [0.18, 0.28, 0.10, 0.36].map(x => ({ x: CANVAS_W * x, y: GROUND_Y - PLAYER_R }));
const BLUE_SPAWNS = [0.82, 0.72, 0.90, 0.64].map(x => ({ x: CANVAS_W * x, y: GROUND_Y - PLAYER_R }));

// ============================================================
//  DOM
// ============================================================
const loginContainer   = document.getElementById('login-container');
const lobbyContainer   = document.getElementById('lobby-container');
const createRoomModal  = document.getElementById('create-room-modal');
const gameContainer    = document.getElementById('game-container');
const innerLobby       = document.getElementById('inner-lobby');
const usernameInput    = document.getElementById('username-input');
const btnLogin         = document.getElementById('btn-login');
const contextMenu      = document.getElementById('context-menu');
const listRed          = document.getElementById('list-red');
const listSpect        = document.getElementById('list-spect');
const listBlue         = document.getElementById('list-blue');
const canvas           = document.getElementById('gameCanvas');
const ctx              = canvas.getContext('2d');
const scoreDisplay     = document.getElementById('score-display');
const gameTimer        = document.getElementById('game-timer');
const chatLog          = document.getElementById('chat-log');
const chatInput        = document.getElementById('chat-input');
const roomCountDisplay = document.getElementById('room-count-display');

// ============================================================
//  USER
// ============================================================
let myUsername = localStorage.getItem("spiker_username") || "";
let myPeerId   = null;

// ============================================================
//  NETWORK STATE
// ============================================================
const peer       = new Peer();
let isHost       = false;
let hostConn     = null;
let guestConns   = {};   // { peerId: DataConnection }

// remoteInputs[peerId] = { KeyA, KeyD, KeyW, ArrowLeft, ... , KeyX, Space }
let remoteInputs = {};
const localKeys  = {};

// ============================================================
//  ROOM STATE  (host is source of truth)
// ============================================================
let roomState = {
    matchStarted: false,
    roomName: "Room",
    scoreLimit: 3,
    timeLimit: 3,
    players: {}
    // players[peerId] = { name, team, admin, ping }
};

// ============================================================
//  GAME STATE  (host simulates; clients receive ticks)
// ============================================================
// physPlayers[peerId] = { x, y, vx, vy, onGround, team, name }
let physPlayers  = {};
let ball         = freshBall('red');
let scores       = { red: 0, blue: 0 };
let matchActive  = false;
let matchTimeLeft = 180;
let timerInterval = null;
let scoringLocked = false;   // brief lock after each point
let gameLoopRAF   = null;

// ============================================================
//  HELPERS
// ============================================================
function freshBall(side) {
    return { x: side === 'red' ? CANVAS_W * 0.28 : CANVAS_W * 0.72, y: CANVAS_H * 0.22, vx: 0, vy: 0 };
}

function spawnForTeam(team, slotIndex) {
    const spawns = team === 'red' ? RED_SPAWNS : BLUE_SPAWNS;
    const sp = spawns[slotIndex % spawns.length];
    return { x: sp.x, y: sp.y, vx: 0, vy: 0, onGround: true };
}

function escapeHTML(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function dbg(msg) {
    console.log(`[SPIKER] ${msg}`);
}

// ============================================================
//  CHAT
// ============================================================
function addChatMsg(author, text, team, system) {
    const d = document.createElement('div');
    d.className = `chat-msg ${system ? 'msg-system' : 'msg-' + team}`;
    d.innerHTML = system
        ? escapeHTML(text)
        : `<span class="msg-author">${escapeHTML(author)}:</span> ${escapeHTML(text)}`;
    chatLog.appendChild(d);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function sysMsg(txt) { addChatMsg('', txt, 'spect', true); }

function broadcastChat(author, text, team) {
    if (!isHost) return;
    const d = { type: 'chat', author, text, team };
    sendAll(d);
    addChatMsg(author, text, team, false);
}

chatInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const txt = chatInput.value.trim();
    if (!txt) return;
    chatInput.value = '';
    const myTeam = roomState.players[myPeerId]?.team || 'spect';
    if (isHost) {
        broadcastChat(myUsername, txt, myTeam);
    } else {
        hostConn?.send({ type: 'chat_request', text: txt });
    }
});

// ============================================================
//  NETWORK SEND HELPERS
// ============================================================
function sendAll(data) {
    Object.values(guestConns).forEach(c => { try { c.send(data); } catch(e){} });
}

function broadcastState() {
    if (!isHost) return;
    updateLobbyUI();
    sendAll({ type: 'state_update', roomState });
}

// ============================================================
//  LOGIN
// ============================================================
if (myUsername) showPublicLobby();
else loginContainer.classList.remove('hidden');

btnLogin.addEventListener('click', doLogin);
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

function doLogin() {
    const v = usernameInput.value.trim();
    if (!v) return;
    myUsername = v;
    localStorage.setItem("spiker_username", myUsername);
    showPublicLobby();
}

function showPublicLobby() {
    loginContainer.classList.add('hidden');
    createRoomModal.classList.add('hidden');
    lobbyContainer.classList.remove('hidden');
}

document.getElementById('btn-change-nick').addEventListener('click', () => {
    localStorage.removeItem('spiker_username');
    location.reload();
});

// ============================================================
//  PEER INIT
// ============================================================
peer.on('open', id => {
    myPeerId = id;
    document.getElementById('my-id').value = id;
    dbg(`My PeerID: ${id}`);
});
peer.on('error', e => console.error('[PeerJS]', e));

// ============================================================
//  SINGLE peer.on('connection') — ALL guest message handling
// ============================================================
peer.on('connection', conn => {
    if (!isHost) return;

    conn.on('open', () => {
        const guestName = conn.metadata?.name || 'Anon';
        guestConns[conn.peer] = conn;
        roomState.players[conn.peer] = { name: guestName, team: 'spect', admin: false, ping: 0 };
        remoteInputs[conn.peer] = {};

        dbg(`PLAYER CONNECTED: ${guestName} (${conn.peer})`);

        // Send full state immediately so client can render lobby
        conn.send({ type: 'state_update', roomState });

        // If match already running, send a start signal + current tick
        if (matchActive) {
            conn.send({ type: 'match_started', roomState });
            // Note: guest joins as spectator mid-match. physPlayers entry will be created on next resetPhysics().
            dbg(`PLAYER CONNECTED mid-match as spectator: ${guestName}`);
        }

        broadcastState();
        broadcastChat('System', `${guestName} has joined.`, 'spect');

        // Start ping loop for this guest
        const pingInterval = setInterval(() => {
            if (!guestConns[conn.peer]) { clearInterval(pingInterval); return; }
            conn.send({ type: 'ping', t: Date.now() });
        }, 2000);
    });

    // ---- SINGLE unified data handler ----
    conn.on('data', data => {
        switch (data.type) {

            case 'keys':
                remoteInputs[conn.peer] = data.keys;
                break;

            case 'pong':
                if (roomState.players[conn.peer]) {
                    roomState.players[conn.peer].ping = Date.now() - data.t;
                    dbg(`PING UPDATED: ${roomState.players[conn.peer].name} = ${roomState.players[conn.peer].ping}ms`);
                }
                break;

            case 'chat_request': {
                const sender = roomState.players[conn.peer];
                if (sender) broadcastChat(sender.name, data.text, sender.team);
                break;
            }

            case 'change_team_request':
                if (roomState.players[conn.peer]) {
                    const prevTeam = roomState.players[conn.peer].team;
                    roomState.players[conn.peer].team = data.team;
                    dbg(`TEAM CHANGED: ${roomState.players[conn.peer].name} ${prevTeam} → ${data.team}`);
                    broadcastState();
                }
                break;
        }
    });

    conn.on('close', () => {
        const name = roomState.players[conn.peer]?.name || 'Someone';
        delete guestConns[conn.peer];
        delete roomState.players[conn.peer];
        delete remoteInputs[conn.peer];
        delete physPlayers[conn.peer];
        broadcastState();
        broadcastChat('System', `${name} has left.`, 'spect');
        dbg(`PLAYER DISCONNECTED: ${name}`);
    });
});

// ============================================================
//  FIREBASE ROOM LIST
// ============================================================
const roomsRef = ref(db, 'rooms');
let myRoomRef  = null;

onValue(roomsRef, snap => {
    const el    = document.getElementById('room-list');
    el.innerHTML = '';
    const rooms = snap.val();
    if (!rooms) {
        el.innerHTML = '<li class="hax-empty-rooms">No active rooms.</li>';
        roomCountDisplay.textContent = '0 rooms';
        return;
    }
    let count = 0;
    for (const pid in rooms) {
        count++;
        const r  = rooms[pid];
        const li = document.createElement('li');
        li.className = 'hax-room-item';
        li.innerHTML = `
            <span class="room-name">${escapeHTML(r.name)}</span>
            <span class="room-players">${r.playerCount||1}/${r.maxPlayers||12}</span>
            <span class="room-pass">${r.hasPassword?'Yes':'No'}</span>
            <span class="room-dist"><span class="flag-icon">🇺🇾</span> 0km</span>`;
        li.addEventListener('click', () => {
            document.querySelectorAll('.hax-room-item').forEach(x => x.classList.remove('selected'));
            li.classList.add('selected');
        });
        li.addEventListener('dblclick', () => joinRoom(pid));
        el.appendChild(li);
    }
    roomCountDisplay.textContent = `${count} room(s) active`;
});

document.getElementById('btn-refresh').addEventListener('click', () => sysMsg('Refreshed.'));

// ============================================================
//  CREATE ROOM
// ============================================================
document.getElementById('btn-create-room-open').addEventListener('click', () => {
    lobbyContainer.classList.add('hidden');
    createRoomModal.classList.remove('hidden');
});
document.getElementById('btn-cancel-create').addEventListener('click', () => {
    createRoomModal.classList.add('hidden');
    lobbyContainer.classList.remove('hidden');
});

let roomVisible = true;
document.getElementById('btn-toggle-visibility').addEventListener('click', () => {
    roomVisible = !roomVisible;
    document.getElementById('room-visibility-label').textContent = roomVisible ? 'Yes' : 'No';
});

document.getElementById('btn-host').addEventListener('click', () => {
    if (!myPeerId) { alert("Still connecting..."); return; }

    const roomName   = document.getElementById('room-name').value.trim() || `${myUsername}'s room`;
    const hasPw      = document.getElementById('room-password').value.trim().length > 0;
    const maxPlayers = parseInt(document.getElementById('room-max-players').value) || 12;
    const scoreLimit = parseInt(document.getElementById('score-limit').value) || 3;
    const timeLimit  = parseInt(document.getElementById('time-limit').value) || 3;

    if (roomVisible) {
        myRoomRef = ref(db, 'rooms/' + myPeerId);
        set(myRoomRef, { name: roomName, hostId: myPeerId, hostName: myUsername,
                         playerCount: 1, maxPlayers, hasPassword: hasPw, timestamp: Date.now() });
        onDisconnect(myRoomRef).remove();
    }

    isHost = true;
    roomState = { matchStarted: false, roomName, scoreLimit, timeLimit, players: {} };
    roomState.players[myPeerId] = { name: myUsername, team: 'spect', admin: true, ping: 0 };

    document.getElementById('room-title-display').innerText = roomName;
    document.getElementById('btn-start-match').classList.remove('hidden');
    document.getElementById('score-limit').value = scoreLimit;
    document.getElementById('time-limit').value  = timeLimit;

    enterGameScreen();
});

// ============================================================
//  JOIN ROOM
// ============================================================
function joinRoom(hostId) {
    if (!myPeerId) { alert("Still connecting..."); return; }
    isHost   = false;
    hostConn = peer.connect(hostId, { metadata: { name: myUsername } });

    hostConn.on('open', () => {
        dbg(`Connected to host ${hostId}`);
        sysMsg('Connected to host.');
        enterGameScreen();
    });

    // SINGLE unified handler for all messages from host
    hostConn.on('data', data => {
        switch (data.type) {

            case 'state_update':
                roomState = data.roomState;
                updateLobbyUI();
                break;

            case 'match_started':
                roomState = data.roomState;
                matchActive = true;
                innerLobby.classList.add('hidden');
                updateLobbyUI();
                sysMsg('Match started!');
                dbg('MATCH STARTED (received from host)');
                break;

            case 'game_tick':
                // Apply authoritative state — no recalculation
                physPlayers   = data.physPlayers;
                ball          = data.ball;
                scores        = data.scores;
                matchTimeLeft = data.timeLeft;
                updateScoreUI();
                dbg(`GAME TICK RECEIVED — players: ${Object.keys(physPlayers).length}, ball: (${Math.round(data.ball.x)},${Math.round(data.ball.y)})`);
                break;

            case 'chat':
                addChatMsg(data.author, data.text, data.team, false);
                break;

            case 'kicked':
                alert("You have been kicked.");
                location.reload();
                break;

            case 'ping':
                hostConn.send({ type: 'pong', t: data.t });
                break;

            case 'match_ended':
                matchActive = false;
                sysMsg(`Match over! ${data.winner.toUpperCase()} wins (${data.scores.red}–${data.scores.blue})`);
                dbg(`MATCH ENDED — winner: ${data.winner}, scores: ${data.scores.red}-${data.scores.blue}`);
                setTimeout(() => innerLobby.classList.remove('hidden'), 2500);
                break;
        }
    });

    hostConn.on('close', () => { sysMsg('Host closed the room.'); setTimeout(() => location.reload(), 2000); });
    hostConn.on('error', e => sysMsg('Connection error: ' + e.type));
}

// ============================================================
//  ENTER GAME SCREEN
// ============================================================
function enterGameScreen() {
    lobbyContainer.classList.add('hidden');
    createRoomModal.classList.add('hidden');
    gameContainer.classList.remove('hidden');
    innerLobby.classList.remove('hidden');
    updateLobbyUI();

    // Both host and guest need the render loop.
    // Host uses it to simulate + render; guest uses it only to render (state comes from game_tick).
    if (!gameLoopRAF) {
        gameLoopRAF = requestAnimationFrame(gameLoop);
        dbg(`GAME LOOP STARTED (${isHost ? 'host' : 'guest'})`);
    }
}

// ============================================================
//  LOBBY UI
// ============================================================
function updateLobbyUI() {
    listRed.innerHTML = '';
    listSpect.innerHTML = '';
    listBlue.innerHTML = '';

    for (const [id, p] of Object.entries(roomState.players)) {
        const li   = document.createElement('li');
        const isMe = id === myPeerId;
        li.innerHTML = `
            <span class="flag-icon">🇺🇾</span>
            <span style="flex:1">${escapeHTML(p.name)}${isMe ? ' <em style="color:#f1c40f;font-size:.7rem">(you)</em>' : ''}</span>
            <span class="player-ping">${p.ping||0}ms</span>`;
        if (p.admin) li.classList.add('is-admin');

        li.addEventListener('click', e => {
            if (roomState.players[myPeerId]?.admin && id !== myPeerId)
                showContextMenu(e.clientX, e.clientY, id, p.name);
        });

        if (p.team === 'red')        listRed.appendChild(li);
        else if (p.team === 'blue')  listBlue.appendChild(li);
        else                         listSpect.appendChild(li);
    }
}

// ============================================================
//  LOBBY CONTROLS
// ============================================================
document.getElementById('btn-start-match').addEventListener('click', () => {
    if (!isHost) return;
    const red  = Object.values(roomState.players).filter(p => p.team === 'red');
    const blue = Object.values(roomState.players).filter(p => p.team === 'blue');
    if (!red.length || !blue.length) { sysMsg('Need at least 1 player per team!'); return; }

    roomState.matchStarted = true;
    roomState.scoreLimit   = parseInt(document.getElementById('score-limit').value) || 3;
    roomState.timeLimit    = parseInt(document.getElementById('time-limit').value)  || 3;

    // Build physPlayers from roomState
    resetPhysics();
    matchActive    = true;
    matchTimeLeft  = roomState.timeLimit * 60;
    scores         = { red: 0, blue: 0 };
    scoringLocked  = false;
    updateScoreUI();

    // Notify all clients
    sendAll({ type: 'match_started', roomState });
    broadcastState();

    innerLobby.classList.add('hidden');
    startTimer();
    broadcastChat('System', 'Match started!', 'spect');
    dbg('MATCH STARTED (host)');
});

document.getElementById('btn-auto').addEventListener('click', () => {
    if (!isHost) return;
    const ids = Object.keys(roomState.players);
    ids.forEach((id, i) => roomState.players[id].team = i % 2 === 0 ? 'red' : 'blue');
    broadcastState();
});

document.getElementById('btn-rand').addEventListener('click', () => {
    if (!isHost) return;
    const ids = Object.keys(roomState.players).sort(() => Math.random() - 0.5);
    ids.forEach((id, i) => roomState.players[id].team = i % 2 === 0 ? 'red' : 'blue');
    broadcastState();
});

document.getElementById('btn-reset').addEventListener('click', () => {
    if (!isHost) return;
    for (const id in roomState.players) roomState.players[id].team = 'spect';
    broadcastState();
});

document.getElementById('btn-lock').addEventListener('click', () => { if (isHost) sysMsg('Teams locked.'); });

document.getElementById('btn-move-right').addEventListener('click', () => moveMe('red'));
document.getElementById('btn-move-left').addEventListener('click',  () => moveMe('blue'));

// Team header buttons (clicking "Red" or "Blue" label also switches team)
document.querySelectorAll('.hax-team-btn').forEach(btn => {
    btn.addEventListener('click', () => moveMe(btn.dataset.team));
});

function moveMe(team) {
    if (!myPeerId || !roomState.players[myPeerId]) return;
    const newTeam = roomState.players[myPeerId].team === team ? 'spect' : team;
    if (isHost) {
        roomState.players[myPeerId].team = newTeam;
        broadcastState();
    } else {
        hostConn?.send({ type: 'change_team_request', team: newTeam });
    }
}

document.getElementById('btn-leave-room').addEventListener('click', () => { if (myRoomRef) remove(myRoomRef); location.reload(); });

document.getElementById('btn-rec').addEventListener('click', () => { sysMsg('Recording not implemented yet.'); });
document.getElementById('btn-pick-stadium').addEventListener('click', () => { sysMsg('Stadium selection not implemented yet.'); });

document.getElementById('btn-copy-link').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}#${myPeerId}`;
    navigator.clipboard?.writeText(url).then(() => sysMsg('Link copied!')).catch(() => sysMsg(`ID: ${myPeerId}`));
});

// Auto-join from hash
if (location.hash.length > 1 && myUsername) {
    showPublicLobby();
    setTimeout(() => joinRoom(location.hash.slice(1)), 1200);
}

// ============================================================
//  CONTEXT MENU
// ============================================================
let selectedPid = null;

function showContextMenu(x, y, pid, name) {
    selectedPid = pid;
    document.getElementById('cm-player-name').textContent = name;
    contextMenu.style.left = `${Math.min(x, innerWidth - 170)}px`;
    contextMenu.style.top  = `${Math.min(y, innerHeight - 220)}px`;
    contextMenu.classList.remove('hidden');
}

document.addEventListener('click', e => { if (!contextMenu.contains(e.target)) contextMenu.classList.add('hidden'); });

document.getElementById('cm-give-admin').addEventListener('click', () => {
    if (!isHost || !selectedPid) return;
    roomState.players[selectedPid].admin ^= true;
    broadcastState();
    contextMenu.classList.add('hidden');
});
document.getElementById('cm-kick').addEventListener('click', () => {
    if (!isHost || !selectedPid) return;
    guestConns[selectedPid]?.send({ type: 'kicked' });
    guestConns[selectedPid]?.close();
    contextMenu.classList.add('hidden');
});
document.getElementById('cm-close').addEventListener('click',      () => contextMenu.classList.add('hidden'));
document.getElementById('cm-move-red').addEventListener('click',   () => { changeTeam(selectedPid, 'red');   contextMenu.classList.add('hidden'); });
document.getElementById('cm-move-spect').addEventListener('click', () => { changeTeam(selectedPid, 'spect'); contextMenu.classList.add('hidden'); });
document.getElementById('cm-move-blue').addEventListener('click',  () => { changeTeam(selectedPid, 'blue');  contextMenu.classList.add('hidden'); });

function changeTeam(pid, team) {
    if (!isHost || !roomState.players[pid]) return;
    roomState.players[pid].team = team;
    broadcastState();
}

// ============================================================
//  ESC TOGGLE
// ============================================================
window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !gameContainer.classList.contains('hidden')) {
        innerLobby.classList.toggle('hidden');
        return;
    }
    if (document.activeElement === chatInput) return;
    if (!localKeys[e.code]) {
        localKeys[e.code] = true;
        sendKeys();
    }
});

window.addEventListener('keyup', e => {
    if (document.activeElement === chatInput) return;
    localKeys[e.code] = false;
    sendKeys();
});

function sendKeys() {
    if (!isHost && hostConn) {
        hostConn.send({ type: 'keys', keys: { ...localKeys } });
    }
}

// ============================================================
//  PHYSICS — resetPhysics builds physPlayers from roomState
// ============================================================
function resetPhysics() {
    physPlayers = {};
    ball = freshBall('red');
    const redIds  = Object.keys(roomState.players).filter(id => roomState.players[id].team === 'red');
    const blueIds = Object.keys(roomState.players).filter(id => roomState.players[id].team === 'blue');
    redIds.forEach((id, i) => {
        const sp = spawnForTeam('red', i);
        physPlayers[id] = { ...sp, team: 'red', name: roomState.players[id].name };
    });
    blueIds.forEach((id, i) => {
        const sp = spawnForTeam('blue', i);
        physPlayers[id] = { ...sp, team: 'blue', name: roomState.players[id].name };
    });
}

// Get the effective keys for a given peerId
function keysFor(pid) {
    if (pid === myPeerId) return localKeys;          // host's own input
    return remoteInputs[pid] || {};                   // guest input received from network
}

// Per-player physics — uses WASD for red, Arrows for blue (or either)
function stepPlayer(pl, keys, team) {
    // Both teams accept both WASD and Arrow keys — each player owns their connection
    const left  = keys['KeyA']     || keys['ArrowLeft'];
    const right = keys['KeyD']     || keys['ArrowRight'];
    const jump  = keys['KeyW']     || keys['ArrowUp'];
    const kick  = keys['KeyX']     || keys['Space'];

    if (left)  pl.vx -= P_SPEED;
    if (right) pl.vx += P_SPEED;
    pl.vx *= FRICTION;
    pl.vx = Math.max(-P_SPEED * 1.5, Math.min(P_SPEED * 1.5, pl.vx));

    if (jump && pl.onGround) { pl.vy = JUMP_VY; pl.onGround = false; }

    pl.vy += GRAVITY;
    pl.x  += pl.vx;
    pl.y  += pl.vy;

    if (pl.y >= GROUND_Y - PLAYER_R) { pl.y = GROUND_Y - PLAYER_R; pl.vy = 0; pl.onGround = true; }
    else pl.onGround = false;

    // Walls
    if (pl.x < PLAYER_R)              { pl.x = PLAYER_R;              pl.vx = 0; }
    if (pl.x > CANVAS_W - PLAYER_R)   { pl.x = CANVAS_W - PLAYER_R;  pl.vx = 0; }

    // Net
    if (team === 'red'  && pl.x + PLAYER_R > NET_X - 5) { pl.x = NET_X - 5 - PLAYER_R; pl.vx = 0; }
    if (team === 'blue' && pl.x - PLAYER_R < NET_X + 5) { pl.x = NET_X + 5 + PLAYER_R; pl.vx = 0; }

    // KICK (X or Space) — no cooldown
    if (kick) {
        applyKick(pl);
    }
}

function applyKick(pl) {
    const dx   = ball.x - pl.x;
    const dy   = ball.y - pl.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const kickRange = PLAYER_R + BALL_R + 20;   // generous range

    if (dist < kickRange && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        const power = 16;
        ball.vx = nx * power + pl.vx * 0.5;
        ball.vy = Math.min(ny * power - 4, -2);   // always kick upward-ish
        // push ball out of overlap
        ball.x = pl.x + nx * (PLAYER_R + BALL_R + 2);
        ball.y = pl.y + ny * (PLAYER_R + BALL_R + 2);
    }
}

function stepBall() {
    ball.vy += GRAVITY;
    ball.x  += ball.vx;
    ball.y  += ball.vy;
    ball.vx  = Math.max(-MAX_BVX, Math.min(MAX_BVX, ball.vx));
    ball.vy  = Math.max(-MAX_BVY, Math.min(MAX_BVY, ball.vy));

    // Ceiling
    if (ball.y - BALL_R < 0) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy) * BALL_BOUNCE; }

    // Walls
    if (ball.x - BALL_R < 0)          { ball.x = BALL_R;              ball.vx =  Math.abs(ball.vx) * BALL_BOUNCE; }
    if (ball.x + BALL_R > CANVAS_W)   { ball.x = CANVAS_W - BALL_R;  ball.vx = -Math.abs(ball.vx) * BALL_BOUNCE; }

    // Floor → point
    if (ball.y + BALL_R > GROUND_Y) {
        if (!scoringLocked) onPoint(ball.x < NET_X ? 'blue' : 'red');
        return;
    }

    // Net
    const nL = NET_X - 5, nR = NET_X + 5;
    if (ball.x + BALL_R > nL && ball.x - BALL_R < nR && ball.y > NET_TOP_Y) {
        if (ball.vx > 0) { ball.x = nL - BALL_R; ball.vx = -Math.abs(ball.vx) * BALL_BOUNCE; }
        else             { ball.x = nR + BALL_R; ball.vx =  Math.abs(ball.vx) * BALL_BOUNCE; }
        ball.vy *= 0.7;
    }

    // Passive collisions for all players
    for (const pl of Object.values(physPlayers)) {
        collideBallPlayer(pl);
    }
}

function collideBallPlayer(pl) {
    const dx = ball.x - pl.x, dy = ball.y - pl.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const minD = BALL_R + PLAYER_R;
    if (dist < minD && dist > 0) {
        const nx = dx/dist, ny = dy/dist;
        ball.x = pl.x + nx * minD;
        ball.y = pl.y + ny * minD;
        const rvx = ball.vx - pl.vx, rvy = ball.vy - pl.vy;
        const dot = rvx*nx + rvy*ny;
        if (dot < 0) {
            const r = 1.3;
            ball.vx -= r*dot*nx + pl.vx * 0.35;
            ball.vy -= r*dot*ny + pl.vy * 0.35;
        }
    }
}

// ============================================================
//  SCORING
// ============================================================
function onPoint(scorer) {
    if (!matchActive || scoringLocked) return;
    scoringLocked = true;
    scores[scorer]++;
    updateScoreUI();

    const msg = `🏐 Point for ${scorer.toUpperCase()}! (${scores.red}–${scores.blue})`;
    broadcastChat('System', msg, 'spect');

    const limit = roomState.scoreLimit;
    if (limit > 0 && scores[scorer] >= limit) { endMatch(scorer); return; }

    setTimeout(() => {
        const serveTeam = scorer === 'red' ? 'blue' : 'red';
        ball = freshBall(serveTeam);
        scoringLocked = false;
    }, 1200);
}

function endMatch(winner) {
    matchActive = false;
    clearInterval(timerInterval);
    const data = { type: 'match_ended', winner, scores };
    sendAll(data);
    sysMsg(`🏆 ${winner.toUpperCase()} wins! (${scores.red}–${scores.blue})`);
    dbg(`MATCH ENDED (host) — winner: ${winner}, scores: ${scores.red}-${scores.blue}`);
    roomState.matchStarted = false;
    broadcastState();
    setTimeout(() => innerLobby.classList.remove('hidden'), 2500);
}

function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (!matchActive) { clearInterval(timerInterval); return; }
        matchTimeLeft--;
        updateScoreUI();
        if (roomState.timeLimit > 0 && matchTimeLeft <= 0) {
            endMatch(scores.red >= scores.blue ? 'red' : 'blue');
        }
    }, 1000);
}

function updateScoreUI() {
    scoreDisplay.textContent = `${scores.red} - ${scores.blue}`;
    const m = Math.floor(Math.abs(matchTimeLeft)/60);
    const s = Math.abs(matchTimeLeft) % 60;
    gameTimer.textContent = `${m}:${s.toString().padStart(2,'0')}`;
}

// ============================================================
//  GAME LOOP
// ============================================================
function gameLoop() {
    if (isHost && matchActive) {
        // Step every player using THEIR OWN keys
        for (const [pid, pl] of Object.entries(physPlayers)) {
            const keys = keysFor(pid);
            stepPlayer(pl, keys, pl.team);
        }
        stepBall();

        // Broadcast authoritative tick
        const tick = {
            type: 'game_tick',
            physPlayers: serializePlayers(),
            ball: { ...ball },
            scores: { ...scores },
            timeLeft: matchTimeLeft
        };
        sendAll(tick);
    }

    renderGame();
    gameLoopRAF = requestAnimationFrame(gameLoop);
}

// Slim down physPlayers for network (only what renderer needs)
function serializePlayers() {
    const out = {};
    for (const [id, pl] of Object.entries(physPlayers)) {
        out[id] = { x: pl.x, y: pl.y, team: pl.team, name: pl.name };
    }
    return out;
}

// ============================================================
//  RENDERER
// ============================================================
const TEAM_COLORS = {
    red:  { fill: '#c0392b', stroke: '#e74c3c' },
    blue: { fill: '#1a5276', stroke: '#2980b9' }
};

function renderGame() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Mid ghost line
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(NET_X, 0); ctx.lineTo(NET_X, NET_TOP_Y); ctx.stroke();

    // Net
    ctx.fillStyle = '#ecf0f1';
    ctx.fillRect(NET_X - 4, NET_TOP_Y, 8, NET_H);
    ctx.beginPath(); ctx.arc(NET_X, NET_TOP_Y, 6, 0, Math.PI*2);
    ctx.fillStyle = '#e74c3c'; ctx.fill();

    // Ground line
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, GROUND_Y); ctx.lineTo(CANVAS_W, GROUND_Y); ctx.stroke();

    // Players
    const source = isHost ? physPlayers : physPlayers;   // clients receive physPlayers via tick
    const playerCount = Object.keys(source).length;
    if (playerCount > 0 && matchActive && Math.random() < 0.01) {   // ~1% of frames to avoid spam
        dbg(`PLAYERS RENDERED: ${playerCount} — ${Object.values(source).map(p=>p.name).join(', ')}`);
    }
    for (const [id, pl] of Object.entries(source)) {
        const c = TEAM_COLORS[pl.team] || TEAM_COLORS.red;
        const isMe = id === myPeerId;
        drawPlayer(pl, c.fill, c.stroke, pl.name || '?', isMe);
    }

    // Ball
    drawBall();
}

function drawPlayer(pl, bodyColor, strokeColor, label, isMe) {
    // Shadow
    ctx.beginPath();
    ctx.ellipse(pl.x, GROUND_Y, PLAYER_R*0.75, 5, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();

    // Body gradient
    const g = ctx.createRadialGradient(pl.x-4, pl.y-6, 2, pl.x, pl.y, PLAYER_R);
    g.addColorStop(0, strokeColor);
    g.addColorStop(1, bodyColor);
    ctx.beginPath(); ctx.arc(pl.x, pl.y, PLAYER_R, 0, Math.PI*2);
    ctx.fillStyle = g; ctx.fill();

    // Outline — gold for self
    ctx.strokeStyle = isMe ? '#f1c40f' : '#fff';
    ctx.lineWidth = isMe ? 2.5 : 1.5;
    ctx.stroke();

    // Name label (truncated)
    ctx.fillStyle = '#fff';
    ctx.font = `bold 9px Segoe UI`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.slice(0, 6), pl.x, pl.y);
}

function drawBall() {
    const shadowY     = Math.min(ball.y + BALL_R + 4, GROUND_Y - 2);
    const shadowScale = Math.max(0.1, 1 - (GROUND_Y - ball.y) / CANVAS_H);
    ctx.beginPath();
    ctx.ellipse(ball.x, shadowY, BALL_R*0.7*shadowScale, 4*shadowScale, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();

    const g = ctx.createRadialGradient(ball.x-4, ball.y-4, 2, ball.x, ball.y, BALL_R);
    g.addColorStop(0, '#fff');
    g.addColorStop(0.4, '#f1c40f');
    g.addColorStop(1, '#d4ac0d');
    ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI*2);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = '#7d6608'; ctx.lineWidth = 1.5; ctx.stroke();

    ctx.strokeStyle = 'rgba(100,60,0,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0.3, 0.3+Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0.8+Math.PI*0.5, 0.8+Math.PI*1.5); ctx.stroke();
}
