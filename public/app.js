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
const palette = ['#7e6bf2','#4ba23a','#c46a3a','#5c5c5c','#7c69cc','#d4458c','#e4b737','#2d5fab','#7a3f75','#7b1c28'];
const INFECT_COLOR = '#00c83a';
const FLASH_PURPLE = 'rgba(74, 23, 102, 0.45)';

// ---------- State ----------
let state = {
  you:null, host:false, hostId:null,
  phase:'LOBBY',
  round:0, totalRounds:0,
  players:[], world:{w:1600,h:900},
  countdownEndsAt:null, gameEndsAt:null, boardEndsAt:null,
  powerups:[], slimes:[], walls:[]
};

// ---------- Sections & Refs ----------
const lobby  = el('lobby');  const reveal = el('reveal'); const game = el('game'); const board = el('board');
const avatarCanvas = el('avatarCanvas'); const ac = avatarCanvas?.getContext('2d');
const nameInput = el('nameInput'); const readyChk = el('readyChk'); const playerList = el('playerList'); const startBtn = el('startBtn'); const readyCount = el('readyCount');
const chatLog = el('chatLog'); const chatInput = el('chatInput'); const chatSend = el('chatSend');
const revealAvatar = el('revealAvatar'); const revealTitle  = el('revealTitle'); const revealText   = el('revealText'); const countdown = el('countdown');
const gameCanvas = el('gameCanvas'); const gctx = gameCanvas?.getContext('2d');
const roundText = el('roundText'); const gameTimer = el('gameTimer'); const infectCount = el('infectCount'); const powerHUD = el('powerHUD');
const boardRound = el('boardRound'); const boardRows = el('boardRows'); const boardNext = el('boardNext'); const boardCountdown = el('boardCountdown');
const finalExtras = el('finalExtras'); const boardChatLog = el('boardChatLog'); const boardChatInput = el('boardChatInput'); const boardChatSend = el('boardChatSend'); const playAgainBtn = el('playAgainBtn');

// ---------- Audio / SFX ----------
let actx, unlocked=false;
addEventListener('pointerdown', ()=>{ 
  if(!unlocked){ 
    actx = new (window.AudioContext||window.webkitAudioContext)(); 
    unlocked=true; 
    musicMaybeStart();     // start the correct loop after first tap/click
  } 
}, { once:true });

const beep = (type='click')=>{
  if (!unlocked) return;
  const now = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type='square';
  const tones = { click:660, select:760, ready:520, start:880, tick:440, infect:180, power:980, score:620, error:200 };
  o.frequency.value = tones[type] || 660;
  g.gain.setValueAtTime(.001, now); g.gain.exponentialRampToValueAtTime(.2, now+.01); g.gain.exponentialRampToValueAtTime(.001, now+.12);
  o.connect(g); g.connect(actx.destination); o.start(now); o.stop(now+.13);
};

