import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getDatabase, ref, set, onValue, onDisconnect, remove } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

// ============================================================
//  FIREBASE CONFIG
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
const db = getDatabase(app);

// ============================================================
//  USER STATE
// ============================================================
let myUsername = localStorage.getItem("spiker_username") || "";
let myPeerId = null;

// ============================================================
//  DOM REFS
// ============================================================
const loginContainer     = document.getElementById('login-container');
const lobbyContainer     = document.getElementById('lobby-container');
const createRoomModal    = document.getElementById('create-room-modal');
const gameContainer      = document.getElementById('game-container');
const innerLobby         = document.getElementById('inner-lobby');
const usernameInput      = document.getElementById('username-input');
const btnLogin           = document.getElementById('btn-login');
const contextMenu        = document.getElementById('context-menu');
const listRed            = document.getElementById('list-red');
const listSpect          = document.getElementById('list-spect');
const listBlue           = document.getElementById('list-blue');
const canvas             = document.getElementById('gameCanvas');
const ctx                = canvas.getContext('2d');
const scoreDisplay       = document.getElementById('score-display');
const gameTimer          = document.getElementById('game-timer');
const chatLog            = document.getElementById('chat-log');
const chatInput          = document.getElementById('chat-input');
const roomCountDisplay   = document.getElementById('room-count-display');

// ============================================================
//  P2P (Star Topology)
// ============================================================
const peer = new Peer();
let isHost = false;
let hostConn = null;
let guestConns = {};      // { peerId: DataConnection }

// ============================================================
//  ROOM STATE  (Host is source of truth)
// ============================================================
let roomState = {
    matchStarted: false,
    roomName: "Room",
    scoreLimit: 3,
    timeLimit: 3,
    players: {},
    // { peerId: { name, team:'spect'|'red'|'blue', admin:bool, ping:number } }
};

// ============================================================
//  GAME PHYSICS STATE  (only host simulates)
// ============================================================
const CANVAS_W  = 800;
const CANVAS_H  = 480;
const GROUND_Y  = CANVAS_H - 20;   // floor line
const NET_X     = CANVAS_W / 2;
const NET_H     = 110;              // net height above ground
const NET_TOP_Y = GROUND_Y - NET_H;
const BALL_R    = 14;
const PLAYER_R  = 22;
const GRAVITY   = 0.38;
const JUMP_VY   = -10.5;
const PLAYER_SPEED = 5.5;
const FRICTION  = 0.80;
const BALL_BOUNCE = 0.72;
const MAX_BALL_VX = 14;
const MAX_BALL_VY = 14;

function freshBallState(side = 'red') {
    return {
        x: side === 'red' ? CANVAS_W * 0.28 : CANVAS_W * 0.72,
        y: CANVAS_H * 0.25,
        vx: 0,
        vy: 0
    };
}

function freshPlayerState(side) {
    return {
        x: side === 'red' ? CANVAS_W * 0.22 : CANVAS_W * 0.78,
        y: GROUND_Y - PLAYER_R,
        vx: 0,
        vy: 0,
        onGround: true
    };
}

let ball = freshBallState('red');
let players = { red: freshPlayerState('red'), blue: freshPlayerState('blue') };
let scores = { red: 0, blue: 0 };
let matchActive = false;
let matchTimeLeft = 180;   // seconds
let lastTimestamp = null;
let timerInterval = null;

// ============================================================
//  REMOTE KEYS
// ============================================================
let allRemoteKeys = {};   // { peerId: keysObject }
const localKeys = {};

