// ---------- Helpers ----------
const el = (id) => { const e = document.getElementById(id); if(!e) console.warn(`[UI] Missing #${id}`); return e; };
function showPhaseSections(phase) {
  if (lobby)  lobby.classList.toggle('hidden',  phase !== 'LOBBY');
  if (reveal) reveal.classList.toggle('hidden', phase !== 'COUNTDOWN');
  if (game)   game.classList.toggle('hidden',   phase !== 'GAME');
  if (board)  board.classList.toggle('hidden',  phase !== 'LEADERBOARD');
  document.body.classList.toggle('fullscreen', phase === 'GAME');
}

// ---------- Socket ----------
const socket = io();

// ---------- Palette ----------
const palette = ['#2d3e50','#365e2b','#6f3d20','#2b2b2b','#6b59b1','#d4458c','#e4b737','#2d5fab','#7a3f75','#7b1c28'];
const INFECT_COLOR = '#00c83a';

// ---------- State ----------
let state = { you:null, host:false, phase:'LOBBY', round:0, totalRounds:0, players:[], world:{w:1600,h:900}, countdownEndsAt:null, gameEndsAt:null, boardEndsAt:null };

// ---------- Sections & Refs ----------
const lobby  = el('lobby');
const reveal = el('reveal');
const game   = el('game');
const board  = el('board');

const avatarCanvas = el('avatarCanvas'); const ac = avatarCanvas?.getContext('2d');
const nameInput = el('nameInput');
const readyChk = el('readyChk');
const playerList = el('playerList');
const startBtn = el('startBtn');
const readyCount = el('readyCount');

const chatLog = el('chatLog');
const chatInput = el('chatInput');
const chatSend = el('chatSend');

const revealAvatar = el('revealAvatar');
const revealTitle  = el('revealTitle');
const revealText   = el('revealText');
const countdown    = el('countdown');

const gameCanvas = el('gameCanvas'); const gctx = gameCanvas?.getContext('2d');
const roundText = el('roundText'); const gameTimer = el('gameTimer'); const infectCount = el('infectCount');

const boardRound = el('boardRound'); const boardRows = el('boardRows');
const boardNext = el('boardNext'); const boardCountdown = el('boardCountdown');
const finalExtras = el('finalExtras');
const boardChatLog = el('boardChatLog'); const boardChatInput = el('boardChatInput'); const boardChatSend = el('boardChatSend');
const playAgainBtn = el('playAgainBtn');

// ---------- Audio ----------
let actx, unlocked=false;
addEventListener('pointerdown', ()=>{ if(!unlocked){ actx = new (window.AudioContext||window.webkitAudioContext)(); unlocked=true; } }, { once:true });
const beep = (type='click')=>{
  if (!unlocked) return;
  const now = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type='square'; const tones = { click:660, select:760, ready:520, start:880, tick:440, infect:180, score:620, error:200 };
  o.frequency.value = tones[type] || 660;
  g.gain.setValueAtTime(.001, now); g.gain.exponentialRampToValueAtTime(.2, now+.01); g.gain.exponentialRampToValueAtTime(.001, now+.12);
  o.connect(g); g.connect(actx.destination); o.start(now); o.stop(now+.13);
};

// ---------- Avatar preview (bigger, with eyes) ----------
let myAvatarIdx = 5;
function drawAvatarPreview(color){
  if (!ac) return;
  const ctx = ac; const scale = 14;
  const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*scale,y*scale,w*scale,h*scale); };
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  px(2,2,7,6,color);          // body
  px(2,8,7,1,'#fff');         // feet
  px(3,4,2,2,'#fff'); px(6,4,2,2,'#fff'); // eyes
  px(4,5,1,1,'#000'); px(7,5,1,1,'#000'); // pupils
  px(9,3,1,1,'#ffd27b');      // hat pixel
}

// ---------- Tiny sprite for UI rows (data URL cache) ----------
const thumbCache = new Map();
function makeThumb(color){
  if (thumbCache.has(color)) return thumbCache.get(color);
  const c = document.createElement('canvas'); c.width=18; c.height=18; const x=c.getContext('2d'); x.imageSmoothingEnabled=false;
  x.fillStyle=color; x.fillRect(4,4,10,10);
  x.fillStyle='#fff'; x.fillRect(6,7,3,3); x.fillRect(11,7,3,3);
  x.fillStyle='#000'; x.fillRect(7,8,1,1); x.fillRect(12,8,1,1);
  const url = c.toDataURL(); thumbCache.set(color, url); return url;
}

