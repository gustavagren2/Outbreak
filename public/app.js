// Outbreak client with Pixel-Lobby + Parallax + Movement/Jump
const socket = io();

// ---------- Common helpers ----------
const el = (id) => document.getElementById(id);
const lobbyEl = el('lobby'), reveal = el('reveal'), game = el('game'), board = el('board');
const lobbyCanvas = el('lobbyCanvas'); const lctx = lobbyCanvas.getContext('2d');
const gameCanvas = el('gameCanvas');   const gctx = gameCanvas?.getContext('2d');
const nameInput = el('nameInput'); const readyChk = el('readyChk'); const startBtn = el('startBtn'); const readyCount = el('readyCount');
const chatInput = el('chatInput'); const chatSend = el('chatSend');
const boardChatInput = el('boardChatInput'); const boardChatSend = el('boardChatSend');
const avatarCanvas = el('avatarCanvas'); const ac = avatarCanvas.getContext('2d');
const revealAvatar = el('revealAvatar'); const revealTitle = el('revealTitle'); const revealText = el('revealText'); const countdown = el('countdown');
const muteBtn = el('muteBtn');

const roundText = el('roundText'); const gameTimer = el('gameTimer'); const infectCount = el('infectCount'); const powerHUD = el('powerHUD');
const boardRound = el('boardRound'); const boardRows = el('boardRows'); const boardNext = el('boardNext'); const boardCountdown = el('boardCountdown');
const finalExtras = el('finalExtras'); const boardChatLog = el('boardChatLog');

function showPhaseSections(phase){
  lobbyEl.classList.toggle('hidden', phase!=='LOBBY');
  reveal .classList.toggle('hidden', phase!=='COUNTDOWN');
  game   .classList.toggle('hidden', phase!=='GAME');
  board  .classList.toggle('hidden', phase!=='LEADERBOARD');
  document.body.classList.toggle('fullscreen', phase==='GAME');
}

// ---------- Palette & drawing ----------
const palette = ['#7e6bf2','#4ba23a','#c46a3a','#5c5c5c','#7c69cc','#d4458c','#e4b737','#2d5fab','#7a3f75','#7b1c28'];
const INFECT_COLOR = '#00c83a';

// Avatar preview (same anatomy)
function drawAvatarPreview(color){
  const ctx = ac; const s=7; ctx.imageSmoothingEnabled=false;
  const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*s,y*s,w*s,h*s); };
  ctx.clearRect(0,0,ac.width,ac.height);
  px(6,1,5,2,'#ffd966'); px(10,1,1,1,'#f5a43a'); // hat
  px(6,3,6,7,color); px(12,5,1,2,color);         // body + arm
  px(7,10,1,1,color); px(10,10,1,1,color);       // leg hints
  px(6,11,6,1,'#fff');                            // foot
  px(7,4,2,2,'#fff'); px(10,4,2,2,'#fff');       // eyes
  px(8,5,1,1,'#000'); px(11,5,1,1,'#000');       // pupils
}

