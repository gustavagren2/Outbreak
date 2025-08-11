// ---------- Utilities ----------
const el = (id) => {
  const e = document.getElementById(id);
  if (!e) console.warn(`[UI] Missing element #${id}`);
  return e;
};
function showPhaseSections(phase) {
  if (lobby)  lobby.classList.toggle('hidden',  phase !== 'LOBBY');
  if (reveal) reveal.classList.toggle('hidden', phase !== 'COUNTDOWN');
  if (game)   game.classList.toggle('hidden',   phase !== 'GAME');
  if (board)  board.classList.toggle('hidden',  phase !== 'LEADERBOARD');
}

// ---------- Socket ----------
const socket = io();

// ---------- Palette ----------
const palette = [
  '#2d3e50','#365e2b','#6f3d20','#2b2b2b','#6b59b1',
  '#d4458c','#e4b737','#2d5fab','#7a3f75','#7b1c28'
];

// ---------- State ----------
let state = {
  you: null,
  host: false,
  phase: 'LOBBY',
  round: 0,
  totalRounds: 0,
  players: [],
  world: { w: 1100, h: 620 },
  countdownEndsAt: null,
  gameEndsAt: null,
  boardEndsAt: null
};

// ---------- Sections ----------
const lobby  = el('lobby');
const reveal = el('reveal');
const game   = el('game');
const board  = el('board');

// ---------- Lobby refs ----------
const avatarCanvas = el('avatarCanvas'); const ac = avatarCanvas?.getContext('2d');
const avatarRow = el('avatarRow');
const nameInput = el('nameInput');
const readyChk = el('readyChk');
const playerList = el('playerList');
const startBtn = el('startBtn');
const readyCount = el('readyCount');

const chatLog = el('chatLog');
const chatInput = el('chatInput');
const chatSend = el('chatSend');

// ---------- Reveal refs ----------
const revealAvatar = el('revealAvatar');
const revealTitle  = el('revealTitle');
const revealText   = el('revealText');
const countdown    = el('countdown');

// ---------- Game refs ----------
const gameCanvas = el('gameCanvas'); const gctx = gameCanvas?.getContext('2d');
const roundText = el('roundText');
const gameTimer = el('gameTimer');
const infectCount = el('infectCount');
const timeBar = el('timeBar');

// ---------- Board refs ----------
const boardRound = el('boardRound');
const boardRows  = el('boardRows');
const boardNext  = el('boardNext');
const boardCountdown = el('boardCountdown');

// ---------- Audio (8-bit beeps) ----------
let actx, unlocked=false;
const unlockAudio = () => { if (!unlocked){ actx = new (window.AudioContext||window.webkitAudioContext)(); unlocked=true; } };
addEventListener('pointerdown', unlockAudio, { once:true });
const beep = (type='click')=>{
  if (!unlocked) return;
  const now = actx.currentTime;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = 'square';
  const tones = { click:660, select:760, ready:520, start:880, tick:440, infect:180, score:620 };
  o.frequency.value = tones[type] || 660;
  g.gain.setValueAtTime(.001, now);
  g.gain.exponentialRampToValueAtTime(.2, now + .01);
  g.gain.exponentialRampToValueAtTime(.001, now + .12);
  o.connect(g); g.connect(actx.destination);
  o.start(now); o.stop(now + .13);
};

// ---------- Avatar drawing (two big eyes, black pupils) ----------
let selectedAvatar = 5;
function drawAvatar(ctx, color, scale){
  const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*scale,y*scale,w*scale,h*scale); };
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  px(2,2,6,5,color);          // body
  px(2,7,6,1,'#fff');         // feet/base
  // eyes: white rectangles 2x2 + black pupils 1x1
  px(3,3,2,2,'#fff'); px(6,3,2,2,'#fff');
  px(4,4,1,1,'#000'); px(7,4,1,1,'#000');
  px(8,2,1,1,'#ffd27b');      // hat pixel
}
if (ac) drawAvatar(ac, palette[selectedAvatar], 16);

function renderPalette(){
  if (!avatarRow) return;
  avatarRow.innerHTML = '';
  palette.forEach((c, i)=>{
    const b = document.createElement('button');
    b.className = 'avatar' + (i===selectedAvatar ? ' is-selected' : '');
    b.style.background = c;
    b.onclick = ()=>{
      selectedAvatar = i;
      if (ac) drawAvatar(ac, palette[selectedAvatar], 16);
      socket.emit('set_avatar', { avatar: selectedAvatar });
      beep('select');
    };
    avatarRow.appendChild(b);
  });
}
renderPalette();

// ---------- Lobby input ----------
nameInput?.addEventListener('change', ()=>{ socket.emit('set_name', { name: nameInput.value.trim() }); beep('click'); });
readyChk?.addEventListener('change', ()=>{ socket.emit('set_ready', { ready: readyChk.checked }); beep('ready'); });
chatSend?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') sendChat(); });
function sendChat(){
  const t = chatInput.value.trim(); if (!t) return;
  socket.emit('chat', { message: t });
  chatInput.value = '';
  beep('click');
}
startBtn?.addEventListener('click', ()=>{
  socket.emit('start_game');
  beep('start');
});

