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
  scores: Map<id, { total:number, infections:number, survivalMs:number }>
}
Player = { id,name,avatar,ready,dir:{x,y},x,y,infected:boolean, round:{survivalMs:number,infections:number,isP0:boolean} }
*/

function code4() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:4},()=>cs[Math.random()*cs.length|0]).join('');
}
const clamp = (v,min,max)=> v<min?min:v>max?max:v;

function createRoom(hostSocket, name){
  const code = code4();
  const room = {
    code,
    hostId: hostSocket.id,
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
      boardMs: 6000,        // 6s leaderboard screen
      minPlayers: 3,
      points: {
        survivalPerSec: 1,      // 1 point per second alive
        perInfection: 25,       // +25 for each infection caused
        p0FullInfectBonus: 50   // +50 if patient zero infects everyone
      }
    },
    scores: new Map()
  };
  rooms.set(code, room);
  joinRoom(hostSocket, code, name || 'HOST');
}

function joinRoom(socket, code, name){
  const room = rooms.get(code);
  if (!room) { socket.emit('error_message','room_not_found'); return; }
  socket.join(room.code);
  const spawn = randomSpawn(room);
  room.players.set(socket.id, {
    id: socket.id,
    name: (name||'PLAYER').slice(0,16),
    avatar: 0,
    ready: false,
    dir: { x: 0, y: 0 },
    x: spawn.x, y: spawn.y,
    infected: false,
    round: { survivalMs:0, infections:0, isP0:false }
  });
  socket.emit('room_joined', { code: room.code, you: socket.id, host: room.hostId===socket.id });
  broadcastRoom(room);
}

function randomSpawn(room){
  return { x: Math.random() * (room.world.w - 80) + 40, y: Math.random() * (room.world.h - 80) + 40 };
}

/* ------------------------------- Rounds ------------------------------ */
function startGameSeries(room){
  room.totalRounds = Math.max(1, room.players.size * 2);
  room.round = 0;
  // init totals
  for (const id of room.players.keys()){
    if (!room.scores.has(id)) room.scores.set(id, { total:0, infections:0, survivalMs:0 });
  }
  startNextRound(room);
}

function startNextRound(room){
  room.round += 1;
  if (room.round > room.totalRounds){
    // Final leaderboard stays
    room.phase = PHASE.END;
    broadcastRoom(room);
    return;
  }
  // reset per-round
  room.exposure.clear();
  for (const p of room.players.values()){
    const s = randomSpawn(room);
    p.x = s.x; p.y = s.y;
    p.dir.x = 0; p.dir.y = 0;
    p.infected = false;
    p.round = { survivalMs: 0, infections: 0, isP0: false };
  }

  // pick patient zero for this round
  const ids = [...room.players.keys()];
  if (ids.length === 0) return;
  const p0 = ids[Math.random()*ids.length|0];
  const pz = room.players.get(p0);
  pz.infected = true;
  pz.round.isP0 = true;

  // role reveal to each
  for (const p of room.players.values()){
    io.to(p.id).emit('role', { role: p.round.isP0 ? 'PATIENT_ZERO' : 'CITIZEN' });
  }

  room.phase = PHASE.COUNTDOWN;
  room.countdownEndsAt = Date.now() + room.options.countdownMs;
  room.gameEndsAt = null;
  room.boardEndsAt = null;

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
  room.tick = setInterval(()=> tick(room, dtMs), dtMs);

  broadcastRoom(room);
}

function endRound(room, reason){
  room.phase = PHASE.LEADERBOARD;
  if (room.tick) { clearInterval(room.tick); room.tick = null; }
  room.countdownEndsAt = null;
  room.gameEndsAt = null;

  // compute per-round scores
  const everybodyInfected = [...room.players.values()].every(p=>p.infected);
  const board = [];
  for (const p of room.players.values()){
    const survSec = Math.floor(p.round.survivalMs / 1000);
    const fromSurv = survSec * room.options.points.survivalPerSec;
    const fromInf  = p.round.infections * room.options.points.perInfection;
    const bonus    = (p.round.isP0 && everybodyInfected) ? room.options.points.p0FullInfectBonus : 0;
    const roundScore = fromSurv + fromInf + bonus;

    // update totals
    const t = room.scores.get(p.id) || { total:0, infections:0, survivalMs:0 };
    t.total += roundScore;
    t.infections += p.round.infections;
    t.survivalMs += p.round.survivalMs;
    room.scores.set(p.id, t);

    board.push({
      id:p.id, name:p.name, avatar:p.avatar,
      survSec, infections:p.round.infections, bonus, roundScore,
      total: t.total
    });
  }
  // sort by roundScore desc, then total
  board.sort((a,b)=> b.roundScore - a.roundScore || b.total - a.total);

  // show leaderboard for a few seconds
  room.board = board;
  room.boardEndsAt = Date.now() + room.options.boardMs;

  broadcastRoom(room);
  setTimeout(()=> startNextRound(room), room.options.boardMs);
}