// ---------- Audio ----------
let actx, musicUnlocked=false, musicMuted=false, wantSong='lobby';
const music = new (class {
  constructor(){ this.ctx=null; this.buffers={}; this.master=null; this.playing=null; }
  async unlock(){
    if (this.ctx) return;
    this.ctx = actx || new (window.AudioContext||window.webkitAudioContext)();
    actx = this.ctx;
    this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
    await this.load('lobby','/audio/lobby_option_A.wav');
    await this.load('game','/audio/game_option_A.wav');
  }
  async load(name, url){
    const ab = await fetch(url).then(r=>r.arrayBuffer());
    this.buffers[name] = await this.ctx.decodeAudioData(ab);
  }
  play(name){
    if (musicMuted || !this.ctx) return;
    const buf=this.buffers[name]; if(!buf) return;
    const now=this.ctx.currentTime, fade=0.6;
    const src=this.ctx.createBufferSource(); src.buffer=buf; src.loop=true;
    const g=this.ctx.createGain(); g.gain.setValueAtTime(0, now);
    src.connect(g); g.connect(this.master); src.start(now);
    g.gain.linearRampToValueAtTime(0.9, now+fade);
    if (this.playing){
      const old=this.playing; old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now+fade);
      setTimeout(()=>{ try{old.src.stop();}catch{} }, fade*1000+50);
    }
    this.playing = { name, src, gain:g };
  }
  stop(){
    if (!this.playing) return;
    const now=this.ctx.currentTime;
    this.playing.gain.gain.linearRampToValueAtTime(0, now+0.25);
    const s=this.playing.src; setTimeout(()=>{ try{s.stop();}catch{} }, 300);
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

// ---------- State ----------
let state = {
  you:null, host:false, hostId:null,
  phase:'LOBBY',
  players:[], world:{w:1600,h:900},
  lobbyWorld:{ w:1600, h:540, groundY:420 },
  lobbyPlayers:[], // live positions from server
  bubbles: new Map(), // id -> {text,until}
};

// ---------- Inputs ----------
nameInput?.addEventListener('change', ()=> socket.emit('set_name', { name: nameInput.value.trim() }));
readyChk ?.addEventListener('change', ()=> socket.emit('set_ready', { ready: readyChk.checked }));
chatSend ?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') sendChat(); });
function sendChat(){
  const t = chatInput.value.trim(); if(!t) return;
  socket.emit('chat', { message:t }); chatInput.value='';
}

// ---------- Lobby movement (side + jump) ----------
const keys = Object.create(null);
function keyOk(e){
  const tag = (e.target && e.target.tagName)||'';
  return !/INPUT|TEXTAREA|BUTTON/i.test(tag);
}
addEventListener('keydown', (e)=>{
  if (!keyOk(e)) return;
  if (e.key==='ArrowLeft' || e.key==='a' || e.key==='A') keys.left = true;
  if (e.key==='ArrowRight'|| e.key==='d' || e.key==='D') keys.right = true;
  if (state.phase==='LOBBY' && (e.key===' ' || e.key==='w' || e.key==='W' || e.key==='ArrowUp')) { keys.jump = true; e.preventDefault(); }
});
addEventListener('keyup', (e)=>{
  if (!keyOk(e)) return;
  if (e.key==='ArrowLeft' || e.key==='a' || e.key==='A') keys.left = false;
  if (e.key==='ArrowRight'|| e.key==='d' || e.key==='D') keys.right = false;
});
setInterval(()=>{ // send inputs at ~20Hz
  if (state.phase!=='LOBBY') return;
  socket.emit('lobby_input', { left:!!keys.left, right:!!keys.right, jump:!!keys.jump });
  keys.jump = false; // edge-trigger
}, 50);

// ---------- Sockets ----------
socket.on('room_joined', ({ you, hostId, host })=>{
  state.you=you; state.hostId=hostId||null; state.host=!!host;
});

socket.on('room_state', (payload)=>{
  state.hostId = payload.hostId || null;
  state.host   = state.you && payload.hostId && (state.you === payload.hostId);
  state.phase  = payload.phase;
  state.players= payload.players || [];
  state.world  = payload.world || state.world;

  // avatar preview
  const me = state.players.find(p=>p.id===state.you);
  if (me) drawAvatarPreview(palette[me.avatar|0]);

  // music route
  if (payload.phase==='GAME'){ wantSong='game'; if(musicUnlocked && !musicMuted) music.play('game'); }
  else { wantSong='lobby'; if(musicUnlocked && !musicMuted) music.play('lobby'); }

  showPhaseSections(payload.phase);
  // Lobby ready counter
  if (payload.phase==='LOBBY' && readyCount){
    const readyNum = state.players.filter(p=>p.ready).length;
    readyCount.textContent = `${readyNum}/${state.players.length} players ready`;
    startBtn.classList.toggle('hidden', !state.host);
    startBtn.disabled = !(state.host && state.players.length>=3 && readyNum===state.players.length);
  }
});

// live lobby positions
socket.on('lobby_state', ({ players, world })=>{
  state.lobbyPlayers = players||[];
  if (world) state.lobbyWorld = world;
});

// chat bubbles
socket.on('chat_message', ({ from, avatar, id, text })=>{
  state.bubbles.set(id, { text, until: Date.now()+6000, name: from, avatar });
});

// role reveal (unchanged essence)
socket.on('role', ({ role })=>{
  const ctx = revealAvatar.getContext('2d'); const s=12;
  const me = state.players.find(p=>p.id===state.you);
  const color = palette[(me?.avatar|0)||0];
  ctx.imageSmoothingEnabled=false; ctx.clearRect(0,0,revealAvatar.width,revealAvatar.height);
  const px=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x*s,y*s,w*s,h*s); };
  px(6,1,5,2,'#ffd966'); px(10,1,1,1,'#f5a43a');
  px(6,3,6,7,color); px(12,5,1,2,color);
  px(7,10,1,1,color); px(10,10,1,1,color); px(6,11,6,1,'#fff');
  px(7,4,2,2,'#fff'); px(10,4,2,2,'#fff'); px(8,5,1,1,'#000'); px(11,5,1,1,'#000');
  if (role==='PATIENT_ZERO'){ revealTitle.textContent='You are patient Zero.'; revealText.textContent='Try and get close to players to infect them.'; }
  else { revealTitle.textContent='You are a citizen.'; revealText.textContent='Stay away from infected players.'; }
});