// ---------- Movement input ----------
const keys={};
addEventListener('keydown', e=> { keys[e.key]=true; sendDir(); });
addEventListener('keyup',   e=> { keys[e.key]=false; sendDir(); });
function sendDir(){
  if (state.phase!=='GAME') return;
  const x = (keys['ArrowRight']||keys['d']||keys['D']?1:0) - (keys['ArrowLeft']||keys['a']||keys['A']?1:0);
  const y = (keys['ArrowDown']||keys['s']||keys['S']?1:0) - (keys['ArrowUp']||keys['w']||keys['W']?1:0);
  socket.emit('input', { dir: { x, y } });
}

// ---------- Sockets ----------
socket.on('room_joined', ({ you, host })=>{
  state.you = you; state.host = !!host;
});

let boardTimer = null;
function stopBoardTimer(){ if(boardTimer){ clearInterval(boardTimer); boardTimer=null; } }

socket.on('room_state', (payload)=>{
  const { phase, round, totalRounds, players, countdownEndsAt, gameEndsAt, boardEndsAt, board:boardData, world } = payload;

  state.phase = phase;
  state.round = round;
  state.totalRounds = totalRounds;
  state.players = players || [];
  state.world = world || state.world;
  state.countdownEndsAt = countdownEndsAt || null;
  state.gameEndsAt = gameEndsAt || null;
  state.boardEndsAt = boardEndsAt ?? null;

  // section visibility
  showPhaseSections(phase);

  // LOBBY
  if (phase === 'LOBBY' && playerList){
    playerList.innerHTML = '';
    const readyNum = state.players.filter(p=>p.ready).length;
    if (readyCount) readyCount.textContent = `${readyNum}/${state.players.length} players ready`;
    if (startBtn) startBtn.disabled = !(state.host && state.players.length>=3 && readyNum===state.players.length);

    state.players.forEach(p=>{
      const li = document.createElement('li');
      li.innerHTML = `<span class="dot" style="background:${palette[p.avatar||0]}"></span> ${p.name} ${p.id===state.you?'<span class="muted">(you)</span>':''} ${p.id===state.you&&state.host?'<span class="tag host">HOST</span>':''} ${p.ready?'<span class="ok">READY</span>':''}`;
      playerList.appendChild(li);
    });
  }

  // COUNTDOWN
  if (phase === 'COUNTDOWN') startCountdownTicks(); else stopCountdownTicks();

  // LEADERBOARD
  if (phase === 'LEADERBOARD' && boardRows){
    if (boardRound) boardRound.textContent = `Round ${state.round} of ${state.totalRounds}`;
    boardRows.innerHTML = '';
    (boardData||[]).forEach(row=>{
      const div = document.createElement('div'); div.className = 'trow';
      div.innerHTML = `
        <div><span class="dot" style="background:${palette[row.avatar||0]}"></span> ${row.name}</div>
        <div class="t-right">${row.survSec}</div>
        <div class="t-right">${row.infections}</div>
        <div class="t-right">${row.bonus}</div>
        <div class="t-right">${row.roundScore}</div>
        <div class="t-right">${row.total}</div>`;
      boardRows.appendChild(div);
    });
    // show / hide board countdown
    stopBoardTimer();
    if (boardNext){
      if (state.boardEndsAt){
        boardNext.classList.remove('hidden');
        const run=()=>{
          const ms = Math.max(0, state.boardEndsAt - Date.now());
          const s = Math.ceil(ms/1000);
          if (boardCountdown) boardCountdown.textContent = s + 's';
        };
        run(); boardTimer = setInterval(run, 200);
      } else {
        boardNext.classList.add('hidden'); // final leaderboard stays
      }
    }
    beep('score');
  }
});

socket.on('role', ({ role })=>{
  const ctx = revealAvatar?.getContext('2d');
  if (ctx) drawAvatar(ctx, palette[selectedAvatar], 12);
  if (revealTitle && revealText){
    if (role === 'PATIENT_ZERO'){
      revealTitle.textContent = 'You are patient Zero.';
      revealText.textContent = 'Try and get close to players to infect them.';
    } else {
      revealTitle.textContent = 'You are a citizen.';
      revealText.textContent = 'Stay away from infected players.';
    }
  }
});

