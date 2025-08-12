// Outbreak client — Pixel Lobby with IMAGE-BASED PARALLAX + full game UI

/* ============================== DOM REFS ============================== */
const el = (id) => document.getElementById(id);

const lobbyEl = el('lobby');
const reveal  = el('reveal');
const game    = el('game');
const board   = el('board');

const lobbyCanvas = el('lobbyCanvas');
const lctx = lobbyCanvas.getContext('2d', { alpha: true });

const gameCanvas = el('gameCanvas');
const gctx = gameCanvas?.getContext('2d');

const nameInput = el('nameInput');
const readyChk  = el('readyChk');
const startBtn  = el('startBtn');
const readyCount= el('readyCount');

const chatInput = el('chatInput');
const chatSend  = el('chatSend');

const boardChatInput = el('boardChatInput');
const boardChatSend  = el('boardChatSend');
const boardChatLog   = el('boardChatLog');

const avatarCanvas = el('avatarCanvas');
const ac = avatarCanvas?.getContext('2d');

const revealAvatar = el('revealAvatar');
const revealTitle  = el('revealTitle');
const revealText   = el('revealText');
const countdownEl  = el('countdown');

const muteBtn = el('muteBtn');

const roundText   = el('roundText');
const gameTimer   = el('gameTimer');
const infectCount = el('infectCount');
const powerHUD    = el('powerHUD');

const boardRound     = el('boardRound');
const boardRows      = el('boardRows');
const boardNext      = el('boardNext');
const boardCountdown = el('boardCountdown');
const finalExtras    = el('finalExtras');
const playAgainBtn   = el('playAgainBtn');

/* ============================== SOCKET.IO ============================= */
const socket = io();

/* ============================== THEME ================================= */
const palette = [
  '#7e6bf2','#4ba23a','#c46a3a','#5c5c5c','#7c69cc',
  '#d4458c','#e4b737','#2d5fab','#7a3f75','#7b1c28'
];
const INFECT_COLOR = '#00c83a';
const FLASH_PURPLE = 'rgba(74, 23, 102, 0.45)';

/* ============================== STATE ================================= */
let state = {
  you: null, host: false, hostId: null,
  phase: 'LOBBY',
  players: [],
  world: { w: 1600, h: 900 },

  // lobby
  lobbyWorld: { w: 3840, h: 540, groundY: 420 },
  lobbyPlayers: [],
  bubbles: new Map(), // id -> { text, until, name, avatar }

  // gameplay overlays
  powerups: [], slimes: [], walls: []
};

function showPhaseSections(phase){
  lobbyEl.classList.toggle('hidden', phase!=='LOBBY');
  reveal .classList.toggle('hidden', phase!=='COUNTDOWN');
  game   .classList.toggle('hidden', phase!=='GAME');
  board  .classList.toggle('hidden', phase!=='LEADERBOARD');
  document.body.classList.toggle('fullscreen', phase==='GAME');
}

/* ============================== AUDIO ================================= */
let actx, musicUnlocked=false, musicMuted=false, wantSong='lobby';

const music = new (class {
  constructor(){ this.ctx=null; this.buffers={}; this.master=null; this.playing=null; }
  async unlock(){
    if (this.ctx) return;
    this.ctx = actx || new (window.AudioContext||window.webkitAudioContext)();
    actx = this.ctx;
    this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
    await this._load('lobby','/audio/lobby_option_A.wav');
    await this._load('game','/audio/game_option_A.wav');
  }
  async _load(name,url){
    const ab = await fetch(url).then(r=>r.arrayBuffer());
    this.buffers[name] = await this.ctx.decodeAudioData(ab);
  }
  play(name){
    if (musicMuted || !this.ctx) return;
    const buf = this.buffers[name]; if(!buf) return;
    const now=this.ctx.currentTime, fade=0.6;
    const src=this.ctx.createBufferSource(); src.buffer=buf; src.loop=true;
    const g=this.ctx.createGain(); g.gain.setValueAtTime(0, now);
    src.connect(g); g.connect(this.master); src.start(now);
    g.gain.linearRampToValueAtTime(0.9, now+fade);
    if (this.playing){
      const old=this.playing; old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now+fade);
      setTimeout(()=>{ try{old.src.stop();}catch{}; }, fade*1000+40);
    }
    this.playing = { name, src, gain:g };
  }
  stop(){
    if (!this.playing || !this.ctx) return;
    const now=this.ctx.currentTime;
    this.playing.gain.gain.linearRampToValueAtTime(0, now+0.25);
    const s=this.playing.src; setTimeout(()=>{ try{s.stop();}catch{}; }, 320);
    this.playing=null;
  }
})();

