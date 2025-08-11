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
const PHASE = { LOBBY:'LOBBY', COUNTDOWN:'COUNTDOWN', GAME:'GAME', LEADERBOARD:'LEADERBOARD', END:'END' };
const DEFAULT_CODE = 'ROOM'; // Single shared room for everyone

const rooms = new Map();
/*
room = {
  code, hostId,
  phase, round, totalRounds,
  players: Map<id, Player>,
  countdownEndsAt?, gameEndsAt?, boardEndsAt?,
  tick?,
  exposure: Map<victimId, ms>,
  world: { w,h },
  options: { speed, radius, infectMs, roundMs, countdownMs, boardMs, minPlayers, points:{survivalPerSec, perInfection, p0FullInfectBonus} },
  scores: Map<id, { total:number, infections:number, survivalMs:number }>,
  board?: Array
}
Player = { id,name,avatar,ready,dir:{x,y},x,y,infected:boolean, round:{survivalMs:number,infections:number,isP0:boolean} }
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
    exposure: new Map(),
    world: { w: 1100, h: 620 },
    options: {
      speed: 180,           // px/s
      radius: 36,           // proximity radius
      infectMs: 1000,       // ms within radius to convert
      roundMs: 90_000,      // 90s per round
      countdownMs: 10_000,  // 10s reveal
      boardMs: 6000,        // 6s leaderboard screen (between rounds)
      minPlayers: 3,
      points: {
        survivalPerSec: 1,      // +1 per second alive
        perInfection: 25,       // +25 per infection caused
        p0FullInfectBonus: 50   // +50 if Patient Zero infects everyone
      }
    },
    scores: new Map()
  };
  rooms.set(DEFAULT_CODE, room);
  return room;
}

function randomSpawn(room){
  return { x: Math.random() * (room.world.w - 80) + 40, y: Math.random() * (room.world.h - 80) + 40 };
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
  const positions = [...room.players.values()].map(p=>({ id:p.id, x:p.x, y:p.y, infected:p.infected, avatar:p.avatar }));
  io.to(room.code).emit('game_state', {
    phase: room.phase,
    positions,
    round: room.round,
    totalRounds: room.totalRounds,
    gameEndsAt: room.gameEndsAt || null
  });
}

/* ------------------------------- Rounds ------------------------------ */
function startGameSeries(room){
  room.totalRounds = Math.max(1, room.players.size * 2);
  room.round = 0;
  for (const id of room.players.keys()){
    if (!room.scores.has(id)) room.scores.set(id, { total:0, infections:0, survivalMs:0 });
  }
  startNextRound(room);
}

function startNextRound(room){
  room.round += 1;

  // reset per-round state
  room.exposure.clear();
  for (const p of room.players.values()){
    const s = randomSpawn(room);
    p.x = s.x; p.y = s.y;
    p.dir.x = 0; p.dir.y = 0;
    p.infected = false;
    p.round = { survivalMs:0, infections:0, isP0:false };
  }

  // pick patient zero
  const ids = [...room.players.keys()];
  if (ids.length === 0) return;
  const p0 = ids[Math.random()*ids.length|0];
  const pz = room.players.get(p0);
  pz.infected = true; pz.round.isP0 = true;

  // role reveal per player
  for (const p of room.players.values()){
    io.to(p.id).emit('role', { role: p.round.isP0 ? 'PATIENT_ZERO' : 'CITIZEN' });
  }

  room.phase = PHASE.COUNTDOWN;
  room.countdownEndsAt = Date.now() + room.options.countdownMs;
  room.gameEndsAt = null; room.boardEndsAt = null;

  setTimeout(()=> startRoundPlay(room), room.options.countdownMs);
  broadcastRoom(room);
}

function startRoundPlay(room){
  if (room.phase !== PHASE.COUNTDOWN) return;
  room.phase = PHASE.GAME;
  room.gameEndsAt = Date.now() + room.options.roundMs;
  room.countdownEndsAt = null;

  if (room.tick) clearInterval(room.tick);
  const dtMs = 50; // 20Hz
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

  // If final round, keep leaderboard up indefinitely
  if (room.round >= room.totalRounds){
    room.boardEndsAt = null;
    broadcastRoom(room);
    return;
  }

  // Otherwise show for a few seconds, then go next round
  room.boardEndsAt = Date.now() + room.options.boardMs;
  broadcastRoom(room);
  setTimeout(()=> startNextRound(room), room.options.boardMs);
}

