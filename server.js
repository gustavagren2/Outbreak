import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening on :' + PORT));

/* ============================ GAME STATE ============================ */
const PHASE = { LOBBY:'LOBBY', COUNTDOWN:'COUNTDOWN', GAME:'GAME', LEADERBOARD:'LEADERBOARD' };
const DEFAULT_CODE = 'ROOM';
const PALETTE = [0,1,2,3,4,5,6,7,8,9];

const rooms = new Map();

/*
Player object (per room):
{
  id, name, avatar, ready,
  // lobby movement
  li:{ left:false, right:false, wantJump:false },
  lp:{ x:number, y:number, vx:number, vy:number, facing:1|-1, onGround:boolean },
  // game fields kept from previous versions:
  dir:{x,y}, lastDir:{x,y}, x,y, infected, speedUntil, inv, round
}
*/

function ensureRoom(){
  let room = rooms.get(DEFAULT_CODE);
  if (room) return room;

  room = {
    code: DEFAULT_CODE,
    hostId: null,
    phase: PHASE.LOBBY,
    round: 0,
    totalRounds: 0,
    players: new Map(),

    // WORLD SIZES
    world: { w: 1600, h: 900 },     // gameplay canvas
    lobbyWorld: { w: 2400, h: 540, groundY: 420 },

    // Options
    options: {
      minPlayers: 3,
      countdownMs: 10_000,
      roundMs: 90_000,
      boardMs: 6000,
      speed: 200,
      contactDist: 22,
      minSpawnFromP0: 260,
      // scoring
      points: { survivalPerSec: 1, perInfection: 5, p0FullInfectBonus: 20 },
      // powerups
      powerups: {
        spawnIntervalMs: 12_000,
        maxOnField: 3,
        pickupDist: 24,
        speedMs: 5000, speedMul: 1.6,
        flashDist: 260,
        slimeMs: 4000, slimeSlowMul: 0.45, slimeLen: 160, slimeThick: 26
      },
      // random walls (gameplay)
      walls: { countMin: 5, countMax: 9, thick: 8, margin: 70 },
      // lobby physics
      lobby: { accel: 2200, maxSpeed: 220, friction: 1400, gravity: 2200, jumpVel: -620 }
    },

    // rotating P0, scoring, etc.
    scores: new Map(),
    p0Queue: [],
    // gameplay entities
    powerups: [],
    slimes: [],
    walls: [],
    // timers
    tick: null,
    lobbyTick: null,
    countdownEndsAt: null,
    gameEndsAt: null,
    boardEndsAt: null
  };

  rooms.set(DEFAULT_CODE, room);
  startLobbyTick(room);
  return room;
}