// ============================================================
//  CHAT
// ============================================================
function addChatMessage(authorName, text, team = 'spect', isSystem = false) {
    const div = document.createElement('div');
    div.className = `chat-msg ${isSystem ? 'msg-system' : 'msg-' + team}`;
    if (isSystem) {
        div.textContent = text;
    } else {
        div.innerHTML = `<span class="msg-author">${escapeHTML(authorName)}:</span> ${escapeHTML(text)}`;
    }
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHTML(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function broadcastChat(authorName, text, team) {
    if (!isHost) return;
    const data = { type: 'chat', authorName, text, team };
    Object.values(guestConns).forEach(c => c.send(data));
    addChatMessage(authorName, text, team);
}

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const text = chatInput.value.trim();
        if (!text) return;
        chatInput.value = '';
        const myTeam = roomState.players[myPeerId]?.team || 'spect';

        if (isHost) {
            broadcastChat(myUsername, text, myTeam);
        } else if (hostConn) {
            hostConn.send({ type: 'chat_request', text });
        }
    }
});

// ============================================================
//  1. LOGIN
// ============================================================
if (myUsername) {
    showPublicLobby();
} else {
    loginContainer.classList.remove('hidden');
}

btnLogin.addEventListener('click', doLogin);
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

function doLogin() {
    const val = usernameInput.value.trim();
    if (val.length > 0) {
        myUsername = val;
        localStorage.setItem("spiker_username", myUsername);
        showPublicLobby();
    }
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
//  2. PEER INIT
// ============================================================
peer.on('open', (id) => {
    myPeerId = id;
    document.getElementById('my-id').value = id;
});

peer.on('error', (err) => {
    console.error('PeerJS error:', err);
});

// ============================================================
//  3. FIREBASE ROOM LIST
// ============================================================
const roomsRef = ref(db, 'rooms');
let myRoomRef = null;

onValue(roomsRef, (snapshot) => {
    const roomListElement = document.getElementById('room-list');
    roomListElement.innerHTML = '';
    const rooms = snapshot.val();

    if (!rooms) {
        roomListElement.innerHTML = '<li class="hax-empty-rooms">No active rooms.</li>';
        roomCountDisplay.textContent = '0 players in 0 rooms';
        return;
    }

    let totalRooms = 0;
    for (const peerId in rooms) {
        totalRooms++;
        const room = rooms[peerId];
        const li = document.createElement('li');
        li.className = 'hax-room-item';
        const playerCount = room.playerCount || 1;
        const maxPlayers = room.maxPlayers || 12;
        li.innerHTML = `
            <span class="room-name">${escapeHTML(room.name)}</span>
            <span class="room-players">${playerCount}/${maxPlayers}</span>
            <span class="room-pass">${room.hasPassword ? 'Yes' : 'No'}</span>
            <span class="room-dist"><span class="flag-icon">🇺🇾</span> 0km</span>
        `;
        li.addEventListener('click', () => {
            document.querySelectorAll('.hax-room-item').forEach(el => el.classList.remove('selected'));
            li.classList.add('selected');
        });
        li.addEventListener('dblclick', () => joinRoom(peerId));
        roomListElement.appendChild(li);
    }
    roomCountDisplay.textContent = `${totalRooms} room(s) active`;
});

document.getElementById('btn-refresh').addEventListener('click', () => {
    // Firebase auto-updates via onValue — just give feedback
    addSystemMessage('Refreshing...');
});

// ============================================================
//  4. CREATE ROOM
// ============================================================
document.getElementById('btn-create-room-open').addEventListener('click', () => {
    lobbyContainer.classList.add('hidden');
    createRoomModal.classList.remove('hidden');
});
document.getElementById('btn-cancel-create').addEventListener('click', () => {
    createRoomModal.classList.add('hidden');
    lobbyContainer.classList.remove('hidden');
});

let roomVisibility = true;
document.getElementById('btn-toggle-visibility').addEventListener('click', () => {
    roomVisibility = !roomVisibility;
    document.getElementById('room-visibility-label').textContent = roomVisibility ? 'Yes' : 'No';
});

document.getElementById('btn-host').addEventListener('click', () => {
    if (!myPeerId) { alert("Still connecting... try again in a second."); return; }

    const roomName    = document.getElementById('room-name').value.trim() || `${myUsername}'s room`;
    const hasPassword = document.getElementById('room-password').value.trim().length > 0;
    const maxPlayers  = parseInt(document.getElementById('room-max-players').value) || 12;
    const scoreLimit  = parseInt(document.getElementById('score-limit').value) || 3;
    const timeLimit   = parseInt(document.getElementById('time-limit').value) || 3;

    if (roomVisibility) {
        myRoomRef = ref(db, 'rooms/' + myPeerId);
        set(myRoomRef, {
            name: roomName,
            hostId: myPeerId,
            hostName: myUsername,
            playerCount: 1,
            maxPlayers,
            hasPassword,
            timestamp: Date.now()
        });
        onDisconnect(myRoomRef).remove();
    }

    isHost = true;
    roomState.roomName = roomName;
    roomState.scoreLimit = scoreLimit;
    roomState.timeLimit = timeLimit;
    roomState.players[myPeerId] = { name: myUsername, team: 'spect', admin: true, ping: 0 };

    document.getElementById('room-title-display').innerText = roomName;
    document.getElementById('btn-start-match').classList.remove('hidden');
    document.getElementById('score-limit').value = scoreLimit;
    document.getElementById('time-limit').value = timeLimit;

    enterInnerLobby();
});

// ============================================================
//  5. JOIN ROOM
// ============================================================
function joinRoom(hostId) {
    if (!myPeerId) { alert("Still connecting..."); return; }
    isHost = false;
    hostConn = peer.connect(hostId, { metadata: { name: myUsername } });

    hostConn.on('open', () => {
        enterInnerLobby();
        addSystemMessage('Connected to host.');
    });

    hostConn.on('data', handleHostData);

    hostConn.on('close', () => {
        addSystemMessage('Host closed the room.');
        setTimeout(() => location.reload(), 2000);
    });
    hostConn.on('error', (e) => {
        addSystemMessage('Connection error: ' + e.type);
    });
}

function handleHostData(data) {
    switch (data.type) {
        case 'state_update':
            roomState = data.roomState;
            updateLobbyUI();
            if (roomState.matchStarted && !matchActive) {
                matchActive = true;
                innerLobby.classList.add('hidden');
            }
            break;
        case 'game_tick':
            // Clients just apply what host sends — no physics recalc
            ball = data.ball;
            players = data.players;
            scores = data.scores;
            matchTimeLeft = data.timeLeft;
            updateScoreUI();
            break;
        case 'chat':
            addChatMessage(data.authorName, data.text, data.team);
            break;
        case 'kicked':
            alert("You have been kicked from the room.");
            location.reload();
            break;
    }
}

// Host receives guest connections
peer.on('connection', (conn) => {
    if (!isHost) return;

    conn.on('open', () => {
        const guestName = conn.metadata.name || "Anon";
        guestConns[conn.peer] = conn;
        roomState.players[conn.peer] = { name: guestName, team: 'spect', admin: false, ping: 45 };

        // Update Firebase player count
        if (myRoomRef) {
            set(myRoomRef, {
                ...roomState,
                playerCount: Object.keys(roomState.players).length,
                timestamp: Date.now()
            });
        }

        broadcastState();
        broadcastChat('System', `${guestName} has joined.`, 'spect');
        addSystemMessage(`${guestName} joined.`);
    });

    conn.on('data', (data) => {
        if (data.type === 'keys') {
            allRemoteKeys[conn.peer] = data.keys;
        } else if (data.type === 'chat_request') {
            const sender = roomState.players[conn.peer];
            if (sender) broadcastChat(sender.name, data.text, sender.team);
        }
    });

    conn.on('close', () => {
        const name = roomState.players[conn.peer]?.name || 'Someone';
        delete guestConns[conn.peer];
        delete roomState.players[conn.peer];
        delete allRemoteKeys[conn.peer];
        broadcastState();
        broadcastChat('System', `${name} has left.`, 'spect');
    });

    // Measure ping
    setInterval(() => {
        if (guestConns[conn.peer]) {
            const t = Date.now();
            conn.send({ type: 'ping', t });
        }
    }, 3000);

    conn.on('data', (data) => {
        if (data.type === 'pong' && roomState.players[conn.peer]) {
            roomState.players[conn.peer].ping = Date.now() - data.t;
        }
    });
});

function broadcastState() {
    if (!isHost) return;
    updateLobbyUI();
    const data = { type: 'state_update', roomState };
    Object.values(guestConns).forEach(c => { try { c.send(data); } catch(e){} });
}

function addSystemMessage(text) {
    addChatMessage('', text, 'spect', true);
}

// ============================================================
//  6. INNER LOBBY UI
// ============================================================
function enterInnerLobby() {
    lobbyContainer.classList.add('hidden');
    createRoomModal.classList.add('hidden');
    gameContainer.classList.remove('hidden');
    innerLobby.classList.remove('hidden');
    updateLobbyUI();
    if (isHost) {
        requestAnimationFrame(gameLoop);
    }
}

function updateLobbyUI() {
    listRed.innerHTML = '';
    listSpect.innerHTML = '';
    listBlue.innerHTML = '';

    for (const [id, player] of Object.entries(roomState.players)) {
        const li = document.createElement('li');
        const isMe = id === myPeerId;
        li.innerHTML = `
            <span class="flag-icon">🇺🇾</span>
            <span style="flex:1">${escapeHTML(player.name)}${isMe ? ' <em style="color:#f1c40f;font-size:0.7rem">(you)</em>' : ''}</span>
            <span class="player-ping">${player.ping || 0}ms</span>
        `;
        if (player.admin) li.classList.add('is-admin');

        li.addEventListener('click', (e) => {
            const amIAdmin = roomState.players[myPeerId]?.admin;
            if (amIAdmin && id !== myPeerId) {
                showContextMenu(e.clientX, e.clientY, id, player.name);
            }
        });

        if (player.team === 'red') listRed.appendChild(li);
        else if (player.team === 'blue') listBlue.appendChild(li);
        else listSpect.appendChild(li);
    }

    // Sync score/time limit inputs (host only)
    if (isHost) {
        scoreDisplay.textContent = `${scores.red} - ${scores.blue}`;
    }
}

// ============================================================
//  7. LOBBY CONTROLS (Auto / Rand / Lock / Reset)
// ============================================================

// Start Match
document.getElementById('btn-start-match').addEventListener('click', () => {
    if (!isHost) return;
    const redTeam  = Object.values(roomState.players).filter(p => p.team === 'red');
    const blueTeam = Object.values(roomState.players).filter(p => p.team === 'blue');
    if (redTeam.length === 0 || blueTeam.length === 0) {
        addSystemMessage('Need at least 1 player on each team to start!');
        return;
    }
    roomState.matchStarted = true;
    roomState.scoreLimit = parseInt(document.getElementById('score-limit').value) || 3;
    roomState.timeLimit  = parseInt(document.getElementById('time-limit').value) || 3;

    resetPhysics();
    matchActive = true;
    matchTimeLeft = roomState.timeLimit * 60;
    scores = { red: 0, blue: 0 };
    updateScoreUI();

    broadcastState();
    innerLobby.classList.add('hidden');
    startMatchTimer();
    addSystemMessage('Match started! Good luck!');
    broadcastChat('System', 'Match started!', 'spect');
});

// Auto: evenly distribute players across red/blue
document.getElementById('btn-auto').addEventListener('click', () => {
    if (!isHost) return;
    const ids = Object.keys(roomState.players);
    ids.forEach((id, i) => {
        roomState.players[id].team = i % 2 === 0 ? 'red' : 'blue';
    });
    broadcastState();
});

// Rand: randomly shuffle teams
document.getElementById('btn-rand').addEventListener('click', () => {
    if (!isHost) return;
    const ids = Object.keys(roomState.players).sort(() => Math.random() - 0.5);
    ids.forEach((id, i) => {
        roomState.players[id].team = i % 2 === 0 ? 'red' : 'blue';
    });
    broadcastState();
});

// Reset: put everyone back to spectators
document.getElementById('btn-reset').addEventListener('click', () => {
    if (!isHost) return;
    for (const id in roomState.players) {
        roomState.players[id].team = 'spect';
    }
    broadcastState();
});

// Lock (toggle) — placeholder, just broadcast
document.getElementById('btn-lock').addEventListener('click', () => {
    if (!isHost) return;
    addSystemMessage('Team lock toggled.');
    broadcastState();
});

// Arrow buttons to join/leave teams
document.getElementById('btn-move-right').addEventListener('click', () => {
    moveLocalPlayer('red');
});
document.getElementById('btn-move-left').addEventListener('click', () => {
    moveLocalPlayer('blue');
});

function moveLocalPlayer(team) {
    if (!myPeerId || !roomState.players[myPeerId]) return;
    const current = roomState.players[myPeerId].team;
    const newTeam = current === team ? 'spect' : team;

    if (isHost) {
        roomState.players[myPeerId].team = newTeam;
        broadcastState();
    } else if (hostConn) {
        hostConn.send({ type: 'change_team_request', team: newTeam });
    }
}

// Handle team change requests from guests (host processes)
peer.on('connection', (conn) => {
    conn.on('data', (data) => {
        if (!isHost) return;
        if (data.type === 'change_team_request') {
            if (roomState.players[conn.peer]) {
                roomState.players[conn.peer].team = data.team;
                broadcastState();
            }
        } else if (data.type === 'pong') {
            if (roomState.players[conn.peer]) {
                roomState.players[conn.peer].ping = Date.now() - data.t;
            }
        }
    });
});

// Leave
document.getElementById('btn-leave-room').addEventListener('click', () => {
    if (myRoomRef) remove(myRoomRef);
    location.reload();
});

// Copy Link
document.getElementById('btn-copy-link').addEventListener('click', () => {
    navigator.clipboard?.writeText(`${location.origin}${location.pathname}#${myPeerId}`)
        .then(() => addSystemMessage('Link copied to clipboard.'))
        .catch(() => addSystemMessage(`Room ID: ${myPeerId}`));
});

// Auto-join from URL hash
if (location.hash.length > 1) {
    const hostId = location.hash.slice(1);
    if (myUsername) {
        showPublicLobby();
        setTimeout(() => joinRoom(hostId), 1200);
    }
}

// ============================================================
//  8. CONTEXT MENU
// ============================================================
let selectedPlayerId = null;

function showContextMenu(x, y, playerId, playerName) {
    selectedPlayerId = playerId;
    document.getElementById('cm-player-name').textContent = playerName;
    contextMenu.style.left = `${Math.min(x, window.innerWidth - 170)}px`;
    contextMenu.style.top  = `${Math.min(y, window.innerHeight - 220)}px`;
    contextMenu.classList.remove('hidden');
}

document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) contextMenu.classList.add('hidden');
});

