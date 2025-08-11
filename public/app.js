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

// ---------- Palette (indexes known by server) ----------
const palette = ['#2d3e50','#365e2b','#6f3d20','#2b2b2b','#6b59b1','#d4458c','#e4b737','#2d5fab','#7a3f75','#7b1c28'];
const INFECT_COLOR = '#00c83a';

// ---------- State ----------
let state = { you:null, host:false, phase:'LOBBY', round:0, totalRounds:0, players:[], world:{w:1600,h:900}, countdownEndsAt:null, gameEndsAt:null, boardEndsAt:null };

// ---------- Sections & Refs ----------
const appEl = el('app');
const lobby  = el('lobby');
const reveal = el('reveal');
const game   = el('game');
const board  = el('board');

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

const revealAvatar = el('revealAvatar');
const revealTitle  = el('revealTitle');
const revealText   = el('revealText');
const countdown    = el('countdown');

const gameCanvas = el('gameCanvas'); const gctx = gameCanvas?.getContext('2d');
const roundText = el('roundText'); const gameTimer = el('gameTimer'); const infectCount = el('infectCount');

const boardRound = el('boardRound'); const boardRows = el('boardRows');
const boardNext = el('boardNext'); const boardCountdown = el('boardCountdown');
const finalExtras = el('finalExtras'); const boardChatLog = el('boardChatLog'); const boardChatInput = el('boardChatInput'); const boardChatSend = el('boardChatSend'); const playAgainBtn = el('playAgainBtn');

// ---------- Audio ----------
let actx, unlocked=false;
addEventListener('pointerdown', ()=>{ if(!unlocked){ actx = new (window.AudioContext||window.webkitAudioContext)(); unlocked=true; } }, { once:true });
const beep = (type='click')=>{
  if (!unlocked) return; const now = actx.currentTime;
  const o = actx.createOscillator(); const g = actx.createGain(); o.type='square';
  const tones = { click:660, select:760, ready:520, start:880, tick:440, infect:180, score:620, error:200 };
  o.frequency.value = tones[type] || 660;
  g.gain.setValueAtTime(.001, now); g.gain.exponentialRampToValueAtTime(.2, now+.01); g.gain.exponentialRampToValueAtTime(.001, now+.12);
  o.connect(g); g.connect(actx.destination); o.start(now); o.stop(now+.13);
};

// ---------- Avatar (two big eyes) ----------
let selectedAvatar = 5;
function drawAvatar(ctx, color, scale){
  const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*scale,y*scale,w*scale,h*scale); };
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  px(2,2,7,6,color);          // bigger body
  px(2,8,7,1,'#fff');         // feet/base
  px(3,4,2,2,'#fff'); px(6,4,2,2,'#fff'); // eyes
  px(4,5,1,1,'#000'); px(7,5,1,1,'#000'); // pupils
  px(9,3,1,1,'#ffd27b');      // hat pixel
}
if (ac) drawAvatar(ac, palette[selectedAvatar], 14);

function renderPalette(){
  if (!avatarRow) return;
  avatarRow.innerHTML = '';
  const usedByOthers = new Set(state.players.filter(p=>p.id!==state.you).map(p=>p.avatar|0));
  palette.forEach((c, i)=>{
    const b = document.createElement('button');
    b.className = 'avatar' + (i===selectedAvatar ? ' is-selected' : '');
    b.style.background = c;
    if (usedByOthers.has(i)) b.setAttribute('disabled','');
    b.onclick = ()=>{
      if (usedByOthers.has(i)) { beep('error'); return; }
      selectedAvatar = i;
      if (ac) drawAvatar(ac, palette[selectedAvatar], 14);
      socket.emit('set_avatar', { avatar: selectedAvatar });
      beep('select');
      // update highlight
      renderPalette();
    };
    avatarRow.appendChild(b);
  });
}

// ---------- Lobby input ----------
nameInput?.addEventListener('change', ()=>{ socket.emit('set_name', { name: nameInput.value.trim() }); beep('click'); });
readyChk?.addEventListener('change', ()=>{ socket.emit('set_ready', { ready: readyChk.checked }); beep('ready'); });
chatSend?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') sendChat(); });
function sendChat(){ const t=chatInput.value.trim(); if(!t) return; socket.emit('chat', { message:t }); chatInput.value=''; beep('click'); }

