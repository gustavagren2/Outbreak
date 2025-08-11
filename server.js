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
const DEFAULT_CODE = 'ROOM'; // single shared room
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
    powerups: { spawnIntervalMs, maxOnField, pickupDist, speedMs, speedMul }
    points:{ survivalPerSec, perInfection, p0FullInfectBonus }
  },
  scores: Map<id, { total:number, infections:number, survivalMs:number }>,
  board?: Array,
  p0Queue: string[],
  powerups: Array<{id,type,x,y}>,
  nextPowerSpawn?: number,
  puSeq?: number
}
Player = { id,name,avatar,ready,dir:{x,y},x,y,infected:boolean, speedUntil:number, round:{survivalMs:number,infections:number,isP0:boolean} }
*/

const clamp = (v,min,max)=> v<min?min:v>max?max:v;

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
      speed: 200,           // px/s base
      contactDist: 22,      // collision distance (bigger chars)
      roundMs: 90_000,
      countdownMs: 10_000,
      boardMs: 6000,
      minPlayers: 3,
      minSpawnFromP0: 260,  // players won’t spawn closer than this to P0
      powerups: {
        spawnIntervalMs: 12_000,
        maxOnField: 3,
        pickupDist: 24,
        speedMs: 5000,
        speedMul: 1.6
      },
      points: {
        survivalPerSec: 1,
        perInfection: 25,
        p0FullInfectBonus: 50
      }
    },
    scores: new Map(),
    p0Queue: [],
    powerups: [],
    nextPowerSpawn: 0,
    puSeq: 0
  };
  rooms.set(DEFAULT_CODE, room);
  return room;
}

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

function publicPlayers(room){
  return [...room.players.values()].map(p=>({
    id:p.id, name:p.name, avatar:p.avatar, ready:p.ready
  }));
}

function sendRoomStateTo(socketId, room){
  io.to(socketId).emit('room_state', {
    code: room.code,
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
    id:p.id, x:p.x, y:p.y, infected:p.infected, avatar:p.avatar, speedUntil:p.speedUntil||0
  }));
  io.to(room.code).emit('game_state', {
    phase: room.phase,
    positions,
    round: room.round,
    totalRounds: room.totalRounds,
    gameEndsAt: room.gameEndsAt || null,
    powerups: room.powerups
  });
}

/* ------------------- Patient Zero rotation (twice each) ------------------- */
function buildP0Queue(room){
  const ids = [...room.players.keys()];
  const q = [];
  ids.forEach(id => { q.push(id, id); }); // twice each
  for (let i=q.length-1;i>0;i--){
    const j=(Math.random()*(i+1))|0;
    [q[i], q[j]] = [q[j], q[i]];
  }
  room.p0Queue = q;
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

function startNextRound(room){
  room.round += 1;
  if (room.round > room.totalRounds) return;

  // clear powerups
  room.powerups = [];
  room.puSeq = 0;
  room.nextPowerSpawn = 0;

  // reset per-round
  for (const p of room.players.values()){
    p.dir = { x:0, y:0 };
    p.infected = false;
    p.speedUntil = 0;
    p.round = { survivalMs:0, infections:0, isP0:false };
  }

  // pick P0 from queue (skip leavers)
  while (room.p0Queue.length && !room.players.has(room.p0Queue[0])) room.p0Queue.shift();
  let p0 = room.p0Queue.length ? room.p0Queue.shift() : null;
  if (!p0){
    const ids = [...room.players.keys()];
    p0 = ids[(Math.random()*ids.length)|0];
  }

  // spawn P0 first
  const pz = room.players.get(p0);
  const pzSpawn = randomSpawn(room);
  pz.x = pzSpawn.x; pz.y = pzSpawn.y;
  pz.infected = true; pz.round.isP0 = true;

  // spawn others, respecting min distance to P0
  for (const [id, p] of room.players){
    if (id === p0) continue;
    let s, tries=0;
    const minD = room.options.minSpawnFromP0;
    do {
      s = randomSpawn(room);
      tries++;
    } while (tries<50 && ((s.x-pz.x)*(s.x-pz.x) + (s.y-pz.y)*(s.y-pz.y)) < minD*minD);
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
  const s = randomSpawn(room);
  room.powerups.push({ id: ++room.puSeq, type:'speed', x:s.x, y:s.y });
}

function tick(room, dtMs){
  if (room.phase !== PHASE.GAME) return;
  const dt = dtMs/1000, base = room.options.speed;

  // maybe spawn a powerup
  if (Date.now() >= room.nextPowerSpawn){
    spawnPowerup(room);
    room.nextPowerSpawn = Date.now() + room.options.powerups.spawnIntervalMs;
  }

  // integrate + survival
  for (const p of room.players.values()){
    const mul = (p.speedUntil && p.speedUntil > Date.now()) ? room.options.powerups.speedMul : 1;
    p.x = clamp(p.x + p.dir.x * base * mul * dt, 20, room.world.w-20);
    p.y = clamp(p.y + p.dir.y * base * mul * dt, 20, room.world.h-20);
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

  // powerup pickup collisions (anyone can take)
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
      if (pu.type==='speed'){
        pickedBy.speedUntil = Date.now() + room.options.powerups.speedMs;
        io.to(room.code).emit('system_message', `power:speed:${pickedBy.name}`);
      }
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

  // add player with unique colour
  const spawn = randomSpawn(room);
  const avatarIdx = chooseUnusedAvatar(room);
  room.players.set(socket.id, {
    id: socket.id, name: 'PLAYER', avatar: avatarIdx, ready: false,
    dir:{x:0,y:0}, x:spawn.x, y:spawn.y, infected:false,
    speedUntil: 0,
    round:{survivalMs:0,infections:0,isP0:false}
  });
  if (!room.hostId) room.hostId = socket.id;

  socket.emit('room_joined', { code: room.code, you: socket.id, host: room.hostId===socket.id });
  sendRoomStateTo(socket.id, room);
  broadcastRoom(room);

  socket.on('set_name', ({ name })=>{
    const r = ensureDefaultRoom(); const p = r.players.get(socket.id); if (!p) return;
    p.name = String(name||'').slice(0,16) || p.name; broadcastRoom(r);
  });

  // colour selection removed; keep handler harmless if ever sent
  socket.on('set_avatar', ({ avatar })=>{
    const r = ensureDefaultRoom(); const p = r.players.get(socket.id); if (!p) return;
    const idx = Math.max(0, Math.min(9, avatar|0));
    const takenBy = [...r.players.values()].find(q => q.id !== p.id && (q.avatar|0) === idx);
    if (takenBy){ socket.emit('error_message','color_taken'); sendRoomStateTo(socket.id, r); return; }
    p.avatar = idx; broadcastRoom(r);
  });

  socket.on('set_ready', ({ ready })=>{
    const r = ensureDefaultRoom(); const p = r.players.get(socket.id); if (!p) return;
    p.ready = !!ready; broadcastRoom(r);
  });

  socket.on('chat', ({ message })=>{
    const r = ensureDefaultRoom();
    if (!r) return;
    if (r.phase === PHASE.GAME) return; // chat in lobby/board
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

  socket.on('input', ({ dir })=>{
    const r = ensureDefaultRoom(); if (r.phase !== PHASE.GAME) return;
    const p = r.players.get(socket.id); if (!p) return;
    const x = Number(dir?.x)||0, y=Number(dir?.y)||0; const len = Math.hypot(x,y)||1;
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