// ---------- Chiptune mini-engine ----------
class Chip {
  constructor(ctx){ this.ctx=ctx; this.timer=null; this.song=null; this.step=0; this.nextTime=0; this.muted=false; }
  stop(){ if(this.timer){ clearInterval(this.timer); this.timer=null; } this.song=null; }
  play(song){
    if (!this.ctx) return;
    this.stop();
    this.song = song;
    this.step = 0;
    const spb = 60/song.bpm;               // seconds per beat (quarter)
    this.stepDur = spb * (4 / song.div);   // div=16 -> 16th notes
    this.nextTime = this.ctx.currentTime + 0.1;
    const scheduleAhead = 0.25;
    this.timer = setInterval(()=>{
      while(this.nextTime < this.ctx.currentTime + scheduleAhead){
        this.scheduleStep(this.nextTime);
        this.nextTime += this.stepDur;
        this.step++;
      }
    }, 30);
  }
  noteFreq(n){
    if (!n || n==='-' || n==='.' || n==='R') return 0;
    const m = /^([A-G])(#?)(-?\d)$/.exec(n.trim());
    if (!m) return 0;
    const map={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
    const semi = map[m[1]] + (m[2]?1:0);
    const oct = parseInt(m[3],10);
    const midi = semi + (oct+1)*12; // C-1 = 0
    return 440 * Math.pow(2, (midi-69)/12); // A4=440
  }
  env(g,t,peak=0.18,len=0.9){
    const a=t, d=t+0.02, r=t+this.stepDur*len;
    g.gain.setValueAtTime(0.0001,a);
    g.gain.exponentialRampToValueAtTime(peak, a+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, r);
  }
  playPulse(freq,t,vol=0.15){
    if (!freq) return;
    const o=this.ctx.createOscillator(), g=this.ctx.createGain();
    o.type='square'; o.frequency.setValueAtTime(freq,t);
    this.env(g,t,vol,0.85);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t+this.stepDur*0.98);
  }
  playTri(freq,t,vol=0.18){
    if (!freq) return;
    const o=this.ctx.createOscillator(), g=this.ctx.createGain();
    o.type='triangle'; o.frequency.setValueAtTime(freq,t);
    this.env(g,t,vol,0.95);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t+this.stepDur*0.98);
  }
  noiseBuffer(){
    const len=0.1*this.ctx.sampleRate, buf=this.ctx.createBuffer(1,len,this.ctx.sampleRate), d=buf.getChannelData(0);
    for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
    return buf;
  }
  playHat(t){
    const s=this.ctx.createBufferSource(); s.buffer=this.noiseBuffer();
    const bp=this.ctx.createBiquadFilter(); bp.type='highpass'; bp.frequency.value=8000; bp.Q.value=0.7;
    const g=this.ctx.createGain(); this.env(g,t,0.08,0.4);
    s.connect(bp); bp.connect(g); g.connect(this.ctx.destination);
    s.start(t); s.stop(t+0.05);
  }
  playSnare(t){
    const s=this.ctx.createBufferSource(); s.buffer=this.noiseBuffer();
    const bp=this.ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=2000; bp.Q.value=0.7;
    const g=this.ctx.createGain(); this.env(g,t,0.16,0.5);
    s.connect(bp); bp.connect(g); g.connect(this.ctx.destination);
    s.start(t); s.stop(t+0.12);
  }
  playKick(t){
    const o=this.ctx.createOscillator(), g=this.ctx.createGain();
    o.type='triangle';
    o.frequency.setValueAtTime(120,t);
    o.frequency.exponentialRampToValueAtTime(55, t+0.12);
    g.gain.setValueAtTime(0.25,t); g.gain.exponentialRampToValueAtTime(0.0001,t+0.15);
    o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t+0.16);
  }
  scheduleStep(t){
    if (!this.song) return;
    const st = this.step;
    for (const tr of this.song.tracks){
      const pat = tr.pattern, tok = pat[st % pat.length];
      if (tr.type==='pulse'){ this.playPulse(this.noteFreq(tok), t, tr.vol ?? 0.15); }
      else if (tr.type==='triangle'){ this.playTri(this.noteFreq(tok), t, tr.vol ?? 0.18); }
      else if (tr.type==='noise'){
        if (tok==='h') this.playHat(t);
        else if (tok==='s') this.playSnare(t);
      } else if (tr.type==='kick'){
        if (tok==='k') this.playKick(t);
      }
    }
  }
}

// Songs
const lobbySong = {
  bpm: 116, div: 16,
  tracks: [
    // lead (happy bounce)
    { type:'pulse', vol:0.14, pattern:
      ['E5','-','G5','-','C5','-','E5','-','G5','-','B4','-','D5','-','G4','-',
       'E5','-','G5','-','C5','-','E5','-','A5','-','G5','-','E5','-','D5','-'] },
    // counter
    { type:'pulse', vol:0.12, pattern:
      ['C5','-','-','-','D5','-','-','-','E5','-','-','-','G5','-','-','-',
       'A5','-','-','-','G5','-','-','-','E5','-','-','-','D5','-','-','-'] },
    // bass (I–V–vi–IV)
    { type:'triangle', vol:0.22, pattern:
      ['C3','C3','G2','G2','A2','A2','F2','F2','C3','C3','G2','G2','A2','A2','F2','F2'] },
    // drums
    { type:'kick', pattern:['k','.','.','.','k','.','.','.','k','.','.','.','k','.','.','.'] },
    { type:'noise', pattern:['h','.','h','.','s','.','h','.','h','.','h','.','s','.','h','.'] }
  ]
};