// ---------- Inputs ----------
nameInput?.addEventListener('change', ()=>{ socket.emit('set_name', { name: nameInput.value.trim() }); beep('click'); });
readyChk?.addEventListener('change', ()=>{ socket.emit('set_ready', { ready: readyChk.checked }); beep('ready'); });
chatSend?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') sendChat(); });
function sendChat(){ const t=chatInput.value.trim(); if(!t) return; socket.emit('chat', { message:t }); chatInput.value=''; beep('click'); }

const sendBoardChat=()=>{ const t=boardChatInput?.value.trim(); if(!t) return; socket.emit('chat',{ message:t }); boardChatInput.value=''; beep('click'); };
boardChatSend?.addEventListener('click', sendBoardChat);
boardChatInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') sendBoardChat(); });

startBtn?.addEventListener('click', ()=>{ socket.emit('start_game'); beep('start'); });
playAgainBtn?.addEventListener('click', ()=>{ socket.emit('restart_series'); beep('start'); });

// ---------- Movement (robust) ----------
const keys = Object.create(null);
const isMovementKey = (k) => (
  k==='ArrowUp' || k==='ArrowDown' || k==='ArrowLeft' || k==='ArrowRight' ||
  k==='w' || k==='a' || k==='s' || k==='d' || k==='W' || k==='A' || k==='S' || k==='D'
);

addEventListener('keydown', e=>{
  if (!isMovementKey(e.key)) return;
  if (state.phase==='GAME') e.preventDefault(); // stop page scroll / focus moves
  keys[e.key] = true;
  sendDir();
}, { passive:false });

addEventListener('keyup', e=>{
  if (!isMovementKey(e.key)) return;
  if (state.phase==='GAME') e.preventDefault();
  keys[e.key] = false;
  sendDir();
}, { passive:false });

// Clear stuck keys if tab loses focus (helps “one player can’t move up” issues)
addEventListener('blur', ()=>{ for (const k in keys) delete keys[k]; sendDir(); });
document.addEventListener('visibilitychange', ()=>{ if (document.hidden){ for (const k in keys) delete keys[k]; sendDir(); } });

function sendDir(){
  if (state.phase!=='GAME') return;
  const x = (keys['ArrowRight']||keys['d']||keys['D']?1:0) - (keys['ArrowLeft']||keys['a']||keys['A']?1:0);
  const y = (keys['ArrowDown']||keys['s']||keys['S']?1:0) - (keys['ArrowUp']||keys['w']||keys['W']?1:0);
  socket.emit('input', { dir:{ x, y } });
}

// ---------- Sockets ----------
socket.on('room_joined', ({ you, host })=>{ state.you=you; state.host=!!host; });

let countdownTimer=null, boardTimer=null;
const stopCountdown=()=>{ if(countdownTimer){ clearInterval(countdownTimer); countdownTimer=null; } };
const stopBoardTimer=()=>{ if(boardTimer){ clearInterval(boardTimer); boardTimer=null; } };