document.getElementById('cm-give-admin').addEventListener('click', () => {
    if (!isHost || !selectedPlayerId) return;
    roomState.players[selectedPlayerId].admin = !roomState.players[selectedPlayerId].admin;
    broadcastState();
    contextMenu.classList.add('hidden');
});
document.getElementById('cm-kick').addEventListener('click', () => {
    if (!isHost || !selectedPlayerId) return;
    if (guestConns[selectedPlayerId]) {
        guestConns[selectedPlayerId].send({ type: 'kicked' });
        guestConns[selectedPlayerId].close();
    }
    contextMenu.classList.add('hidden');
});
document.getElementById('cm-close').addEventListener('click', () => contextMenu.classList.add('hidden'));
document.getElementById('cm-move-red').addEventListener('click', () => changeTeam(selectedPlayerId, 'red'));
document.getElementById('cm-move-spect').addEventListener('click', () => changeTeam(selectedPlayerId, 'spect'));
document.getElementById('cm-move-blue').addEventListener('click', () => changeTeam(selectedPlayerId, 'blue'));

function changeTeam(playerId, team) {
    if (!isHost || !roomState.players[playerId]) return;
    roomState.players[playerId].team = team;
    broadcastState();
    contextMenu.classList.add('hidden');
}

// ============================================================
//  9. ESC TO TOGGLE LOBBY
// ============================================================
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !gameContainer.classList.contains('hidden')) {
        innerLobby.classList.toggle('hidden');
    }
    // Block chat-stealing game keys when chat is focused
    if (document.activeElement === chatInput) return;
    localKeys[e.code] = true;
    if (!isHost && hostConn) hostConn.send({ type: 'keys', keys: { ...localKeys } });
});