startBtn?.addEventListener('click', ()=> socket.emit('start_game'));

/* ======================= LOBBY RENDERER ======================= */
let camX = 0;
const bg = { gen:false, layers:[] };

function ensureBG(){
  if (bg.gen) return;
  // 3 parallax building layers + foreground rubble
  const W = 3200, H = state.lobbyWorld.h;
  const makeLayer = (seed, color, yBase, density, minW, maxW, minH, maxH) => {
    const rnd = mulberry32(seed);
    const rects = [];
    for (let i=0;i<density;i++){
      const w = rand(rnd, minW,maxW);
      const h = rand(rnd, minH,maxH);
      const x = rand(rnd, -400, W-200);
      const y = yBase - h;
      rects.push({x, y, w, h});
    }
    return { color, rects };
  };
  bg.layers = [
    makeLayer(1,'#0e0e0e', state.lobbyWorld.groundY-140, 18, 80,220, 120,240),
    makeLayer(2,'#0b0b0b', state.lobbyWorld.groundY-100, 22, 60,180, 80,180),
    makeLayer(3,'#070707', state.lobbyWorld.groundY-70,  28, 40,140, 60,140),
  ];
  bg.rubble = Array.from({length:18}, (_,i)=>({ x: i*180 + (i%3?60:-40), y: state.lobbyWorld.groundY-8, w: 60, h:4 }));
  bg.gen = true;
}
function mulberry32(a){ return function(){ var t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15, t|1);t^=t+Math.imul(t^t>>>7, t|61);return ((t^t>>>14)>>>0)/4294967296; } }
function rand(r,min,max){ return Math.floor(r()*(max-min+1))+min; }