socket.on('room_state', (payload)=>{
  const { phase, round, totalRounds, players, countdownEndsAt, gameEndsAt, boardEndsAt, board:boardData, world } = payload;

  state.phase=phase; state.round=round; state.totalRounds=totalRounds;
  state.players=players||[]; state.world=world||state.world;
  state.countdownEndsAt=countdownEndsAt||null; state.gameEndsAt=gameEndsAt||null; state.boardEndsAt=boardEndsAt??null;

  // update my avatar colour & preview
  const me = state.players.find(p=>p.id===state.you);
  if (me) { const idx = me.avatar|0; if (idx!==undefined) { drawAvatarPreview(palette[idx]); } }

  // sections + fullscreen
  showPhaseSections(phase);

  // LOBBY
  if (phase==='LOBBY' && playerList){
    playerList.innerHTML='';
    const readyNum = state.players.filter(p=>p.ready).length;

    // Host-only "Start game"
    if (startBtn) {
      startBtn.classList.toggle('hidden', !state.host);
      startBtn.disabled = !(state.host && state.players.length>=3 && readyNum===state.players.length);
    }
    if (readyCount) readyCount.textContent = `${readyNum}/${state.players.length} players ready`;

    state.players.forEach(p=>{
      const li=document.createElement('li');
      const img = document.createElement('img'); img.className='picon'; img.src = makeThumb(palette[p.avatar||0]); img.alt='';
      const name = document.createElement('span'); name.className='pname'; name.textContent = p.name + (p.id===state.you?' (you)':'');
      li.appendChild(img); li.appendChild(name);
      if (p.id===state.you && state.host){ const tag=document.createElement('span'); tag.className='tag host'; tag.textContent='HOST'; li.appendChild(tag); }
      if (p.ready){ const ok=document.createElement('span'); ok.className='ok'; ok.textContent='READY'; li.appendChild(ok); }
      playerList.appendChild(li);
    });
  }

  // COUNTDOWN
  if (phase==='COUNTDOWN'){
    stopCountdown();
    const run=()=>{ const ms=Math.max(0,(state.countdownEndsAt||Date.now())-Date.now()); const s=Math.ceil(ms/1000); if (countdown) countdown.textContent=s+'s'; if(s<=3) beep('tick'); };
    run(); countdownTimer=setInterval(run,200);
  } else stopCountdown();

  // LEADERBOARD
  if (phase==='LEADERBOARD' && boardRows){
    if (boardRound) boardRound.textContent = `Round ${state.round} of ${state.totalRounds}`;
    boardRows.innerHTML='';
    (boardData||[]).forEach(row=>{
      const div=document.createElement('div'); div.className='trow';
      const cell=document.createElement('div'); cell.className='namecell';
      const img=document.createElement('img'); img.className='picon'; img.src=makeThumb(palette[row.avatar||0]); cell.appendChild(img);
      const span=document.createElement('span'); span.textContent=row.name; cell.appendChild(span);
      div.appendChild(cell);
      div.innerHTML += `
        <div class="t-right">${row.survSec}</div>
        <div class="t-right">${row.infections}</div>
        <div class="t-right">${row.bonus}</div>
        <div class="t-right">${row.roundScore}</div>
        <div class="t-right">${row.total}</div>`;
      boardRows.appendChild(div);
    });

    // Between rounds: countdown; Final: chat + play again
    stopBoardTimer();
    const isFinal = !state.boardEndsAt;
    if (isFinal){
      finalExtras?.classList.remove('hidden');
      boardNext?.classList.add('hidden');
    } else {
      finalExtras?.classList.add('hidden');
      if (boardNext){
        boardNext.classList.remove('hidden');
        const run=()=>{ const ms=Math.max(0,state.boardEndsAt - Date.now()); const s=Math.ceil(ms/1000); if (boardCountdown) boardCountdown.textContent=s+'s'; };
        run(); boardTimer=setInterval(run,200);
      }
    }
    beep('score');
  }
});

socket.on('role', ({ role })=>{
  const rctx = revealAvatar?.getContext('2d');
  if (rctx) {
    const scale = 12, ctx=rctx;
    const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*scale,y*scale,w*scale,h*scale); };
    ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
    // preview in your assigned colour
    const me = state.players.find(p=>p.id===state.you);
    const color = palette[(me?.avatar|0) || 0];
    px(2,2,7,6,color); px(2,8,7,1,'#fff'); px(3,4,2,2,'#fff'); px(6,4,2,2,'#fff'); px(4,5,1,1,'#000'); px(7,5,1,1,'#000'); px(9,3,1,1,'#ffd27b');
  }
  if (revealTitle && revealText){
    if (role==='PATIENT_ZERO'){ revealTitle.textContent='You are patient Zero.'; revealText.textContent='Try and get close to players to infect them.'; }
    else { revealTitle.textContent='You are a citizen.'; revealText.textContent='Stay away from infected players.'; }
  }
});

socket.on('chat_message', ({ from, avatar, text })=>{
  const url = makeThumb(palette[avatar||0]);
  const row = document.createElement('div'); row.className='rowline';
  const img = document.createElement('img'); img.src=url; img.alt=''; row.appendChild(img);
  const span = document.createElement('span'); span.textContent = `${from}: ${text}`; row.appendChild(span);
  if (chatLog){ chatLog.appendChild(row.cloneNode(true)); chatLog.scrollTop = chatLog.scrollHeight; }
  if (boardChatLog){ boardChatLog.appendChild(row); boardChatLog.scrollTop = boardChatLog.scrollHeight; }
});

socket.on('error_message', (m)=>{ console.warn('[server]', m); beep('error'); });

// ---------- Game drawing ----------
const lastPos = new Map(); let animTime=0, stepPhase=0;

// prevent Space from scrolling too, just in case
addEventListener('keydown', e=>{ if(state.phase==='GAME' && (e.key===' '||e.code==='Space')){ e.preventDefault(); } }, { passive:false });