/* ------------------------------- Tick -------------------------------- */
function tick(room, dtMs){
  if (room.phase !== PHASE.GAME) return;
  const dt = dtMs / 1000;
  const speed = room.options.speed;

  // integrate positions + accumulate survival for healthy
  for (const p of room.players.values()){
    p.x = clamp(p.x + p.dir.x * speed * dt, 16, room.world.w-16);
    p.y = clamp(p.y + p.dir.y * speed * dt, 16, room.world.h-16);
    if (!p.infected) p.round.survivalMs += dtMs;
  }

  // infection proximity check
  const infected = [...room.players.values()].filter(p=>p.infected);
  const healthy  = [...room.players.values()].filter(p=>!p.infected);

  for (const h of healthy){
    // find nearest infected within radius
    let nearId = null, nearDist2 = Infinity;
    for (const z of infected){
      const dx = z.x - h.x, dy = z.y - h.y;
      const d2 = dx*dx + dy*dy;
      if (d2 <= room.options.radius * room.options.radius && d2 < nearDist2){
        nearDist2 = d2; nearId = z.id;
      }
    }
    if (nearId){
      const t = room.exposure.get(h.id) || 0;
      const nt = t + dtMs;
      if (nt >= room.options.infectMs){
        // convert and credit the nearest infected
        h.infected = true;
        room.exposure.delete(h.id);
        const src = room.players.get(nearId);
        if (src) src.round.infections += 1;
        io.to(room.code).emit('system_message', `infect:${h.name}`);
      } else {
        room.exposure.set(h.id, nt);
      }
    } else {
      room.exposure.delete(h.id);
    }
  }

  // win checks
  const everyoneInfected = [...room.players.values()].every(p=>p.infected);
  if (everyoneInfected) { endRound(room, 'all_infected'); return; }
  if (Date.now() >= room.gameEndsAt) { endRound(room, 'time_up'); return; }

  broadcastGame(room);
}

/* ------------------------------- Broadcasts -------------------------- */
function publicPlayers(room){
  return [...room.players.values()].map(p=>({
    id:p.id, name:p.name, avatar:p.avatar, ready:p.ready
  }));
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

/* ------------------------------- Sockets ----------------------------- */
io.on('connection', (socket)=>{
  socket.on('create_room', ({ name })=> createRoom(socket, name));
  socket.on('join_room', ({ code, name })=> joinRoom(socket, (code||'').toUpperCase(), name));

  socket.on('set_name', ({ code, name })=>{
    const r = rooms.get(code); if (!r) return;
    const p = r.players.get(socket.id); if (!p) return;
    p.name = String(name||'').slice(0,16) || p.name;
    broadcastRoom(r);
  });
  socket.on('set_avatar', ({ code, avatar })=>{
    const r = rooms.get(code); if (!r) return;
    const p = r.players.get(socket.id); if (!p) return;
    p.avatar = Math.max(0, Math.min(9, avatar|0));
    broadcastRoom(r);
  });
  socket.on('set_ready', ({ code, ready })=>{
    const r = rooms.get(code); if (!r) return;
    const p = r.players.get(socket.id); if (!p) return;
    p.ready = !!ready;
    broadcastRoom(r);
  });

  socket.on('chat', ({ code, message })=>{
    const r = rooms.get(code); if (!r || r.phase !== PHASE.LOBBY) return;
    const p = r.players.get(socket.id); if (!p) return;
    io.to(r.code).emit('chat_message', { from:p.name, text:String(message||'').slice(0,300) });
  });

  socket.on('start_game', ({ code })=>{
    const r = rooms.get(code); if (!r) return;
    if (socket.id !== r.hostId) return;
    const players = [...r.players.values()];
    const min = r.options.minPlayers;
    const allReady = players.length >= min && players.every(p=>p.ready);
    if (!allReady) return socket.emit('error_message','not_ready');
    startGameSeries(r);
  });

  // movement input: dir {x,y} normalized client-side
  socket.on('input', ({ code, dir })=>{
    const r = rooms.get(code); if (!r || r.phase !== PHASE.GAME) return;
    const p = r.players.get(socket.id); if (!p) return;
    const x = Number(dir?.x)||0, y=Number(dir?.y)||0;
    const len = Math.hypot(x,y) || 1;
    p.dir.x = x/len; p.dir.y = y/len;
  });

  socket.on('disconnect', ()=>{
    for (const r of rooms.values()){
      if (r.players.has(socket.id)){
        const wasHost = r.hostId === socket.id;
        r.players.delete(socket.id);
        r.exposure.delete(socket.id);
        if (wasHost){
          const next = r.players.keys().next().value;
          r.hostId = next || null;
          if (!next){
            if (r.tick) clearInterval(r.tick);
            rooms.delete(r.code);
            continue;
          }
        }
        // if in game and no players, cleanup
        if (r.phase !== PHASE.LOBBY && r.players.size === 0){
          if (r.tick) clearInterval(r.tick);
          rooms.delete(r.code);
          continue;
        }
        broadcastRoom(r);
      }
    }
  });
});