function drawLobby(){
  ensureBG();
  const { w,h, groundY } = state.lobbyWorld;
  // resize canvas to CSS size on first frames
  const rect = lobbyCanvas.getBoundingClientRect();
  const needResize = (lobbyCanvas.width !== Math.floor(rect.width)) || (lobbyCanvas.height !== Math.floor(rect.height));
  if (needResize){ lobbyCanvas.width = Math.floor(rect.width); lobbyCanvas.height = Math.floor(rect.height); }

  // Compute camera center on your avatar
  const me = state.lobbyPlayers.find(p=>p.id===state.you);
  const viewW = lobbyCanvas.width;
  if (me){
    const target = clamp(me.x - viewW/2, 0, state.lobbyWorld.w - viewW);
    camX += (target - camX) * 0.08;
  }

  // Clear
  lctx.clearRect(0,0,lobbyCanvas.width,lobbyCanvas.height);

  // Ground & sky
  lctx.fillStyle = '#050505'; lctx.fillRect(0,0,lobbyCanvas.width,lobbyCanvas.height);
  const groundScreenY = Math.floor(groundY * (lobbyCanvas.height / state.lobbyWorld.h));
  // Parallax layers
  const parallax = [
    { layer:bg.layers[0], speed:0.25 },
    { layer:bg.layers[1], speed:0.45 },
    { layer:bg.layers[2], speed:0.65 },
  ];
  parallax.forEach(({layer, speed})=>{
    lctx.fillStyle = layer.color;
    for (const r of layer.rects){
      const sx = Math.floor(r.x - camX*speed);
      const sy = Math.floor((r.y/state.lobbyWorld.h) * lobbyCanvas.height);
      const sw = Math.floor(r.w); const sh = Math.floor(r.h);
      lctx.fillRect(sx, sy, sw, sh);
      // occasional “window glow”
      if ((r.w>120) && (r.h>120) && (Math.abs(((sx/47)|0)%7)===0)){
        lctx.fillStyle = 'rgba(160,160,120,0.12)';
        lctx.fillRect(sx+12, sy+24, 6, 10);
        lctx.fillStyle = layer.color;
      }
    }
  });

  // Street line
  lctx.fillStyle = '#0d0d0d';
  lctx.fillRect(0, groundScreenY, lobbyCanvas.width, 3);
  // Foreground rubble
  lctx.fillStyle = '#101010';
  for (const r of bg.rubble){
    const sx = Math.floor(r.x - camX*0.9);
    const sy = Math.floor((r.y/state.lobbyWorld.h)*lobbyCanvas.height);
    lctx.fillRect(sx, sy, r.w, r.h);
  }

  // Players
  const scale = lobbyCanvas.height / state.lobbyWorld.h;
  state.lobbyPlayers.forEach(p=>{
    const sx = Math.floor(p.x - camX);
    const sy = Math.floor(p.y * scale);
    if (sx < -60 || sx > lobbyCanvas.width+60) return;

    drawDude(lctx, sx, sy, palette[p.avatar||0], p.facing, false);

    // name + tags below/above
    lctx.fillStyle='#bbb'; lctx.font='12px ui-monospace, monospace'; lctx.textAlign='center';
    lctx.fillText(p.name, sx, sy+32);
    let tags = [];
    if (p.host) tags.push('HOST');
    if (p.ready) tags.push('READY');
    if (tags.length){
      const t = tags.join('  ');
      const w = lctx.measureText(t).width + 12;
      lctx.fillStyle = '#121212'; lctx.fillRect(sx-w/2, sy-42, w, 16);
      lctx.strokeStyle='#2a2a2a'; lctx.strokeRect(sx-w/2, sy-42, w, 16);
      lctx.fillStyle='#9dd49d'; lctx.fillText(t, sx, sy-30);
    }

    // chat bubble (recent)
    const b = state.bubbles.get(p.id);
    if (b && b.until > Date.now()){
      const text = b.text;
      lctx.font='12px ui-monospace, monospace';
      const w = lctx.measureText(text).width + 14;
      lctx.fillStyle = '#151515'; lctx.fillRect(sx-w/2, sy-66, w, 18);
      lctx.strokeStyle='#333'; lctx.strokeRect(sx-w/2, sy-66, w, 18);
      lctx.fillStyle='#ddd'; lctx.fillText(text, sx, sy-53);
    }
  });

  requestAnimationFrame(drawLobby);
}
function drawDude(ctx, x, y, color, facing=1, infected=false){
  ctx.imageSmoothingEnabled=false;
  const x0 = x - 18; const y0 = y - 18;
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
  // eyes track forward
  ctx.fillStyle='#fff'; ctx.fillRect(x0+22, y0, 8, 8); ctx.fillRect(x0+32, y0, 8, 8);
  ctx.fillStyle='#000'; ctx.fillRect(x0+(facing>0?27:23), y0+3, 3, 3); ctx.fillRect(x0+(facing>0?37:33), y0+3, 3, 3);
}

// kick off lobby render
requestAnimationFrame(drawLobby);

/* ================== GAME CANVAS (unchanged from your build) ==================
   Keep your existing gameplay code here. To keep this message readable I’m not
   duplicating the full game renderer again. This lobby addition doesn’t touch
   your game loop — it coexists with it.
   =========================================================================== */

// Little helpers
function clamp(v,min,max){ return v<min?min:v>max?max:v; }