socket.on('game_state', ({ phase, positions, round, totalRounds, gameEndsAt })=>{
  if (phase!=='GAME' || !gctx) return;

  if (roundText) roundText.textContent = `Round ${round} of ${totalRounds}`;
  const ms=Math.max(0,(gameEndsAt||Date.now())-Date.now());
  const s=Math.ceil(ms/1000);
  if (gameTimer) gameTimer.textContent = s.toString();
  if (infectCount) infectCount.textContent = positions.filter(p=>p.infected).length.toString();

  drawGame(positions);
});

function drawGame(positions){
  const w=state.world.w, h=state.world.h;
  gctx.clearRect(0,0,w,h);

  // frame
  gctx.strokeStyle='#fff'; gctx.lineWidth=2; gctx.strokeRect(6,6,w-12,h-12);

  // timing
  const now=performance.now(); const dt=(now-animTime)||16; animTime=now; stepPhase += dt*0.02;

  const infected = positions.filter(p=>p.infected);
  const healthy  = positions.filter(p=>!p.infected);

  positions.forEach(p=>{
    const last=lastPos.get(p.id)||{x:p.x,y:p.y};
    const moving=(Math.hypot(p.x-last.x,p.y-last.y)>0.5);
    lastPos.set(p.id,{x:p.x,y:p.y});

    // eye target
    let tx=p.x, ty=p.y-14;
    const pool = p.infected ? healthy : infected;
    if (pool.length){
      let best=null, d2=1e9;
      for (const o of pool){ const dx=o.x-p.x, dy=o.y-p.y, dd=dx*dx+dy*dy; if(dd<d2){ d2=dd; best=o; } }
      if (best){ tx=best.x; ty=best.y; }
    }

    const baseColor = p.infected ? INFECT_COLOR : palette[p.avatar||0];
    drawMiniSprite(gctx, p.x, p.y, baseColor, p.infected, moving, dt, tx, ty);
    if (p.id===state.you){
      gctx.fillStyle='#bbb'; gctx.font='12px ui-monospace, monospace'; gctx.textAlign='center';
      gctx.fillText('you', Math.round(p.x), Math.round(p.y)+38);
    }
  });
}

// Bigger sprite (~36px total), with arms:
// - Zombies: arms straight out forward.
// - Citizens: flailing side arms (alternate with stepPhase).
function drawMiniSprite(ctx, cx, cy, color, infected, moving, dt, tx, ty){
  const x0 = Math.round(cx) - 18;
  const y0 = Math.round(cy) - 18;
  ctx.imageSmoothingEnabled = false;

  // body (24x24)
  ctx.fillStyle=color; ctx.fillRect(x0+6, y0+8, 24, 24);

  // arms
  ctx.fillStyle=color;
  if (infected){
    // forward arms (two bars in front/top)
    ctx.fillRect(x0+10, y0+4, 8, 3);
    ctx.fillRect(x0+22, y0+4, 8, 3);
  } else {
    // flailing side arms
    const amp = moving ? 4 : 1;
    const yL = y0+16 + Math.round(Math.sin(stepPhase)*amp);
    const yR = y0+16 + Math.round(Math.sin(stepPhase+Math.PI)*amp);
    ctx.fillRect(x0+2,  yL, 6, 3);  // left arm
    ctx.fillRect(x0+32, yR, 6, 3);  // right arm
  }

  // eyes (6x6)
  ctx.fillStyle='#fff'; ctx.fillRect(x0+11, y0+16, 6, 6); ctx.fillRect(x0+23, y0+16, 6, 6);

  // pupils with slight offset toward target (max 2px)
  const dx = Math.max(-2, Math.min(2, Math.round((tx - cx)/18)));
  const dy = Math.max(-2, Math.min(2, Math.round((ty - cy)/18)));
  ctx.fillStyle='#000'; ctx.fillRect(x0+13+dx, y0+18+dy, 3, 3); ctx.fillRect(x0+25+dx, y0+18+dy, 3, 3);

  // hat pixel
  ctx.fillStyle='#ffd27b'; ctx.fillRect(x0+30, y0+8, 3, 3);

  // feet/base (alternate tiny bounce when moving)
  const footOff = moving ? (Math.sin(stepPhase)*1) : 0;
  ctx.fillStyle='#fff';
  ctx.fillRect(x0+10, y0+32 + (footOff>0?1:0), 8, 3);
  ctx.fillRect(x0+22, y0+32 + (footOff<0?1:0), 8, 3);
}