window.addEventListener('keyup', (e) => {
    if (document.activeElement === chatInput) return;
    localKeys[e.code] = false;
    if (!isHost && hostConn) hostConn.send({ type: 'keys', keys: { ...localKeys } });
});

// ============================================================
//  10. PHYSICS ENGINE  (Host only)
// ============================================================

function resetPhysics() {
    ball    = freshBallState('red');
    players = { red: freshPlayerState('red'), blue: freshPlayerState('blue') };
}

function getKeysForTeam(team) {
    const myTeam = roomState.players[myPeerId]?.team;
    if (myTeam === team) return localKeys;

    // Pick first guest on that team
    for (const [id, p] of Object.entries(roomState.players)) {
        if (p.team === team && id !== myPeerId && allRemoteKeys[id]) {
            return allRemoteKeys[id];
        }
    }
    return {};
}

function updatePlayerPhysics(pl, keys, side) {
    const left  = side === 'red' ? (keys['KeyA'] || keys['ArrowLeft'])  : (keys['ArrowLeft']  || keys['KeyA']);
    const right = side === 'red' ? (keys['KeyD'] || keys['ArrowRight']) : (keys['ArrowRight'] || keys['KeyD']);
    const jump  = side === 'red' ? (keys['KeyW'] || keys['ArrowUp'])    : (keys['ArrowUp']    || keys['KeyW']);

    if (left)  { pl.vx -= PLAYER_SPEED; }
    if (right) { pl.vx += PLAYER_SPEED; }
    pl.vx *= FRICTION;
    pl.vx = Math.max(-PLAYER_SPEED * 1.5, Math.min(PLAYER_SPEED * 1.5, pl.vx));

    if (jump && pl.onGround) {
        pl.vy = JUMP_VY;
        pl.onGround = false;
    }

    pl.vy += GRAVITY;
    pl.x  += pl.vx;
    pl.y  += pl.vy;

    // Floor
    if (pl.y >= GROUND_Y - PLAYER_R) {
        pl.y = GROUND_Y - PLAYER_R;
        pl.vy = 0;
        pl.onGround = true;
    } else {
        pl.onGround = false;
    }

    // Side walls
    const left_wall  = PLAYER_R;
    const right_wall = CANVAS_W - PLAYER_R;
    if (pl.x < left_wall)  { pl.x = left_wall;  pl.vx = 0; }
    if (pl.x > right_wall) { pl.x = right_wall; pl.vx = 0; }

    // Net collision
    if (side === 'red') {
        if (pl.x + PLAYER_R > NET_X - 5) { pl.x = NET_X - 5 - PLAYER_R; pl.vx = 0; }
    } else {
        if (pl.x - PLAYER_R < NET_X + 5) { pl.x = NET_X + 5 + PLAYER_R; pl.vx = 0; }
    }
}