/* ============================ UTILITIES ============================ */
const clamp = (v,min,max)=> v<min?min:v>max?max:v;
const rectsIntersect = (a,b)=> (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
const playerAABB = (x,y,r)=> ({ x:x-r, y:y-r, w:r*2, h:r*2 });

/* ============================ LOBBY TICK ============================ */
function startLobbyTick(room){
  if (room.lobbyTick) clearInterval(room.lobbyTick);
  const dtMs = 50; // 20Hz
  room.lobbyTick = setInterval(()=>{
    if (room.phase !== PHASE.LOBBY) return;

    const { accel, maxSpeed, friction, gravity, jumpVel } = room.options.lobby;
    const ground = room.lobbyWorld.groundY;

    for (const p of room.players.values()){
      const li = p.li, lp = p.lp;
      // horizontal
      if (li.left && !li.right)  lp.vx = Math.max(lp.vx - accel*(dtMs/1000), -maxSpeed);
      else if (li.right && !li.left) lp.vx = Math.min(lp.vx + accel*(dtMs/1000),  maxSpeed);
      else {
        // friction
        const s = Math.sign(lp.vx);
        lp.vx -= s * friction*(dtMs/1000);
        if (Math.sign(lp.vx) !== s) lp.vx = 0;
      }
      if (li.left)  lp.facing = -1;
      if (li.right) lp.facing =  1;

      // jump
      if (li.wantJump && lp.onGround){
        lp.vy = jumpVel; lp.onGround = false;
      }
      li.wantJump = false;

      // gravity
      lp.vy += gravity*(dtMs/1000);
      lp.x += lp.vx*(dtMs/1000);
      lp.y += lp.vy*(dtMs/1000);

      // bounds & ground
      lp.x = clamp(lp.x, 60, room.lobbyWorld.w-60);
      if (lp.y >= ground){ lp.y = ground; lp.vy = 0; lp.onGround = true; }
    }

    // broadcast lightweight lobby snapshot
    const players = [...room.players.values()].map(p=>({
      id:p.id, name:p.name, avatar:p.avatar, ready:p.ready,
      x: Math.round(p.lp.x), y: Math.round(p.lp.y), facing:p.lp.facing,
      host: p.id === room.hostId
    }));
    io.to(room.code).emit('lobby_state', { players, world: room.lobbyWorld, title:'Zombie Outbreak' });
  }, dtMs);
}

/* ============================ GAMEPLAY HELPERS ============================ */
// (kept from previous version but trimmed for clarity)
function randomSpawn(room){
  return { x: Math.random()*(room.world.w-140)+70, y: Math.random()*(room.world.h-140)+70 };
}
function genWalls(room){
  const { w,h } = room.world;
  const { thick, margin } = room.options.walls;
  const count = ((room.options.walls.countMin + Math.random()*(room.options.walls.countMax - room.options.walls.countMin + 1))|0);
  const walls = [];
  let tries = 0;
  while (walls.length < count && tries < count*20){
    tries++;
    const vertical = Math.random() < 0.5;
    const len = vertical ? (180 + Math.random()*360) : (220 + Math.random()*420);
    const t = thick;
    const x = clamp(Math.random()*(w - len - margin*2) + margin, margin, w - margin);
    const y = clamp(Math.random()*(h - len - margin*2) + margin, margin, h - margin);
    const rect = vertical ? { x: Math.round(x), y: Math.round(y), w: t, h: Math.round(len) }
                          : { x: Math.round(x), y: Math.round(y), w: Math.round(len), h: t };
    const tooClose = walls.some(r=>rectsIntersect(
      { x:rect.x-12, y:rect.y-12, w:rect.w+24, h:rect.h+24 }, r
    ));
    if (!tooClose) walls.push(rect);
  }
  room.walls = walls;
}

function publicPlayers(room){
  return [...room.players.values()].map(p=>({
    id:p.id, name:p.name, avatar:p.avatar, ready:p.ready
  }));
}
function broadcastRoom(room){
  io.to(room.code).emit('room_state', {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds,
    players: publicPlayers(room),
    countdownEndsAt: room.countdownEndsAt || null,
    gameEndsAt: room.gameEndsAt || null,
    boardEndsAt: room.boardEndsAt || null,
    board: room.phase === PHASE.LEADERBOARD ? (room.board || []) : [],
    world: room.world
  });
}

/* ============================ ROUND FLOW (unchanged essence) ============================ */
// NOTE: This section is identical in spirit to the working version you already deployed.
// For brevity, only differences relevant to lobby remain here. If you need the whole
// gameplay block again, I can paste it, but your current server.js game loop will work
// alongside the lobby code above.

function buildP0Queue(room){
  const ids = [...room.players.keys()];
  const q = [];
  ids.forEach(id => { q.push(id, id); });
  for (let i=q.length-1;i>0;i--){
    const j=(Math.random()*(i+1))|0;
    [q[i], q[j]] = [q[j], q[i]];
  }
  room.p0Queue = q;
}

function startGameSeries(room){
  room.totalRounds = Math.max(1, room.players.size * 2);
  room.round = 0;
  room.scores = new Map();
  for (const id of room.players.keys()) room.scores.set(id, { total:0, infections:0, survivalMs:0 });
  buildP0Queue(room);
  startNextRound(room);
}

function startNextRound(room){
  room.round += 1;
  if (room.round > room.totalRounds) return;
  genWalls(room);
  // … reset players, choose patient zero, spawn logic, etc. (as in your current server)
  room.phase = PHASE.COUNTDOWN;
  room.countdownEndsAt = Date.now() + room.options.countdownMs;
  room.gameEndsAt = null; room.boardEndsAt = null; room.board = null;
  broadcastRoom(room);
  setTimeout(()=> startRoundPlay(room), room.options.countdownMs);
}
function startRoundPlay(room){
  if (room.phase !== PHASE.COUNTDOWN) return;
  room.phase = PHASE.GAME;
  room.gameEndsAt = Date.now() + room.options.roundMs;
  room.countdownEndsAt = null;
  broadcastRoom(room);
  // … start gameplay tick (kept from your current build)
}
function endRound(room){
  room.phase = PHASE.LEADERBOARD;
  // … compute scoreboard and either schedule next or stay on final
  broadcastRoom(room);
}

/* ============================ SOCKETS ============================ */
io.on('connection', (socket)=>{
  const room = ensureRoom();
  socket.join(room.code);

  // Add player
  const spawnX = 200 + Math.random()*(room.lobbyWorld.w-400);
  room.players.set(socket.id, {
    id: socket.id,
    name: 'PLAYER',
    avatar: chooseAvatar(room),
    ready: false,
    li: { left:false, right:false, wantJump:false },
    lp: { x: spawnX, y: room.lobbyWorld.groundY, vx:0, vy:0, facing:1, onGround:true },
    // gameplay fields that your current code expects:
    dir:{x:0,y:0}, lastDir:{x:1,y:0},
    x:0, y:0, infected:false, speedUntil:0,
    inv:{ flash:0, slime:0, speed:0 },
    round:{ survivalMs:0, infections:0, isP0:false }
  });

  if (!room.hostId) room.hostId = socket.id;

  socket.emit('room_joined', { code: room.code, you: socket.id, hostId: room.hostId, host: room.hostId===socket.id });
  broadcastRoom(room);

  // LOBBY movement inputs
  socket.on('lobby_input', ({ left, right, jump })=>{
    const p = room.players.get(socket.id);
    if (!p) return;
    p.li.left  = !!left;
    p.li.right = !!right;
    if (jump) p.li.wantJump = true;
  });

  // Name / Ready / Chat
  socket.on('set_name', ({ name })=>{
    const p = room.players.get(socket.id); if (!p) return;
    p.name = String(name||'').slice(0,16) || p.name; broadcastRoom(room);
  });
  socket.on('set_ready', ({ ready })=>{
    const p = room.players.get(socket.id); if (!p) return;
    p.ready = !!ready; broadcastRoom(room);
  });
  socket.on('chat', ({ message })=>{
    const p = room.players.get(socket.id); if (!p) return;
    io.to(room.code).emit('chat_message', { from:p.name, avatar:p.avatar, id:p.id, text:String(message||'').slice(0,300) });
  });

  // Start game (host only)
  socket.on('start_game', ()=>{
    if (socket.id !== room.hostId) return;
    const players = [...room.players.values()];
    const allReady = players.length >= room.options.minPlayers && players.every(p=>p.ready);
    if (!allReady){ socket.emit('error_message','not_ready'); return; }
    startGameSeries(room);
  });
  socket.on('restart_series', ()=>{
    if (socket.id !== room.hostId) return;
    for (const p of room.players.values()) p.ready = false;
    startGameSeries(room);
  });

  socket.on('disconnect', ()=>{
    const wasHost = room.hostId === socket.id;
    room.players.delete(socket.id);
    if (wasHost){
      const next = room.players.keys().next().value;
      room.hostId = next || null;
    }
    broadcastRoom(room);
  });
});

function chooseAvatar(room){
  const used = new Set([...room.players.values()].map(p=>p.avatar));
  const free = PALETTE.filter(i=>!used.has(i));
  return free.length ? free[(Math.random()*free.length)|0] : (Math.random()*PALETTE.length)|0;
}