/* -------------------------------- Tick ------------------------------- */
function tick(room, dtMs){
  if (room.phase !== PHASE.GAME) return;
  const dt = dtMs/1000, speed = room.options.speed;

  // integrate + survival accumulation
  for (const p of room.players.values()){
    p.x = clamp(p.x + p.dir.x * speed * dt, 16, room.world.w-16);
    p.y = clamp(p.y + p.dir.y * speed * dt, 16, room.world.h-16);
    if (!p.infected) p.round.survivalMs += dtMs;
  }

  // infection proximity check
  const infected = [...room.players.values()].filter(p=>p.infected);
  const healthy  = [...room.players.values()].filter(p=>!p.infected);

  for (const h of healthy){
    let nearId = null, nearDist2 = Infinity;
    for (const z of infected){
      const dx = z.x - h.x, dy = z.y - h.y, d2 = dx*dx + dy*dy;
      if (d2 <= room.options.radius*room.options.radius && d2 < nearDist2){ nearDist2 = d2; nearId = z.id; }
    }
    if (nearId){
      const t = room.exposure.get(h.id) || 0, nt = t + dtMs;
      if (nt >= room.options.infectMs){
        h.infected = true; room.exposure.delete(h.id);
        const src = room.players.get(nearId); if (src) src.round.infections += 1;
        io.to(room.code).emit('system_message', `infect:${h.name}`);
      } else room.exposure.set(h.id, nt);
    } else room.exposure.delete(h.id);
  }

  // round end?
  const everyoneInfected = [...room.players.values()].every(p=>p.infected);
  if (everyoneInfected) { endRound(room); return; }
  if (Date.now() >= room.gameEndsAt) { endRound(room); return; }

  broadcastGame(room);
}

/* ------------------------------ Sockets ------------------------------ */
io.on('connection', (socket)=>{
  // Everyone joins the single shared room.
  const room = ensureDefaultRoom();
  socket.join(room.code);

  // Add player
  const spawn = randomSpawn(room);
  room.players.set(socket.id, {
    id: socket.id, name: 'PLAYER', avatar: 0, ready: false,
    dir:{x:0,y:0}, x:spawn.x, y:spawn.y, infected:false,
    round:{survivalMs:0,infections:0,isP0:false}
  });
  if (!room.hostId) room.hostId = socket.id; // first becomes host

  socket.emit('room_joined', { code: room.code, you: socket.id, host: room.hostId===socket.id });
  sendRoomStateTo(socket.id, room);   // immediate snapshot for this client
  broadcastRoom(room);                // broadcast update for everyone else

  socket.on('set_name', ({ name })=>{
    const r = ensureDefaultRoom(); const p = r.players.get(socket.id); if (!p) return;
    p.name = String(name||'').slice(0,16) || p.name; broadcastRoom(r);
  });
  socket.on('set_avatar', ({ avatar })=>{
    const r = ensureDefaultRoom(); const p = r.players.get(socket.id); if (!p) return;
    p.avatar = Math.max(0, Math.min(9, avatar|0)); broadcastRoom(r);
  });
  socket.on('set_ready', ({ ready })=>{
    const r = ensureDefaultRoom(); const p = r.players.get(socket.id); if (!p) return;
    p.ready = !!ready; broadcastRoom(r);
  });
  socket.on('chat', ({ message })=>{
    const r = ensureDefaultRoom(); if (r.phase !== PHASE.LOBBY) return;
    const p = r.players.get(socket.id); if (!p) return;
    io.to(r.code).emit('chat_message', { from:p.name, text:String(message||'').slice(0,300) });
  });
  socket.on('start_game', ()=>{
    const r = ensureDefaultRoom(); if (socket.id !== r.hostId) return;
    const players = [...r.players.values()];
    const min = r.options.minPlayers;
    const allReady = players.length >= min && players.every(p=>p.ready);
    if (!allReady) return socket.emit('error_message','not_ready');
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
    r.exposure.delete(socket.id);
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