const gameSong = {
  bpm: 150, div: 16,
  tracks: [
    // arpeggio lead
    { type:'pulse', vol:0.14, pattern:
      ['C6','-','G5','-','E5','-','C6','-','D6','-','A5','-','F5','-','D6','-',
       'E6','-','B5','-','G5','-','E6','-','F6','-','C6','-','A5','-','F6','-'] },
    // counter stab
    { type:'pulse', vol:0.12, pattern:
      ['-','-','C6','-','-','-','G5','-','-','-','D6','-','-','-','A5','-',
       '-','-','E6','-','-','-','B5','-','-','-','F6','-','-','-','C6','-'] },
    // driving bass
    { type:'triangle', vol:0.22, pattern:
      ['C3','C3','C3','C3','G2','G2','G2','G2','A2','A2','A2','A2','F2','F2','F2','F2'] },
    // drums
    { type:'kick', pattern:['k','.','.','.','k','.','.','.','k','.','.','.','k','.','.','.'] },
    { type:'noise', pattern:['h','h','h','h','s','h','h','h','h','h','h','h','s','h','h','h'] }
  ]
};

// Music control
let chip = null;
let wantSong = 'lobby';    // which song should be playing given phase
let musicMuted = false;

function musicStart(name){
  if (!unlocked) return;                       // will auto-start after first pointer
  if (!actx) actx = new (window.AudioContext||window.webkitAudioContext)();
  if (!chip) chip = new Chip(actx);
  if (musicMuted) return;
  chip.play(name==='game' ? gameSong : lobbySong);
}
function musicStop(){
  if (chip) chip.stop();
}
function musicMaybeStart(){
  musicStop();
  musicStart(wantSong);
}

// Toggle with M
addEventListener('keydown', e=>{
  if ((e.key==='m' || e.key==='M') && !e.repeat){
    musicMuted = !musicMuted;
    if (musicMuted) musicStop(); else musicMaybeStart();
  }
});

// ---------- Avatar preview (matches anatomy) ----------
function drawAvatarPreview(color){
  if (!ac) return; const ctx = ac; const s = 14;
  const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*s,y*s,w*s,h*s); };
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  // hat
  px(6,1,5,2,'#ffd966'); px(10,1,1,1,'#f5a43a');
  // body
  px(6,3,6,7,color);
  // arm nub
  px(12,5,1,2,color);
  // legs + foot
  px(7,10,1,1,color); px(10,10,1,1,color);
  px(6,11,6,1,'#fff');
  // eyes
  px(7,4,2,2,'#fff'); px(10,4,2,2,'#fff'); px(8,5,1,1,'#000'); px(11,5,1,1,'#000');
}

// ---------- Tiny sprite for UI rows ----------
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

// ---------- Movement ----------
const keys = Object.create(null);
const isMovementKey = (k) => (
  k==='ArrowUp' || k==='ArrowDown' || k==='ArrowLeft' || k==='ArrowRight' ||
  k==='w' || k==='a' || k==='s' || k==='d' || k==='W' || k==='A' || k==='S' || k==='D'
);
addEventListener('keydown', e=>{ if (!isMovementKey(e.key)) return; if (state.phase==='GAME') e.preventDefault(); keys[e.key]=true; sendDir(); }, { passive:false });
addEventListener('keyup',   e=>{ if (!isMovementKey(e.key)) return; if (state.phase==='GAME') e.preventDefault(); keys[e.key]=false; sendDir(); }, { passive:false });
addEventListener('blur', ()=>{ for (const k in keys) delete keys[k]; sendDir(); });
document.addEventListener('visibilitychange', ()=>{ if (document.hidden){ for (const k in keys) delete keys[k]; sendDir(); } });

function sendDir(){
  if (state.phase!=='GAME') return;
  const x = (keys['ArrowRight']||keys['d']||keys['D']?1:0) - (keys['ArrowLeft']||keys['a']||keys['A']?1:0);
  const y = (keys['ArrowDown']||keys['s']||keys['S']?1:0) - (keys['ArrowUp']||keys['w']||keys['W']?1:0);
  socket.emit('input', { dir:{ x, y } });
}

// ---------- Space to use power ----------
addEventListener('keydown', e=>{
  if (state.phase!=='GAME') return;
  if ((e.key===' ' || e.code==='Space') && !e.repeat){
    e.preventDefault();
    socket.emit('use_power');
  }
}, { passive:false });

// ---------- Sockets ----------
socket.on('room_joined', ({ you, hostId, host })=>{ state.you=you; state.hostId=hostId||null; state.host=!!host; });