boardChatSend?.addEventListener('click', sendBoardChat);
boardChatInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') sendBoardChat(); });
function sendBoardChat(){ const t=boardChatInput.value.trim(); if(!t) return; socket.emit('chat', { message:t }); boardChatInput.value=''; beep('click'); }

startBtn?.addEventListener('click', ()=>{ socket.emit('start_game'); beep('start'); });
playAgainBtn?.addEventListener('click', ()=>{ socket.emit('restart_series'); beep('start'); });

// ---------- Movement ----------
const keys={};
addEventListener('keydown', e=>{ keys[e.key]=true; sendDir(); });
addEventListener('keyup',   e=>{ keys[e.key]=false; sendDir(); });
function sendDir(){
  if (state.phase!=='GAME') return;
  const x=(keys['ArrowRight']||keys['d']||keys['D']?1:0)-(keys['ArrowLeft']||keys['a']||keys['A']?1:0);
  const y=(keys['ArrowDown']||keys['s']||keys['S']?1:0)-(keys['ArrowUp']||keys['w']||keys['W']?1:0);
  socket.emit('input', { dir:{x,y} });
}

// ---------- Sockets ----------
socket.on('room_joined', ({ you, host })=>{ state.you=you; state.host=!!host; });

let countdownTimer=null, boardTimer=null;
function stopCountdown(){ if(countdownTimer){ clearInterval(countdownTimer); countdownTimer=null; } }
function stopBoardTimer(){ if(boardTimer){ clearInterval(boardTimer); boardTimer=null; } }

