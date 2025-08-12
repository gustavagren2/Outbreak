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

/* ---------------------------- Game State ---------------------------- */
const PHASE = { LOBBY:'LOBBY', COUNTDOWN:'COUNTDOWN', GAME:'GAME', LEADERBOARD:'LEADERBOARD' };
const DEFAULT_CODE = 'ROOM';
const PALETTE = [0,1,2,3,4,5,6,7,8,9];

const rooms = new Map();
/*
room = {
  code, hostId,
  phase, round, totalRounds,
  players: Map<id, Player>,
  countdownEndsAt?, gameEndsAt?, boardEndsAt?,
  tick?,
  world: { w,h },
  options: {
    speed, contactDist, roundMs, countdownMs, boardMs, minPlayers,
    minSpawnFromP0,
    powerups: {
      spawnIntervalMs, maxOnField, pickupDist,
      speedMs, speedMul,
      flashDist,
      slimeMs, slimeSlowMul, slimeLen, slimeThick
    },
    walls: { countMin, countMax, thick, margin }
  },
  scores: Map<id, { total:number, infections:number, survivalMs:number }>,
  board?: Array,
  p0Queue: string[],
  powerups: Array<{id,type,x,y}>,
  nextPowerSpawn?: number,
  puSeq?: number,
  slimes: Array<{id,x,y,w,h,expiresAt}>,
  slimeSeq?: number,
  walls: Array<{x,y,w,h}>
}
Player = {
  id,name,avatar,ready,
  dir:{x,y}, lastDir:{x,y},
  x,y,infected:boolean,
  speedUntil:number,
  inv:{ flash:number, slime:number, speed:number },
  round:{survivalMs:number,infections:number,isP0:boolean}
}
*/

const clamp = (v,min,max)=> v<min?min:v>max?max:v;

/* --------------------------- Room bootstrap --------------------------- */
function ensureDefaultRoom(){
  let room = rooms.get(DEFAULT_CODE);
  if (room) return room;
  room = {
    code: DEFAULT_CODE,
    hostId: null,
    phase: PHASE.LOBBY,
    round: 0,
    totalRounds: 0,
    players: new Map(),
    world: { w: 1600, h: 900 },
    options: {
      speed: 200,
      contactDist: 22,
      roundMs: 90_000,
      countdownMs: 10_000,
      boardMs: 6000,
      minPlayers: 3,
      minSpawnFromP0: 260,
      powerups: {
        spawnIntervalMs: 12_000,
        maxOnField: 3,
        pickupDist: 24,
        speedMs: 5000,   speedMul: 1.6,
        flashDist: 260,
        slimeMs: 4000,   slimeSlowMul: 0.45,
        slimeLen: 160,   slimeThick: 26
      },
      walls: {
        countMin: 5,
        countMax: 9,
        thick: 8,
        margin: 70
      }
    },
    scores: new Map(),
    p0Queue: [],
    powerups: [],
    nextPowerSpawn: 0,
    puSeq: 0,
    slimes: [],
    slimeSeq: 0,
    walls: []
  };
  rooms.set(DEFAULT_CODE, room);
  return room;
}

/* ----------------------------- Utilities ----------------------------- */
function randomSpawn(room){
  return { x: Math.random()*(room.world.w-140)+70, y: Math.random()*(room.world.h-140)+70 };
}

function usedAvatars(room){
  const s = new Set();
  for (const p of room.players.values()) s.add(p.avatar|0);
  return s;
}
function chooseUnusedAvatar(room){
  const used = usedAvatars(room);
  const free = PALETTE.filter(i=>!used.has(i));
  if (free.length) return free[(Math.random()*free.length)|0];
  return (Math.random()*PALETTE.length)|0; // fallback
}