socket.on('chat_message', ({ from, text })=>{
  if (!chatLog) return;
  const div = document.createElement('div');
  div.textContent = `${from}: ${text}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

socket.on('system_message', (m)=>{ if (m?.startsWith?.('infect:')) beep('infect'); });

// ---------- Countdown display ----------
let countdownTimer=null;
function startCountdownTicks(){
  stopCountdownTicks();
  const run=()=>{
    const ms = Math.max(0, (state.countdownEndsAt||Date.now()) - Date.now());
    const s = Math.ceil(ms/1000);
    if (countdown) countdown.textContent = s + 's';
    if (s <= 3) beep('tick');
  };
  run(); countdownTimer = setInterval(run, 200);
}
function stopCountdownTicks(){ if(countdownTimer){ clearInterval(countdownTimer); countdownTimer=null; } }

// ---------- Game drawing ----------
const lastPos = new Map(); // for movement detection
let animTime = 0;

socket.on('game_state', ({ phase, positions, round, totalRounds, gameEndsAt })=>{
  if (phase !== 'GAME' || !gctx) return;

  // HUD
  if (roundText) roundText.textContent = `Round ${round} of ${totalRounds}`;
  const ms = Math.max(0, (gameEndsAt||Date.now()) - Date.now());
  const s = Math.ceil(ms/1000);
  if (gameTimer) gameTimer.textContent = s.toString();
  if (timeBar) timeBar.style.width = (100 - (ms / 90000) * 100) + '%';
  if (infectCount) infectCount.textContent = positions.filter(p=>p.infected).length.toString();

  drawGame(positions);
});

function drawGame(positions){
  const w = state.world.w, h = state.world.h;
  gctx.clearRect(0,0,w,h);

  // white frame
  gctx.strokeStyle = '#fff';
  gctx.lineWidth = 2;
  gctx.strokeRect(6,6,w-12,h-12);

  // time for animation
  const now = performance.now();
  const dt = (now - animTime) || 16;
  animTime = now;

  const infected = positions.filter(p=>p.infected);
  const healthy  = positions.filter(p=>!p.infected);

  positions.forEach(p=>{
    // green proximity square for infected
    if (p.infected){
      gctx.fillStyle = 'rgba(0,255,0,0.08)';
      gctx.fillRect(p.x-36, p.y-36, 72, 72);
      gctx.strokeStyle = 'rgba(0,255,0,0.25)';
      gctx.strokeRect(p.x-36, p.y-36, 72, 72);
    }

    const last = lastPos.get(p.id) || { x:p.x, y:p.y };
    const moving = (Math.hypot(p.x-last.x, p.y-last.y) > 0.5);
    lastPos.set(p.id, { x:p.x, y:p.y });

    // eye target: citizens look at nearest infected; infected look at nearest healthy
    let tx=p.x, ty=p.y-12;
    const pool = p.infected ? healthy : infected;
    if (pool.length){
      let best=null, d2=1e9;
      for (const o of pool){ const dx=o.x-p.x, dy=o.y-p.y, dd=dx*dx+dy*dy; if (dd<d2){ d2=dd; best=o; } }
      if (best){ tx=best.x; ty=best.y; }
    }

    drawMiniSprite(gctx, p.x, p.y, palette[p.avatar||0], moving, dt, tx, ty);

    if (p.id === state.you){
      gctx.fillStyle = '#bbb';
      gctx.font = '12px ui-monospace, monospace';
      gctx.textAlign = 'center';
      gctx.fillText('you', Math.round(p.x), Math.round(p.y) + 28);
    }
  });
}

// mini sprite with two big eyes; pupils track (tx,ty); “feet” alternate when moving
let stepPhase = 0;
function drawMiniSprite(ctx, cx, cy, color, moving, dt, tx, ty){
  stepPhase += (moving ? dt*0.02 : dt*0.006); // faster steps when moving
  const footOff = moving ? (Math.sin(stepPhase)*1) : 0;

  const x0 = Math.round(cx) - 12;
  const y0 = Math.round(cy) - 12;

  ctx.imageSmoothingEnabled = false;

  // body
  ctx.fillStyle = color; ctx.fillRect(x0+6, y0+6, 12, 12);

  // eyes (white rectangles 4x4)
  ctx.fillStyle = '#fff'; ctx.fillRect(x0+7, y0+8, 4, 4); ctx.fillRect(x0+13, y0+8, 4, 4);

  // pupils offset toward target (max 1px)
  const dx = Math.max(-1, Math.min(1, Math.round((tx - cx)/20)));
  const dy = Math.max(-1, Math.min(1, Math.round((ty - cy)/20)));
  ctx.fillStyle = '#000'; ctx.fillRect(x0+9+dx, y0+10+dy, 2, 2); ctx.fillRect(x0+15+dx, y0+10+dy, 2, 2);

  // hat pixel
  ctx.fillStyle = '#ffd27b'; ctx.fillRect(x0+18, y0+6, 3, 3);

  // feet/base (alternate 1px to imply steps)
  ctx.fillStyle = '#fff';
  ctx.fillRect(x0+6,  y0+18 + (footOff>0?1:0), 5, 3);
  ctx.fillRect(x0+13, y0+18 + (footOff<0?1:0), 5, 3);
}