let countdownTimer=null, boardTimer=null;
const stopCountdown=()=>{ if(countdownTimer){ clearInterval(countdownTimer); countdownTimer=null; } };
const stopBoardTimer=()=>{ if(boardTimer){ clearInterval(boardTimer); boardTimer=null; } };

socket.on('room_state', (payload)=>{
  const { hostId, phase, round, totalRounds, players, countdownEndsAt, gameEndsAt, boardEndsAt, board:boardData, world } = payload;

  // music routing by phase
  if (phase==='GAME') { wantSong='game'; musicMaybeStart(); }
  else if (phase==='LOBBY' || phase==='LEADERBOARD' || phase==='COUNTDOWN') { wantSong='lobby'; musicMaybeStart(); }

  state.hostId = hostId || null;
  state.host   = state.you && hostId && (state.you === hostId);
  state.phase=phase; state.round=round; state.totalRounds=totalRounds;
  state.players=players||[]; state.world=world||state.world;
  state.countdownEndsAt=countdownEndsAt||null; state.gameEndsAt=gameEndsAt||null; state.boardEndsAt=boardEndsAt??null;

  // update my avatar preview
  const me = state.players.find(p=>p.id===state.you);
  if (me) drawAvatarPreview(palette[me.avatar|0]);

  showPhaseSections(phase);

  // LOBBY
  if (phase==='LOBBY' && playerList){
    playerList.innerHTML='';
    const readyNum = state.players.filter(p=>p.ready).length;

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
      if (p.id === state.hostId){ const tag=document.createElement('span'); tag.className='tag host'; tag.textContent='HOST'; li.appendChild(tag); }
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
    (payload.board||[]).forEach(row=>{
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
    const me = state.players.find(p=>p.id===state.you);
    const color = palette[(me?.avatar|0) || 0];
    const s = 12, ctx=rctx;
    const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*s,y*s,w*s,h*s); };
    ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
    // hat + body + arm nub + legs + foot + eyes (matches anatomy)
    px(6,1,5,2,'#ffd966'); px(10,1,1,1,'#f5a43a');
    px(6,3,6,7,color); px(12,5,1,2,color);
    px(7,10,1,1,color); px(10,10,1,1,color); px(6,11,6,1,'#fff');
    px(7,4,2,2,'#fff'); px(10,4,2,2,'#fff'); px(8,5,1,1,'#000'); px(11,5,1,1,'#000');
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

// POWER EVENTS (trails/particles)
const flashTrails = []; // {from,to,until}
const sparkles = [];    // {x,y,vx,vy,life,color}
socket.on('power_event', (ev)=>{
  if (!ev) return;
  if (ev.type==='flash'){
    flashTrails.push({ from:ev.from, to:ev.to, until: performance.now()+250 });
  } else if (ev.type==='pickup'){
    for (let i=0;i<10;i++){
      sparkles.push({ x:ev.x, y:ev.y, vx:(Math.random()*2-1)*1.2, vy:(Math.random()*2-1)*1.2, life:240, color:'#ffffff' });
    }
  } else if (ev.type==='slime_place'){
    for (let i=0;i<10;i++){
      sparkles.push({ x:ev.rect.x+Math.random()*ev.rect.w, y:ev.rect.y+Math.random()*ev.rect.h, vx:0, vy:0, life:180, color:'rgba(0,255,80,0.6)' });
    }
  }
});

socket.on('error_message', (m)=>{ console.warn('[server]', m); beep('error'); });

// ---------- Game drawing ----------
const lastPos = new Map(); let animTime=0, stepPhase=0;
let infectionFlashUntil = 0;

addEventListener('keydown', e=>{ if(state.phase==='GAME' && (e.key===' '||e.code==='Space')){ e.preventDefault(); } }, { passive:false });

socket.on('game_state', ({ phase, positions, round, totalRounds, gameEndsAt, powerups, slimes, walls })=>{
  if (phase!=='GAME' || !gctx) return;

  if (roundText) roundText.textContent = `Round ${round} of ${totalRounds}`;
  const ms=Math.max(0,(gameEndsAt||Date.now())-Date.now());
  if (gameTimer) gameTimer.textContent = Math.ceil(ms/1000).toString();
  if (infectCount) infectCount.textContent = positions.filter(p=>p.infected).length.toString();

  state.powerups = powerups || [];
  state.slimes = slimes || [];
  state.walls = walls || [];

  // HUD power text
  const me = positions.find(p=>p.id===state.you);
  if (powerHUD){
    if (me){
      const activeSecs = (me.speedUntil && me.speedUntil > Date.now()) ? Math.ceil((me.speedUntil - Date.now())/1000) : 0;
      const { flash=0, slime=0, speed=0 } = me.inv || {};
      let label = '';
      if (activeSecs) label = `Power: SPEED (${activeSecs}s)` + (speed?` +x${speed}`:'');
      else if (speed>0) label = `Power: SPEED x${speed} — press Space`;
      else if (flash>0) label = `Power: FLASH x${flash} — press Space`;
      else if (slime>0) label = `Power: SLIME x${slime} — press Space`;
      powerHUD.textContent = label;
    } else powerHUD.textContent = '';
  }

  drawGame(positions, state.powerups, state.slimes, state.walls);
});

function drawGame(positions, powerups, slimes, walls){
  const w=state.world.w, h=state.world.h;
  gctx.clearRect(0,0,w,h);

  // frame
  gctx.strokeStyle='#fff'; gctx.lineWidth=2; gctx.strokeRect(6,6,w-12,h-12);

  // timing
  const now=performance.now(); const dt=(now-animTime)||16; animTime=now; stepPhase += dt*0.02;

  // walls
  gctx.strokeStyle='#fff'; gctx.lineWidth=3;
  walls.forEach(r=>{ gctx.strokeRect(r.x, r.y, r.w, r.h); });

  // slimes (chunky tiles)
  slimes.forEach(s=>{
    const tile = 10;
    for (let y=s.y; y<=s.y+s.h-1; y+=tile){
      for (let x=s.x; x<=s.x+s.w-1; x+=tile){
        gctx.fillStyle = Math.random()<0.5 ? 'rgba(0,128,0,0.25)' : 'rgba(0,255,0,0.18)';
        gctx.fillRect(Math.floor(x), Math.floor(y), tile, tile);
      }
    }
    gctx.strokeStyle='rgba(0,255,0,0.28)'; gctx.strokeRect(s.x, s.y, s.w, s.h);
  });

  // powerups
  powerups.forEach(pu=> drawPowerIcon(pu.type, Math.round(pu.x), Math.round(pu.y)));

  // flash trails
  for (let i=flashTrails.length-1;i>=0;i--){
    const t = flashTrails[i];
    const life = (t.until - now)/250;
    if (life <= 0){ flashTrails.splice(i,1); continue; }
    gctx.save();
    gctx.globalAlpha = Math.max(0, life);
    gctx.fillStyle = FLASH_PURPLE;
    const steps = 12;
    for (let s=0;s<steps;s++){
      const px = t.from.x + (t.to.x - t.from.x) * (s/steps);
      const py = t.from.y + (t.to.y - t.from.y) * (s/steps);
      gctx.fillRect(Math.round(px-8), Math.round(py-6), 16, 12);
    }
    gctx.fillStyle = 'rgba(255,255,255,0.07)';
    gctx.fillRect(Math.round(t.from.x-10), Math.round(t.from.y-14), 20, 28);
    gctx.restore();
  }

  const infected = positions.filter(p=>p.infected);
  const healthy  = positions.filter(p=>!p.infected);

  positions.forEach(p=>{
    const last=lastPos.get(p.id)||{x:p.x,y:p.y,infected:p.infected};
    const moving=(Math.hypot(p.x-last.x,p.y-last.y)>0.5);

    if (!last.infected && p.infected){ infectionFlashUntil = now+280; }
    lastPos.set(p.id,{x:p.x,y:p.y,infected:p.infected});

    // eye target
    let tx=p.x, ty=p.y-14;
    const pool = p.infected ? healthy : infected;
    if (pool.length){
      let best=null, d2=1e9;
      for (const o of pool){ const dx=o.x-p.x, dy=o.y-p.y, dd=dx*dx+dy*dy; if(dd<d2){ d2=dd; best=o; } }
      if (best){ tx=best.x; ty=best.y; }
    }

    const baseColor = p.infected ? INFECT_COLOR : palette[p.avatar||0];
    drawCharacter(gctx, p.x, p.y, baseColor, p.infected, moving, tx, ty);

    if (p.id===state.you){
      gctx.fillStyle='#bbb'; gctx.font='12px ui-monospace, monospace'; gctx.textAlign='center';
      gctx.fillText('you', Math.round(p.x), Math.round(p.y)+38);
    }
  });

  // sparkles
  for (let i=sparkles.length-1;i>=0;i--){
    const sp = sparkles[i]; sp.life -= dt; sp.x+=sp.vx; sp.y+=sp.vy;
    gctx.fillStyle = sp.color || '#fff';
    gctx.fillRect(sp.x, sp.y, 2, 2);
    if (sp.life<=0) sparkles.splice(i,1);
  }

  // infection flash overlay
  if (infectionFlashUntil > now){
    const a = Math.max(0, (infectionFlashUntil-now)/280) * 0.35;
    gctx.fillStyle = `rgba(0,255,80,${a})`;
    gctx.fillRect(0,0,w,h);
  }
}

// Icons
function drawPowerIcon(type, x, y){
  gctx.imageSmoothingEnabled = false;
  if (type==='flash'){ // BLUE teleport card
    gctx.fillStyle = '#06141c'; gctx.fillRect(x-16, y-22, 32, 44);
    gctx.fillStyle = '#54b8ff'; gctx.fillRect(x-4, y-16, 8, 32);
    gctx.fillRect(x-12, y-8, 8, 16); gctx.fillRect(x+4, y-8, 8, 16);
    gctx.fillStyle = '#aee0ff'; gctx.fillRect(x-2, y-6, 4, 12);
  } else if (type==='speed'){ // YELLOW lightning card
    gctx.fillStyle = '#1b1609'; gctx.fillRect(x-16, y-22, 32, 44);
    gctx.fillStyle = '#ffc53d';
    gctx.fillRect(x-4, y-16, 8, 8); gctx.fillRect(x-12, y-8, 16, 8);
    gctx.fillRect(x-4, y, 8, 8); gctx.fillRect(x+4, y-20, 8, 8); gctx.fillRect(x-12, y+12, 8, 8);
    gctx.fillStyle = '#ff8c3a'; gctx.fillRect(x+8, y-20, 6, 6); gctx.fillRect(x-12, y+12, 6, 6);
  } else { // SLIME card
    gctx.fillStyle = '#0a210a'; gctx.fillRect(x-16, y-22, 32, 44);
    [['#2bbd3a',-6,-12],['#2bbd3a',-10,-4],['#2bbd3a',-2,-4],['#2bbd3a',+4,-12],['#2bbd3a',-2,+4]]
      .forEach(([c,dx,dy])=>{ gctx.fillStyle=c; gctx.fillRect(x+dx, y+dy, 8, 8); });
  }
}

// Character per anatomy
function drawCharacter(ctx, cx, cy, color, infected, moving, tx, ty){
  const x0 = Math.round(cx) - 18;
  const y0 = Math.round(cy) - 18;
  ctx.imageSmoothingEnabled = false;

  // HAT
  ctx.fillStyle='#ffd966'; ctx.fillRect(x0+16, y0+6, 20, 6);
  ctx.fillStyle='#f5a43a'; ctx.fillRect(x0+34, y0+6, 4, 4);

  // BODY
  ctx.fillStyle=color; ctx.fillRect(x0+16, y0+12, 24, 28);

  // ARM
  ctx.fillStyle=color;
  if (infected){
    // straight-out
    ctx.fillRect(x0+40, y0+18, 8, 4);
  } else {
    const amp = moving ? 4 : 1;
    const yo = y0+24 + Math.round(Math.sin(performance.now()*0.01)*amp);
    ctx.fillRect(x0+42, yo, 6, 4);
  }

  // LEG hints + FOOT
  ctx.fillStyle=color; ctx.fillRect(x0+22, y0+40, 4, 4); ctx.fillRect(x0+32, y0+40, 4, 4);
  ctx.fillStyle='#fff'; ctx.fillRect(x0+16, y0+44, 24, 4);

  // EYES
  ctx.fillStyle='#fff'; ctx.fillRect(x0+22, y0+18, 8, 8); ctx.fillRect(x0+32, y0+18, 8, 8);
  const dx = Math.max(-2, Math.min(2, Math.round((tx - cx)/18)));
  const dy = Math.max(-2, Math.min(2, Math.round((ty - cy)/18)));
  ctx.fillStyle='#000'; ctx.fillRect(x0+25+dx, y0+21+dy, 3, 3); ctx.fillRect(x0+35+dx, y0+21+dy, 3, 3);
}