const RADIUS = 18; // player half-size for collisions
const rectsIntersect = (a,b)=> (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
const playerAABB = (x,y)=> ({ x:x-RADIUS, y:y-RADIUS, w:RADIUS*2, h:RADIUS*2 });

function collidesWalls(room, x, y){
  const box = playerAABB(x,y);
  for (const r of room.walls){ if (rectsIntersect(box, r)) return true; }
  return false;
}
function pointInWalls(room, x, y, pad=0){
  const p = { x:x-pad, y:y-pad, w:pad*2, h:pad*2 };
  for (const r of room.walls){ if (rectsIntersect(p, r)) return true; }
  return false;
}

/* Move with axis separation & wall sliding */
function moveWithCollisions(room, p, vx, vy, dt){
  // X axis
  let nx = clamp(p.x + vx, RADIUS, room.world.w - RADIUS);
  if (collidesWalls(room, nx, p.y)) nx = p.x;
  p.x = nx;

  // Y axis
  let ny = clamp(p.y + vy, RADIUS, room.world.h - RADIUS);
  if (collidesWalls(room, p.x, ny)) ny = p.y;
  p.y = ny;
}

/* Raycast-ish flash: step forward until next step would collide */
function flashTo(room, p, dir, dist){
  const steps = Math.ceil(dist/8);
  let x = p.x, y = p.y;
  for (let i=0;i<steps;i++){
    const nx = clamp(x + dir.x*8, RADIUS, room.world.w - RADIUS);
    const ny = clamp(y + dir.y*8, RADIUS, room.world.h - RADIUS);
    if (collidesWalls(room, nx, ny)) break;
    x = nx; y = ny;
  }
  return { x, y };
}

function publicPlayers(room){
  return [...room.players.values()].map(p=>({
    id:p.id, name:p.name, avatar:p.avatar, ready:p.ready
  }));
}

function sendRoomStateTo(socketId, room){
  io.to(socketId).emit('room_state', {
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
function broadcastGame(room){
  const positions = [...room.players.values()].map(p=>({
    id:p.id, x:p.x, y:p.y, infected:p.infected, avatar:p.avatar,
    speedUntil:p.speedUntil||0,
    inv:{ flash:p.inv.flash, slime:p.inv.slime, speed:p.inv.speed }
  }));
  io.to(room.code).emit('game_state', {
    phase: room.phase,
    positions,
    round: room.round,
    totalRounds: room.totalRounds,
    gameEndsAt: room.gameEndsAt || null,
    powerups: room.powerups,
    slimes: room.slimes,
    walls: room.walls
  });
}

/* ------------------- P0 rotation (twice per series) ------------------- */
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

/* --------------------------- Wall generation --------------------------- */
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

    // avoid near-duplicate overlaps so the map stays readable
    const tooClose = walls.some(r=>rectsIntersect(
      { x:rect.x-12, y:rect.y-12, w:rect.w+24, h:rect.h+24 }, r
    ));
    if (!tooClose) walls.push(rect);
  }
  room.walls = walls;
}

/* -------------------------------- Rounds -------------------------------- */
function startGameSeries(room){
  room.totalRounds = Math.max(1, room.players.size * 2);
  room.round = 0;
  room.scores.clear();
  for (const id of room.players.keys()){
    room.scores.set(id, { total:0, infections:0, survivalMs:0 });
  }
  buildP0Queue(room);
  startNextRound(room);
}

function validSpawn(room, cand){
  if (collidesWalls(room, cand.x, cand.y)) return false;
  return true;
}

function startNextRound(room){
  room.round += 1;
  if (room.round > room.totalRounds) return;

  // new arena dressing
  genWalls(room);

  // clear field objects
  room.powerups = [];
  room.puSeq = 0;
  room.nextPowerSpawn = 0;
  room.slimes = [];
  room.slimeSeq = 0;

  // reset per-round
  for (const p of room.players.values()){
    p.dir = { x:0, y:0 };
    p.lastDir = { x:1, y:0 };
    p.infected = false;
    p.speedUntil = 0;
    p.inv = { flash:0, slime:0, speed:0 };
    p.round = { survivalMs:0, infections:0, isP0:false };
  }

  // choose Patient Zero
  while (room.p0Queue.length && !room.players.has(room.p0Queue[0])) room.p0Queue.shift();
  let p0 = room.p0Queue.length ? room.p0Queue.shift() : null;
  if (!p0){
    const ids = [...room.players.keys()];
    p0 = ids[(Math.random()*ids.length)|0];
  }

  // spawn P0 first (avoid walls)
  const pz = room.players.get(p0);
  let pzSpawn; for (let i=0;i<100;i++){ const c=randomSpawn(room); if (validSpawn(room,c)){ pzSpawn=c; break; } }
  pzSpawn ||= { x: room.world.w/2, y: room.world.h/2 };
  pz.x = pzSpawn.x; pz.y = pzSpawn.y;
  pz.infected = true; pz.round.isP0 = true;

  // spawn others, respecting distance to P0 and walls
  const minD = room.options.minSpawnFromP0;
  for (const [id, p] of room.players){
    if (id === p0) continue;
    let s, tries=0;
    do {
      s = randomSpawn(room); tries++;
    } while (
      tries < 80 &&
      ( ((s.x-pz.x)**2 + (s.y-pz.y)**2) < minD*minD || !validSpawn(room, s) )
    );
    (s ||= { x: room.world.w/2, y: room.world.h/2 });
    p.x = s.x; p.y = s.y;
  }

  // private role reveal
  for (const p of room.players.values()){
    io.to(p.id).emit('role', { role: p.round.isP0 ? 'PATIENT_ZERO' : 'CITIZEN' });
  }

  room.phase = PHASE.COUNTDOWN;
  room.countdownEndsAt = Date.now() + room.options.countdownMs;
  room.gameEndsAt = null; room.boardEndsAt = null; room.board = null;

  setTimeout(()=> startRoundPlay(room), room.options.countdownMs);
  broadcastRoom(room);
}

function startRoundPlay(room){
  if (room.phase !== PHASE.COUNTDOWN) return;
  room.phase = PHASE.GAME;
  room.gameEndsAt = Date.now() + room.options.roundMs;
  room.countdownEndsAt = null;

  if (room.tick) clearInterval(room.tick);
  const dtMs = 50; // 20 Hz
  room.nextPowerSpawn = Date.now() + 4000; // first spawn after 4s
  room.tick = setInterval(()=> tick(room, dtMs), dtMs);

  broadcastRoom(room);
}

function endRound(room){
  room.phase = PHASE.LEADERBOARD;
  if (room.tick) { clearInterval(room.tick); room.tick = null; }
  room.countdownEndsAt = null; room.gameEndsAt = null;

  const everybodyInfected = [...room.players.values()].every(p=>p.infected);
  const board = [];
  for (const p of room.players.values()){
    const survSec = Math.floor(p.round.survivalMs/1000);
    const fromSurv = survSec * room.options.points.survivalPerSec;
    const fromInf  = p.round.infections * room.options.points.perInfection;
    const bonus    = (p.round.isP0 && everybodyInfected) ? room.options.points.p0FullInfectBonus : 0;
    const roundScore = fromSurv + fromInf + bonus;

    const t = room.scores.get(p.id) || { total:0, infections:0, survivalMs:0 };
    t.total += roundScore; t.infections += p.round.infections; t.survivalMs += p.round.survivalMs;
    room.scores.set(p.id, t);

    board.push({ id:p.id, name:p.name, avatar:p.avatar, survSec, infections:p.round.infections, bonus, roundScore, total:t.total });
  }
  board.sort((a,b)=> b.roundScore - a.roundScore || b.total - a.total);
  room.board = board;

  if (room.round >= room.totalRounds){
    room.boardEndsAt = null; // final stays
    broadcastRoom(room);
  } else {
    room.boardEndsAt = Date.now() + room.options.boardMs;
    broadcastRoom(room);
    setTimeout(()=> startNextRound(room), room.options.boardMs);
  }
}

/* --------------------------------- Tick -------------------------------- */
function spawnPowerup(room){
  if (room.powerups.length >= room.options.powerups.maxOnField) return;
  // pick a free spot not inside a wall
  let s; for (let i=0;i<80;i++){ const c=randomSpawn(room); if (!pointInWalls(room,c.x,c.y,10)){ s=c; break; } }
  if (!s) return;
  const types = ['flash','speed','slime'];
  const type = types[(Math.random()*types.length)|0];
  room.powerups.push({ id: ++room.puSeq, type, x:s.x, y:s.y });
}

function inSlime(room, x, y){
  const now = Date.now();
  let slow = 1;
  for (const s of room.slimes){
    if (now >= s.expiresAt) continue;
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h){
      slow *= room.options.powerups.slimeSlowMul;
    }
  }
  return slow;
}

function tick(room, dtMs){
  if (room.phase !== PHASE.GAME) return;
  const dt = dtMs/1000, base = room.options.speed;

  // spawn powerups
  if (Date.now() >= room.nextPowerSpawn){
    spawnPowerup(room);
    room.nextPowerSpawn = Date.now() + room.options.powerups.spawnIntervalMs;
  }

  // prune expired slimes
  const now = Date.now();
  room.slimes = room.slimes.filter(s => s.expiresAt > now);

  // integrate + survival with wall collisions
  for (const p of room.players.values()){
    const speedMul = (p.speedUntil > now ? room.options.powerups.speedMul : 1) * inSlime(room, p.x, p.y);
    const vx = (p.dir?.x||0) * base * speedMul * dt;
    const vy = (p.dir?.y||0) * base * speedMul * dt;
    if (vx || vy){
      const len = Math.hypot(p.dir.x||0, p.dir.y||0) || 1;
      p.lastDir.x = (p.dir.x||0)/len;
      p.lastDir.y = (p.dir.y||0)/len;
    }
    moveWithCollisions(room, p, vx, vy, dtMs);
    if (!p.infected) p.round.survivalMs += dtMs;
  }

  // instant infection on contact
  const infected = [...room.players.values()].filter(p=>p.infected);
  const healthy  = [...room.players.values()].filter(p=>!p.infected);
  for (const h of healthy){
    let source = null;
    for (const z of infected){
      const dx = z.x - h.x, dy = z.y - h.y;
      if (dx*dx + dy*dy <= room.options.contactDist * room.options.contactDist){ source = z; break; }
    }
    if (source){
      h.infected = true;
      source.round.infections += 1;
      io.to(room.code).emit('system_message', `infect:${h.name}`);
    }
  }

  // powerup pickup
  for (let i=room.powerups.length-1; i>=0; i--){
    const pu = room.powerups[i];
    let pickedBy = null;
    for (const p of room.players.values()){
      const dx = pu.x - p.x, dy = pu.y - p.y;
      if (dx*dx + dy*dy <= room.options.powerups.pickupDist * room.options.powerups.pickupDist){
        pickedBy = p; break;
      }
    }
    if (pickedBy){
      room.powerups.splice(i,1);
      if (pu.type==='speed') pickedBy.inv.speed += 1;
      if (pu.type==='flash') pickedBy.inv.flash += 1;
      if (pu.type==='slime') pickedBy.inv.slime += 1;
      io.to(room.code).emit('system_message', `power:${pu.type}:${pickedBy.name}`);
      io.to(room.code).emit('power_event', { type:'pickup', puType:pu.type, x:pu.x, y:pu.y, id:pickedBy.id });
    }
  }

  const everyoneInfected = [...room.players.values()].every(p=>p.infected);
  if (everyoneInfected || Date.now() >= room.gameEndsAt) { endRound(room); return; }

  broadcastGame(room);
}

/* ------------------------------ Sockets ------------------------------ */
io.on('connection', (socket)=>{
  const room = ensureDefaultRoom();
  socket.join(room.code);

  const spawn = randomSpawn(room);
  const avatarIdx = chooseUnusedAvatar(room);
  room.players.set(socket.id, {
    id: socket.id, name: 'PLAYER', avatar: avatarIdx, ready: false,
    dir:{x:0,y:0}, lastDir:{x:1,y:0},
    x:spawn.x, y:spawn.y, infected:false,
    speedUntil: 0,
    inv: { flash:0, slime:0, speed:0 },
    round:{survivalMs:0,infections:0,isP0:false}
  });
  if (!room.hostId) room.hostId = socket.id;

  socket.emit('room_joined', { code: room.code, you: socket.id, hostId: room.hostId, host: room.hostId===socket.id });
  sendRoomStateTo(socket.id, room);
  broadcastRoom(room);

  socket.on('set_name', ({ name })=>{
    const r = ensureDefaultRoom(); const p = r.players.get(socket.id); if (!p) return;
    p.name = String(name||'').slice(0,16) || p.name; broadcastRoom(r);
  });

  socket.on('set_ready', ({ ready })=>{
    const r = ensureDefaultRoom(); const p = r.players.get(socket.id); if (!p) return;
    p.ready = !!ready; broadcastRoom(r);
  });

  socket.on('chat', ({ message })=>{
    const r = ensureDefaultRoom(); if (!r) return;
    if (r.phase === PHASE.GAME) return;
    const p = r.players.get(socket.id); if (!p) return;
    io.to(r.code).emit('chat_message', { from:p.name, avatar:p.avatar|0, text:String(message||'').slice(0,300) });
  });

  socket.on('start_game', ()=>{
    const r = ensureDefaultRoom(); if (socket.id !== r.hostId) return;
    const players = [...r.players.values()];
    const min = r.options.minPlayers;
    const allReady = players.length >= min && players.every(p=>p.ready);
    if (!allReady){ socket.emit('error_message','not_ready'); return; }
    startGameSeries(r);
  });

  socket.on('restart_series', ()=>{
    const r = ensureDefaultRoom(); if (socket.id !== r.hostId) return;
    for (const p of r.players.values()) p.ready = false;
    startGameSeries(r);
  });

  socket.on('use_power', ()=>{
    const r = ensureDefaultRoom(); if (r.phase !== PHASE.GAME) return;
    const p = r.players.get(socket.id); if (!p) return;
    const now = Date.now();

    // priority: SPEED → FLASH → SLIME
    if (p.inv.speed > 0){
      p.inv.speed -= 1;
      p.speedUntil = Math.max(p.speedUntil, now) + r.options.powerups.speedMs;
      io.to(r.code).emit('system_message', `power:speed:${p.name}`);
      io.to(r.code).emit('power_event', { type:'speed', id:p.id, until:p.speedUntil });
      return;
    }
    if (p.inv.flash > 0){
      const from = { x:p.x, y:p.y };
      p.inv.flash -= 1;
      const dir = (Math.abs(p.lastDir.x) + Math.abs(p.lastDir.y)) > 0.01 ? p.lastDir : {x:1,y:0};
      const end = flashTo(r, p, dir, r.options.powerups.flashDist);
      p.x = end.x; p.y = end.y;
      io.to(r.code).emit('system_message', `power:flash:${p.name}`);
      io.to(r.code).emit('power_event', { type:'flash', id:p.id, from, to:end });
      return;
    }
    if (p.inv.slime > 0){
      p.inv.slime -= 1;
      const horizontal = Math.abs(p.lastDir.x) >= Math.abs(p.lastDir.y);
      const len = r.options.powerups.slimeLen;
      const thick = r.options.powerups.slimeThick;
      const x = clamp(p.x - (horizontal ? len/2 : thick/2), 10, r.world.w-10);
      const y = clamp(p.y - (horizontal ? thick/2 : len/2), 10, r.world.h-10);
      const w = horizontal ? len : thick;
      const h = horizontal ? thick : len;
      const slab = { id: ++r.slimeSeq, x, y, w, h, expiresAt: now + r.options.powerups.slimeMs };
      r.slimes.push(slab);
      io.to(r.code).emit('system_message', `power:slime:${p.name}`);
      io.to(r.code).emit('power_event', { type:'slime_place', id:p.id, rect: { x, y, w, h } });
    }
  });

  socket.on('input', ({ dir })=>{
    const r = ensureDefaultRoom(); if (r.phase !== PHASE.GAME) return;
    const p = r.players.get(socket.id); if (!p) return;
    const x = Number(dir?.x)||0, y=Number(dir?.y)||0;
    const len = Math.hypot(x,y)||1;
    p.dir.x = x/len; p.dir.y = y/len;
  });

  socket.on('disconnect', ()=>{
    const r = ensureDefaultRoom();
    if (!r.players.has(socket.id)) return;
    const wasHost = r.hostId === socket.id;
    r.players.delete(socket.id);
    if (wasHost){
      const next = r.players.keys().next().value;
      r.hostId = next || null;
    }
    if (r.phase !== PHASE.LOBBY && r.players.size === 0){
      if (r.tick) clearInterval(r.tick);
      rooms.delete(r.code);
    } else broadcastRoom(r);
  });
});