socket.on('room_state', (payload)=>{
  const { phase, round, totalRounds, players, countdownEndsAt, gameEndsAt, boardEndsAt, board:boardData, world } = payload;

  state.phase=phase; state.round=round; state.totalRounds=totalRounds;
  state.players=players||[]; state.world=world||state.world;
  state.countdownEndsAt=countdownEndsAt||null; state.gameEndsAt=gameEndsAt||null; state.boardEndsAt=boardEndsAt??null;

  // set your selected avatar from server (in case auto-assigned)
  const me = state.players.find(p=>p.id===state.you);
  if (me && selectedAvatar!== (me.avatar|0)){ selectedAvatar = me.avatar|0; if (ac) drawAvatar(ac, palette[selectedAvatar], 14); }

  // sections + fullscreen
  showPhaseSections(phase);

  // LOBBY
  if (phase==='LOBBY' && playerList){
    // palette row (apply "used" + selected outline)
    renderPalette();

    playerList.innerHTML='';
    const readyNum = state.players.filter(p=>p.ready).length;
    if (readyCount) readyCount.textContent = `${readyNum}/${state.players.length} players ready`;
    if (startBtn) startBtn.disabled = !(state.host && state.players.length>=3 && readyNum===state.players.length);
    state.players.forEach(p=>{
      const li=document.createElement('li');
      li.innerHTML=`<span class="dot" style="background:${palette[p.avatar||0]}"></span> ${p.name} ${p.id===state.you?'<span class="muted">(you)</span>':''} ${p.id===state.you&&state.host?'<span class="tag host">HOST</span>':''} ${p.ready?'<span class="ok">READY</span>':''}`;
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
      div.innerHTML=`
        <div><span class="dot" style="background:${palette[row.avatar||0]}"></span> ${row.name}</div>
        <div class="t-right">${row.survSec}</div>
        <div class="t-right">${row.infections}</div>
        <div class="t-right">${row.bonus}</div>
        <div class="t-right">${row.roundScore}</div>
        <div class="t-right">${row.total}</div>`;
      boardRows.appendChild(div);
    });

    // Between rounds shows countdown; final shows chat + play again
    stopBoardTimer();
    const isFinal = !state.boardEndsAt;
    if (isFinal){
      if (finalExtras) finalExtras.classList.remove('hidden');
      if (boardNext) boardNext.classList.add('hidden');
    } else {
      if (finalExtras) finalExtras.classList.add('hidden');
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
  if (rctx) drawAvatar(rctx, palette[selectedAvatar], 12);
  if (revealTitle && revealText){
    if (role==='PATIENT_ZERO'){ revealTitle.textContent='You are patient Zero.'; revealText.textContent='Try and get close to players to infect them.'; }
    else { revealTitle.textContent='You are a citizen.'; revealText.textContent='Stay away from infected players.'; }
  }
});

socket.on('chat_message', ({ from, text })=>{
  // mirror chat to lobby and board logs if visible
  if (chatLog){ const d=document.createElement('div'); d.textContent=`${from}: ${text}`; chatLog.appendChild(d); chatLog.scrollTop=chatLog.scrollHeight; }
  if (boardChatLog){ const d=document.createElement('div'); d.textContent=`${from}: ${text}`; boardChatLog.appendChild(d); boardChatLog.scrollTop=boardChatLog.scrollHeight; }
});

socket.on('error_message', (m)=>{ console.warn('[server]', m); beep('error'); });

// ---------- Game drawing ----------
const lastPos = new Map(); let animTime=0;

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
  const now=performance.now(); const dt=(now-animTime)||16; animTime=now;

  // split
  const infected = positions.filter(p=>p.infected);
  const healthy  = positions.filter(p=>!p.infected);

  positions.forEach(p=>{
    // infected proximity square (kept subtle)
    if (p.infected){ gctx.fillStyle='rgba(0,255,0,0.08)'; gctx.fillRect(p.x-36,p.y-36,72,72); gctx.strokeStyle='rgba(0,255,0,0.25)'; gctx.strokeRect(p.x-36,p.y-36,72,72); }

    const last=lastPos.get(p.id)||{x:p.x,y:p.y};
    const moving=(Math.hypot(p.x-last.x,p.y-last.y)>0.5);
    lastPos.set(p.id,{x:p.x,y:p.y});

    // eye target
    let tx=p.x, ty=p.y-12;
    const pool = p.infected ? healthy : infected;
    if (pool.length){
      let best=null, d2=1e9;
      for (const o of pool){ const dx=o.x-p.x, dy=o.y-p.y, dd=dx*dx+dy*dy; if(dd<d2){ d2=dd; best=o; } }
      if (best){ tx=best.x; ty=best.y; }
    }

    const baseColor = p.infected ? INFECT_COLOR : palette[p.avatar||0];
    drawMiniSprite(gctx, p.x, p.y, baseColor, moving, dt, tx, ty);

    if (p.id===state.you){
      gctx.fillStyle='#bbb'; gctx.font='12px ui-monospace, monospace'; gctx.textAlign='center';
      gctx.fillText('you', Math.round(p.x), Math.round(p.y)+34);
    }
  });
}

// bigger sprite (about 32px), pupils track target, feet alternate
let stepPhase=0;
function drawMiniSprite(ctx, cx, cy, color, moving, dt, tx, ty){
  stepPhase += (moving ? dt*0.02 : dt*0.006);
  const footOff = moving ? (Math.sin(stepPhase)*1) : 0;

  const x0 = Math.round(cx) - 16;
  const y0 = Math.round(cy) - 16;

  ctx.imageSmoothingEnabled = false;

  // body (bigger)
  ctx.fillStyle=color; ctx.fillRect(x0+6, y0+6, 20, 20);

  // eyes (white rectangles 5x5)
  ctx.fillStyle='#fff'; ctx.fillRect(x0+9, y0+10, 5, 5); ctx.fillRect(x0+18, y0+10, 5, 5);

  // pupils offset toward target (max 1px)
  const dx = Math.max(-1, Math.min(1, Math.round((tx - cx)/24)));
  const dy = Math.max(-1, Math.min(1, Math.round((ty - cy)/24)));
  ctx.fillStyle='#000'; ctx.fillRect(x0+11+dx, y0+12+dy, 3, 3); ctx.fillRect(x0+20+dx, y0+12+dy, 3, 3);

  // hat pixel
  ctx.fillStyle='#ffd27b'; ctx.fillRect(x0+26, y0+6, 3, 3);

  // feet/base (alternate)
  ctx.fillStyle='#fff';
  ctx.fillRect(x0+8,  y0+26 + (footOff>0?1:0), 8, 3);
  ctx.fillRect(x0+18, y0+26 + (footOff<0?1:0), 8, 3);
}
