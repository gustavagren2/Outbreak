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
const PHASE = { LOBBY:'LOBBY', COUNTDOWN:'COUNTDOWN', GAME:'GAME', END:'END' };

const rooms = new Map();
/*
room = {
  code, hostId, phase,
  players: Map<id, {id,name,avatar,ready,dir:{x,y},x,y,infected:boolean}>,
  countdownEndsAt?: number,
  gameEndsAt?: number,
  tick?: NodeJS.Timer,
  exposure: Map<victimId, number>, // ms accumulated near infected
  world: { w:number, h:number },
  options: { speed:number, radius:number, infectMs:number, durationMs:number, countdownMs:number }
}
*/

function code4() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:4},()=>cs[Math.random()*cs.length|0]).join('');
}

function clamp(v,min,max){ return v<min?min:v>max?max:v; }

function createRoom(hostSocket, name){
  const code = code4();
  const room = {
    code,
    hostId: hostSocket.id,
    phase: PHASE.LOBBY,
    players: new Map(),
    exposure: new Map(),
    world: { w: 1100, h: 620 },
    options: {
      speed: 180,        // px/s
      radius: 36,        // proximity radius
      infectMs: 1000,    // time within radius to convert
      durationMs: 90_000,
      countdownMs: 10_000
    }
  };
  rooms.set(code, room);
  joinRoom(hostSocket, code, name || 'HOST');
}

function joinRoom(socket, code, name){
  const room = rooms.get(code);
  if (!room) { socket.emit('error_message','room_not_found'); return; }
  socket.join(room.code);
  const spawn = {
    x: Math.random() * (room.world.w - 80) + 40,
    y: Math.random() * (room.world.h - 80) + 40
  };
  room.players.set(socket.id, {
    id: socket.id,
    name: (name||'PLAYER').slice(0,16),
    avatar: 0,
    ready: false,
    dir: { x: 0, y: 0 },
    x: spawn.x, y: spawn.y,
    infected: false
  });
  socket.emit('room_joined', { code: room.code, you: socket.id, host: room.hostId===socket.id });
  broadcastRoom(room);
}

function broadcastRoom(room){
  const players = [...room.players.values()].map(p=>({
    id:p.id, name:p.name, avatar:p.avatar, ready:p.ready, infected:p.infected
  }));
  io.to(room.code).emit('room_state', {
    code: room.code,
    phase: room.phase,
    players,
    countdownEndsAt: room.countdownEndsAt || null,
    gameEndsAt: room.gameEndsAt || null,
    world: room.world
  });
}

function broadcastGame(room){
  const positions = [...room.players.values()].map(p=>({ id:p.id, x:p.x, y:p.y, infected:p.infected }));
  io.to(room.code).emit('game_state', {
    phase: room.phase,
    positions,
    countdownEndsAt: room.countdownEndsAt || null,
    gameEndsAt: room.gameEndsAt || null
  });
}

function startCountdown(room){
  room.phase = PHASE.COUNTDOWN;
  // pick patient zero
  const ids = [...room.players.keys()];
  const p0 = ids[Math.random()*ids.length|0];
  room.players.get(p0).infected = true;

  // role reveal
  for (const p of room.players.values()){
    io.to(p.id).emit('role', { role: p.infected ? 'PATIENT_ZERO' : 'CITIZEN' });
  }

  room.countdownEndsAt = Date.now() + room.options.countdownMs;
  setTimeout(()=> startGame(room), room.options.countdownMs);
  broadcastRoom(room);
}

function startGame(room){
  if (room.phase !== PHASE.COUNTDOWN) return;
  room.phase = PHASE.GAME;
  room.gameEndsAt = Date.now() + room.options.durationMs;
  room.countdownEndsAt = null;

  // start tick loop (20 Hz)
  if (room.tick) clearInterval(room.tick);
  const dtMs = 50;
  room.tick = setInterval(()=> tick(room, dtMs), dtMs);

  broadcastRoom(room);
}

function endGame(room, reason){
  room.phase = PHASE.END;
  room.countdownEndsAt = null;
  room.gameEndsAt = null;
  if (room.tick) { clearInterval(room.tick); room.tick = null; }
  io.to(room.code).emit('system_message', reason || 'game_over');
  broadcastRoom(room);
}

function allInfected(room){
  for (const p of room.players.values()) if (!p.infected) return false;
  return true;
}

function tick(room, dtMs){
  if (room.phase !== PHASE.GAME) return;
  const dt = dtMs / 1000;
  const speed = room.options.speed;

  // integrate
  for (const p of room.players.values()){
    p.x = clamp(p.x + p.dir.x * speed * dt, 16, room.world.w-16);
    p.y = clamp(p.y + p.dir.y * speed * dt, 16, room.world.h-16);
  }

  // infection proximity
  const infected = [...room.players.values()].filter(p=>p.infected);
  const healthy  = [...room.players.values()].filter(p=>!p.infected);

  for (const h of healthy){
    let near = false;
    for (const z of infected){
      const dx = z.x - h.x, dy = z.y - h.y;
      if ((dx*dx + dy*dy) <= room.options.radius * room.options.radius){
        near = true; break;
      }
    }
    if (near){
      const t = room.exposure.get(h.id) || 0;
      const nt = t + dtMs;
      if (nt >= room.options.infectMs){
        h.infected = true;
        room.exposure.delete(h.id);
        io.to(room.code).emit('system_message', `infect:${h.name}`);
      } else {
        room.exposure.set(h.id, nt);
      }
    } else {
      room.exposure.delete(h.id);
    }
  }

  // win checks
  if (allInfected(room)) { endGame(room, 'murderer_win'); return; }
  if (Date.now() >= room.gameEndsAt) { endGame(room, 'citizens_win'); return; }

  broadcastGame(room);
}

/* ----------------------------- Sockets ----------------------------- */
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
    const min = 3; // tweak if you want 4
    const allReady = players.length >= min && players.every(p=>p.ready);
    if (!allReady) return socket.emit('error_message','not_ready');
    startCountdown(r);
  });

  // movement input: dir {x,y} normalized clientside
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
        if (r.phase === PHASE.GAME && r.players.size === 0){
          if (r.tick) clearInterval(r.tick);
          rooms.delete(r.code);
          continue;
        }
        broadcastRoom(r);
      }
    }
  });
});