function updateBallPhysics() {
    ball.vy += GRAVITY;
    ball.x  += ball.vx;
    ball.y  += ball.vy;

    // Clamp velocities
    ball.vx = Math.max(-MAX_BALL_VX, Math.min(MAX_BALL_VX, ball.vx));
    ball.vy = Math.max(-MAX_BALL_VY, Math.min(MAX_BALL_VY, ball.vy));

    // Ceiling
    if (ball.y - BALL_R < 0) {
        ball.y = BALL_R;
        ball.vy = Math.abs(ball.vy) * BALL_BOUNCE;
    }

    // Side walls
    if (ball.x - BALL_R < 0) {
        ball.x = BALL_R;
        ball.vx = Math.abs(ball.vx) * BALL_BOUNCE;
    }
    if (ball.x + BALL_R > CANVAS_W) {
        ball.x = CANVAS_W - BALL_R;
        ball.vx = -Math.abs(ball.vx) * BALL_BOUNCE;
    }

    // Floor = point scored
    if (ball.y + BALL_R > GROUND_Y) {
        const scorer = ball.x < NET_X ? 'blue' : 'red';
        onPoint(scorer);
        return;
    }

    // Net collision (ball can't pass through net above NET_TOP_Y)
    const netLeft  = NET_X - 5;
    const netRight = NET_X + 5;
    if (ball.x + BALL_R > netLeft && ball.x - BALL_R < netRight && ball.y > NET_TOP_Y) {
        // Determine which side ball came from
        if (ball.vx > 0) {
            ball.x = netLeft - BALL_R;
            ball.vx = -Math.abs(ball.vx) * BALL_BOUNCE;
        } else {
            ball.x = netRight + BALL_R;
            ball.vx = Math.abs(ball.vx) * BALL_BOUNCE;
        }
        ball.vy *= 0.7;
    }

    // Player–ball collisions
    collideBallPlayer(players.red);
    collideBallPlayer(players.blue);
}