window.addEventListener('pointerdown', async ()=>{
  if (musicUnlocked) return;
  musicUnlocked = true;
  actx = new (window.AudioContext||window.webkitAudioContext)();
  await music.unlock();
  music.play(wantSong);
}, { once:true });

muteBtn?.addEventListener('click', ()=>{
  musicMuted = !musicMuted;
  muteBtn.textContent = musicMuted ? 'Unmute' : 'Mute';
  if (musicMuted) music.stop(); else music.play(wantSong);
});

function musicMaybeStart(){
  if (!musicUnlocked || musicMuted) return;
  music.play(wantSong);
}

// 8-bit UI beeps
function beep(type='click'){
  if (!musicUnlocked || !actx) return;
  const now = actx.currentTime;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = 'square';
  const tones = { click:660, select:760, ready:520, start:880, tick:440, infect:180, power:980, score:620, error:200 };
  o.frequency.value = tones[type] || 660;
  g.gain.setValueAtTime(.001, now);
  g.gain.exponentialRampToValueAtTime(.2, now+.01);
  g.gain.exponentialRampToValueAtTime(.001, now+.12);
  o.connect(g); g.connect(actx.destination); o.start(now); o.stop(now+.13);
}

/* ============================== INPUTS ================================ */
nameInput?.addEventListener('change', ()=> socket.emit('set_name', { name: nameInput.value.trim() }));
readyChk ?.addEventListener('change', ()=> socket.emit('set_ready', { ready: readyChk.checked }));
chatSend ?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') sendChat(); });
function sendChat(){ const t=chatInput.value.trim(); if(!t) return; socket.emit('chat', { message:t }); chatInput.value=''; }

/* lobby movement */
const keys = Object.create(null);
const inputTargetOK = (e)=>!/(INPUT|TEXTAREA|BUTTON)/i.test((e.target?.tagName)||'');
addEventListener('keydown', (e)=>{ if(!inputTargetOK(e)) return;
  if (e.key==='ArrowLeft'||e.key==='a'||e.key==='A') keys.left=true;
  if (e.key==='ArrowRight'||e.key==='d'||e.key==='D') keys.right=true;
  if (state.phase==='LOBBY' && (e.key===' '||e.key==='w'||e.key==='W'||e.key==='ArrowUp')) { keys.jump=true; e.preventDefault(); }
});
addEventListener('keyup', (e)=>{ if(!inputTargetOK(e)) return;
  if (e.key==='ArrowLeft'||e.key==='a'||e.key==='A') keys.left=false;
  if (e.key==='ArrowRight'||e.key==='d'||e.key==='D') keys.right=false;
});
setInterval(()=>{ if(state.phase!=='LOBBY') return;
  socket.emit('lobby_input', { left:!!keys.left, right:!!keys.right, jump:!!keys.jump });
  keys.jump=false;
}, 50);

startBtn?.addEventListener('click', ()=>{ socket.emit('start_game'); beep('start'); });
playAgainBtn?.addEventListener('click', ()=>{ socket.emit('restart_series'); beep('start'); });

/* ============================== SOCKETS ============================== */
socket.on('room_joined', ({ you, hostId, host })=>{
  state.you=you; state.hostId=hostId||null; state.host=!!host;
});

let countdownTimer=null, boardTimer=null;
const stopCountdown = ()=>{ if (countdownTimer) { clearInterval(countdownTimer); countdownTimer=null; } };
const stopBoardTimer= ()=>{ if (boardTimer) { clearInterval(boardTimer); boardTimer=null; } };

socket.on('room_state', (payload)=>{
  const { hostId, phase, players, world } = payload;

  // music
  if (phase==='GAME') { wantSong='game'; musicMaybeStart(); }
  else { wantSong='lobby'; musicMaybeStart(); }

  state.hostId = hostId || null;
  state.host   = state.you && hostId && (state.you === hostId);
  state.phase  = phase;
  state.players= players || [];
  state.world  = world || state.world;

  const me = state.players.find(p=>p.id===state.you);
  if (me) drawAvatarPreview(palette[me.avatar|0]);

  showPhaseSections(phase);

  // lobby UI bits
  if (phase==='LOBBY' && readyCount){
    const readyNum = state.players.filter(p=>p.ready).length;
    readyCount.textContent = `${readyNum}/${state.players.length} players ready`;
    startBtn.classList.toggle('hidden', !state.host);
    startBtn.disabled = !(state.host && state.players.length>=3 && readyNum===state.players.length);
  }

  // countdown view
  if (phase==='COUNTDOWN'){
    stopCountdown();
    const until = payload.countdownEndsAt || Date.now();
    const tick = ()=>{ const s = Math.max(0, Math.ceil((until - Date.now())/1000)); countdownEl.textContent = s+'s'; if(s<=3) beep('tick'); };
    tick(); countdownTimer=setInterval(tick, 200);
  } else stopCountdown();

  // leaderboard view
  if (phase==='LEADERBOARD'){
    stopBoardTimer();
    if (boardRound) boardRound.textContent = `Round ${payload.round} of ${payload.totalRounds}`;
    boardRows.innerHTML='';
    (payload.board||[]).forEach(row=>{
      const div=document.createElement('div'); div.className='trow';
      const namecell=document.createElement('div'); namecell.className='namecell';
      const img=document.createElement('img'); img.className='picon'; img.src=makeThumb(palette[row.avatar||0]); namecell.appendChild(img);
      const span=document.createElement('span'); span.textContent=row.name; namecell.appendChild(span);
      div.appendChild(namecell);
      div.innerHTML += `
        <div class="t-right">${row.survSec}</div>
        <div class="t-right">${row.infections}</div>
        <div class="t-right">${row.bonus}</div>
        <div class="t-right">${row.roundScore}</div>
        <div class="t-right">${row.total}</div>`;
      boardRows.appendChild(div);
    });

    const isFinal = !payload.boardEndsAt;
    if (isFinal){
      finalExtras?.classList.remove('hidden');
      boardNext?.classList.add('hidden');
    } else {
      finalExtras?.classList.add('hidden');
      boardNext?.classList.remove('hidden');
      const until = payload.boardEndsAt;
      const tick = ()=>{ const s = Math.max(0, Math.ceil((until - Date.now())/1000)); boardCountdown.textContent = s+'s'; };
      tick(); boardTimer=setInterval(tick, 200);
    }
    beep('score');
  }
});

socket.on('lobby_state', ({ players, world })=>{
  state.lobbyPlayers = players || [];
  if (world) state.lobbyWorld = world;
});

socket.on('chat_message', ({ from, avatar, id, text })=>{
  state.bubbles.set(id, { text, until: Date.now()+6000, name: from, avatar });
  // also echo into leaderboard chat if visible
  if (boardChatLog){
    const row = document.createElement('div'); row.className='rowline';
    const img = document.createElement('img'); img.src = makeThumb(palette[avatar||0]); img.alt=''; row.appendChild(img);
    const span = document.createElement('span'); span.textContent = `${from}: ${text}`; row.appendChild(span);
    boardChatLog.appendChild(row); boardChatLog.scrollTop = boardChatLog.scrollHeight;
  }
});