function collideBallPlayer(pl) {
    const dx   = ball.x - pl.x;
    const dy   = ball.y - pl.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = BALL_R + PLAYER_R;

    if (dist < minDist && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;

        // Push ball out
        ball.x = pl.x + nx * minDist;
        ball.y = pl.y + ny * minDist;

        // Relative velocity
        const relVx = ball.vx - pl.vx;
        const relVy = ball.vy - pl.vy;
        const dot   = relVx * nx + relVy * ny;

        if (dot < 0) {
            const restitution = 1.3;
            ball.vx -= restitution * dot * nx;
            ball.vy -= restitution * dot * ny;

            // Add a touch of player momentum
            ball.vx += pl.vx * 0.35;
            ball.vy += pl.vy * 0.35;
        }
    }
}

// ============================================================
//  11. SCORING
// ============================================================
function onPoint(scorer) {
    if (!matchActive) return;
    scores[scorer]++;
    updateScoreUI();
    addSystemMessage(`Point for ${scorer.toUpperCase()}! Score: ${scores.red}–${scores.blue}`);
    broadcastChat('System', `🏐 Point for ${scorer.toUpperCase()}! (${scores.red}–${scores.blue})`, 'spect');

    const limit = roomState.scoreLimit;
    if (limit > 0 && scores[scorer] >= limit) {
        endMatch(scorer);
        return;
    }

    // Reset ball, serve to loser
    setTimeout(() => {
        const serveTeam = scorer === 'red' ? 'blue' : 'red';
        ball = freshBallState(serveTeam);
    }, 1000);
}