socket.on('role', ({ role })=>{
  const rctx = revealAvatar?.getContext('2d'); const s=12;
  const me = state.players.find(p=>p.id===state.you);
  const color = palette[(me?.avatar|0)||0];
  if (rctx){
    rctx.imageSmoothingEnabled=false; rctx.clearRect(0,0,revealAvatar.width,revealAvatar.height);
    const px=(x,y,w,h,c)=>{ rctx.fillStyle=c; rctx.fillRect(x*s,y*s,w*s,h*s); };
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

/* ======================= AVATAR PREVIEW & THUMBS ====================== */
function drawAvatarPreview(color){
  if (!ac) return; const ctx = ac; const s=7;
  const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*s,y*s,w*s,h*s); };
  ctx.clearRect(0,0,ac.width,ac.height);
  // hat
  px(6,1,5,2,'#ffd966'); px(10,1,1,1,'#f5a43a');
  // body + arm nub
  px(6,3,6,7,color); px(12,5,1,2,color);
  // legs + foot
  px(7,10,1,1,color); px(10,10,1,1,color); px(6,11,6,1,'#fff');
  // eyes
  px(7,4,2,2,'#fff'); px(10,4,2,2,'#fff'); px(8,5,1,1,'#000'); px(11,5,1,1,'#000');
}

const thumbCache = new Map();
function makeThumb(color){
  if (thumbCache.has(color)) return thumbCache.get(color);
  const c=document.createElement('canvas'); c.width=18; c.height=18; const x=c.getContext('2d'); x.imageSmoothingEnabled=false;
  x.fillStyle=color; x.fillRect(4,4,10,10);
  x.fillStyle='#fff'; x.fillRect(6,7,3,3); x.fillRect(11,7,3,3);
  x.fillStyle='#000'; x.fillRect(7,8,1,1); x.fillRect(12,8,1,1);
  const url = c.toDataURL(); thumbCache.set(color, url); return url;
}

/* ====================== LOBBY: IMAGE PARALLAX ======================== */
const LOBBY_IMG_PATH = '/img/lobby/v2/';
function loadLayer(src){ const i=new Image(); i.src = LOBBY_IMG_PATH+src; i.decoding='async'; i.loading='eager'; return i; }

const layers = [
  { img: loadLayer('00_sky.png'),   speed: 0.00 },
  { img: loadLayer('10_far.png'),   speed: 0.20 },
  { img: loadLayer('20_mid.png'),   speed: 0.40 },
  { img: loadLayer('30_near.png'),  speed: 0.62 },
  { img: loadLayer('40_street.png'),speed: 0.88 },
  { img: loadLayer('50_fog.png'),   speed: 0.10 } // fog drifts slowly
];

let camX = 0;

function drawLayerTiled(ctx, layer, camX){
  const img = layer.img; if (!img || !img.complete) return;
  // scale to fit height, keep pixel-crisp
  const s = Math.min(ctx.canvas.height / img.height, 1); // never upscale beyond 1 for crispness
  const sw = Math.floor(img.width * s);
  const sh = Math.floor(img.height * s);

  // if canvas is taller than source (rare), allow slight up-scale
  const scale = ctx.canvas.height > sh ? (ctx.canvas.height / img.height) : s;
  const w = Math.ceil(img.width * scale);
  const h = Math.ceil(img.height * scale);

  const scroll = camX * layer.speed;
  let x = -Math.floor(scroll % w);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  while (x < ctx.canvas.width){
    ctx.drawImage(img, 0, 0, img.width, img.height, x, 0, w, h);
    x += w;
  }
  ctx.restore();
}

function drawLobby(){
  // canvas size to CSS box
  const rect = lobbyCanvas.getBoundingClientRect();
  if (lobbyCanvas.width !== Math.floor(rect.width) || lobbyCanvas.height !== Math.floor(rect.height)){
    lobbyCanvas.width = Math.floor(rect.width);
    lobbyCanvas.height = Math.floor(rect.height);
  }

  const me = state.lobbyPlayers.find(p=>p.id===state.you);
  if (me){
    const target = clamp(me.x - lobbyCanvas.width/2, 0, Math.max(0, state.lobbyWorld.w - lobbyCanvas.width));
    camX += (target - camX) * 0.08;
  }

  // clear
  lctx.clearRect(0,0,lobbyCanvas.width,lobbyCanvas.height);

  // layered parallax
  for (const L of layers) drawLayerTiled(lctx, L, camX);

  // draw players & bubbles
  lctx.imageSmoothingEnabled = false;
  state.lobbyPlayers.forEach(p=>{
    const sx = Math.floor(p.x - camX);
    const sy = Math.floor(p.y * (lobbyCanvas.height / state.lobbyWorld.h));
    if (sx < -80 || sx > lobbyCanvas.width + 80) return;

    drawDude(lctx, sx, sy, palette[p.avatar||0], p.facing, false);

    // name + tags
    lctx.fillStyle='#bbb'; lctx.font='12px ui-monospace, monospace'; lctx.textAlign='center';
    lctx.fillText(p.name, sx, sy+32);
    const tags=[];
    if (p.id===state.hostId) tags.push('HOST');
    if (p.ready) tags.push('READY');
    if (tags.length){
      const t=tags.join('  '); const w=lctx.measureText(t).width+12;
      lctx.fillStyle='#121212'; lctx.fillRect(sx-w/2, sy-42, w, 16);
      lctx.strokeStyle='#2a2a2a'; lctx.strokeRect(sx-w/2, sy-42, w, 16);
      lctx.fillStyle='#9dd49d'; lctx.fillText(t, sx, sy-30);
    }

    // recent chat bubble
    const b = state.bubbles.get(p.id);
    if (b && b.until > Date.now()){
      const text = b.text;
      const w = lctx.measureText(text).width + 14;
      lctx.fillStyle = '#151515'; lctx.fillRect(sx-w/2, sy-66, w, 18);
      lctx.strokeStyle = '#333'; lctx.strokeRect(sx-w/2, sy-66, w, 18);
      lctx.fillStyle = '#ddd'; lctx.fillText(text, sx, sy-53);
    }
  });

  requestAnimationFrame(drawLobby);
}
requestAnimationFrame(drawLobby);

function drawDude(ctx, x, y, color, facing=1, infected=false){
  ctx.imageSmoothingEnabled=false;
  const x0 = x - 18, y0 = y - 18;
  // hat
  ctx.fillStyle='#ffd966'; ctx.fillRect(x0+16, y0-12, 20, 6);
  ctx.fillStyle='#f5a43a'; ctx.fillRect(x0+34, y0-12, 4, 4);
  // body
  ctx.fillStyle=color; ctx.fillRect(x0+16, y0-6, 24, 28);
  // arm
  if (infected){ ctx.fillRect(x0+(facing>0?40:10), y0-2, 8, 4); }
  else { ctx.fillRect(x0+(facing>0?42:12), y0+4, 6, 4); }
  // legs + foot
  ctx.fillStyle=color; ctx.fillRect(x0+22, y0+10, 4, 4); ctx.fillRect(x0+32, y0+10, 4, 4);
  ctx.fillStyle='#fff'; ctx.fillRect(x0+16, y0+14, 24, 4);
  // eyes (looking forward)
  ctx.fillStyle='#fff'; ctx.fillRect(x0+22, y0, 8, 8); ctx.fillRect(x0+32, y0, 8, 8);
  ctx.fillStyle='#000'; ctx.fillRect(x0+(facing>0?27:23), y0+3, 3, 3); ctx.fillRect(x0+(facing>0?37:33), y0+3, 3, 3);
}

/* ============================ GAME RENDER ============================ */
/* This section mirrors your working build (bigger characters, green for infected,
   powerups (flash/speed/slime), no health bar, full-screen gameplay, etc.) */

const lastPos = new Map();
let animTime=0;
let infectionFlashUntil = 0;

// power event particles
const flashTrails = []; // {from,to,until}
const sparkles = [];    // {x,y,vx,vy,life,color}

addEventListener('keydown', e=>{
  if(state.phase==='GAME' && (e.key===' '||e.code==='Space')){ e.preventDefault(); }
}, { passive:false });

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

addEventListener('keydown', e=>{
  if (state.phase!=='GAME') return;
  if ((e.key===' ' || e.code==='Space') && !e.repeat){
    e.preventDefault();
    socket.emit('use_power');
  }
}, { passive:false });

socket.on('game_state', ({ phase, positions, round, totalRounds, gameEndsAt, powerups, slimes, walls })=>{
  if (phase!=='GAME' || !gctx) return;

  if (roundText) roundText.textContent = `Round ${round} of ${totalRounds}`;
  const ms=Math.max(0,(gameEndsAt||Date.now())-Date.now());
  if (gameTimer) gameTimer.textContent = Math.ceil(ms/1000).toString();
  if (infectCount) infectCount.textContent = positions.filter(p=>p.infected).length.toString();

  state.powerups = powerups || [];
  state.slimes   = slimes   || [];
  state.walls    = walls    || [];

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
  // resize to viewport each frame (full screen)
  const rect = gameCanvas.getBoundingClientRect();
  if (gameCanvas.width !== Math.floor(rect.width) || gameCanvas.height !== Math.floor(rect.height)){
    gameCanvas.width = Math.floor(rect.width);
    gameCanvas.height = Math.floor(rect.height);
  }

  const w=state.world.w, h=state.world.h;
  gctx.clearRect(0,0,w,h);

  // frame
  gctx.strokeStyle='#fff'; gctx.lineWidth=2; gctx.strokeRect(6,6,w-12,h-12);

  // timing
  const now=performance.now(); const dt=(now-animTime)||16; animTime=now;

  // walls
  gctx.strokeStyle='#fff'; gctx.lineWidth=3;
  walls.forEach(r=>{ gctx.strokeRect(r.x, r.y, r.w, r.h); });

  // slimes tiles
  slimes.forEach(s=>{
    const tile=10;
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

// Powerup icons
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

// Character (gameplay size & eyes tracking target)
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
  if (infected){ ctx.fillRect(x0+40, y0+18, 8, 4); }
  else {
    const amp = moving ? 4 : 1;
    const yo = y0+24 + Math.round(Math.sin(performance.now()*0.01)*amp);
    ctx.fillRect(x0+42, yo, 6, 4);
  }

  // LEG hints + FOOT
  ctx.fillStyle=color; ctx.fillRect(x0+22, y0+40, 4, 4); ctx.fillRect(x0+32, y0+40, 4, 4);
  ctx.fillStyle='#fff'; ctx.fillRect(x0+16, y0+44, 24, 4);

  // EYES track target
  ctx.fillStyle='#fff'; ctx.fillRect(x0+22, y0+18, 8, 8); ctx.fillRect(x0+32, y0+18, 8, 8);
  const dx = Math.max(-2, Math.min(2, Math.round((tx - cx)/18)));
  const dy = Math.max(-2, Math.min(2, Math.round((ty - cy)/18)));
  ctx.fillStyle='#000'; ctx.fillRect(x0+25+dx, y0+21+dy, 3, 3); ctx.fillRect(x0+35+dx, y0+21+dy, 3, 3);
}

/* ============================== UTILS ================================ */
function clamp(v,min,max){ return v<min?min:v>max?max:v; }