function endMatch(winner) {
    matchActive = false;
    clearInterval(timerInterval);
    addSystemMessage(`🏆 ${winner.toUpperCase()} wins the match! (${scores.red}–${scores.blue})`);
    broadcastChat('System', `🏆 ${winner.toUpperCase()} wins! (${scores.red}–${scores.blue})`, 'spect');
    roomState.matchStarted = false;
    broadcastState();

    setTimeout(() => {
        innerLobby.classList.remove('hidden');
    }, 2500);
}

function startMatchTimer() {
    clearInterval(timerInterval);
    matchTimeLeft = roomState.timeLimit * 60;
    timerInterval = setInterval(() => {
        if (!matchActive) { clearInterval(timerInterval); return; }
        matchTimeLeft--;
        updateScoreUI();
        if (roomState.timeLimit > 0 && matchTimeLeft <= 0) {
            const winner = scores.red >= scores.blue ? 'red' : 'blue';
            endMatch(winner);
        }
    }, 1000);
}

function updateScoreUI() {
    scoreDisplay.textContent = `${scores.red} - ${scores.blue}`;
    const mins = Math.floor(Math.abs(matchTimeLeft) / 60);
    const secs = Math.abs(matchTimeLeft) % 60;
    gameTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ============================================================
//  12. GAME LOOP (Host simulates, Clients just render)
// ============================================================
let gameLoopStarted = false;

function gameLoop(timestamp) {
    if (!lastTimestamp) lastTimestamp = timestamp;
    lastTimestamp = timestamp;

    if (isHost && matchActive) {
        const redKeys  = getKeysForTeam('red');
        const blueKeys = getKeysForTeam('blue');

        updatePlayerPhysics(players.red,  redKeys,  'red');
        updatePlayerPhysics(players.blue, blueKeys, 'blue');
        updateBallPhysics();

        // Broadcast tick to all guests
        const tickData = {
            type: 'game_tick',
            ball: { ...ball },
            players: {
                red:  { x: players.red.x,  y: players.red.y },
                blue: { x: players.blue.x, y: players.blue.y }
            },
            scores: { ...scores },
            timeLeft: matchTimeLeft
        };
        Object.values(guestConns).forEach(c => { try { c.send(tickData); } catch(e){} });
    }

    renderGame();
    requestAnimationFrame(gameLoop);
}

// ============================================================
//  13. RENDERER
// ============================================================
function renderGame() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Field lines
    drawField();

    // Net
    ctx.fillStyle = '#ecf0f1';
    ctx.fillRect(NET_X - 4, NET_TOP_Y, 8, NET_H);

    // Net top marker
    ctx.beginPath();
    ctx.arc(NET_X, NET_TOP_Y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#e74c3c';
    ctx.fill();

    // Ground line
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(CANVAS_W, GROUND_Y);
    ctx.stroke();

    // Players
    drawPlayer(players.red,  '#c0392b', '#e74c3c', 'R');
    drawPlayer(players.blue, '#1a5276', '#2980b9', 'B');

    // Ball
    drawBall();
}

function drawField() {
    // Mid-line hint
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(NET_X, 0);
    ctx.lineTo(NET_X, NET_TOP_Y);
    ctx.stroke();
}

function drawPlayer(pl, bodyColor, strokeColor, label) {
    // Shadow
    ctx.beginPath();
    ctx.ellipse(pl.x, GROUND_Y, PLAYER_R * 0.8, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    // Body
    const grad = ctx.createRadialGradient(pl.x - 4, pl.y - 6, 2, pl.x, pl.y, PLAYER_R);
    grad.addColorStop(0, strokeColor);
    grad.addColorStop(1, bodyColor);
    ctx.beginPath();
    ctx.arc(pl.x, pl.y, PLAYER_R, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Label
    ctx.fillStyle = '#fff';
    ctx.font = `bold 12px Segoe UI`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pl.x, pl.y);
}

function drawBall() {
    // Shadow
    const shadowY = Math.min(ball.y + BALL_R + 4, GROUND_Y - 2);
    const shadowScale = 1 - Math.max(0, (GROUND_Y - ball.y) / CANVAS_H);
    ctx.beginPath();
    ctx.ellipse(ball.x, shadowY, BALL_R * 0.7 * shadowScale, 4 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fill();

    // Ball body
    const grad = ctx.createRadialGradient(ball.x - 4, ball.y - 4, 2, ball.x, ball.y, BALL_R);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.4, '#f1c40f');
    grad.addColorStop(1, '#d4ac0d');
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#7d6608';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Volleyball seam lines
    ctx.strokeStyle = 'rgba(100,60,0,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0.3, 0.3 + Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0.3 + Math.PI * 0.5, 0.3 + Math.PI * 1.5);
    ctx.stroke();
}

// ============================================================
//  14. START HOST GAME LOOP
// ============================================================
function startGameLoop() {
    if (!gameLoopStarted) {
        gameLoopStarted = true;
        requestAnimationFrame(gameLoop);
    }
}

// Host starts loop immediately on room create so the canvas shows
peer.on('open', () => {
    // Will be started by enterInnerLobby for host
});
