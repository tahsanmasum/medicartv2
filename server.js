import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { jwtVerify } from 'jose';

const port = Number(process.env.PORT || 10000);
const secretText = process.env.JWT_SECRET;
const issuer = process.env.JWT_ISSUER || 'medicart-auth';
const audience = process.env.JWT_AUDIENCE || 'medicart-webrtc';
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://medicartv2.vercel.app')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
);

if (!secretText || Buffer.byteLength(secretText) < 32) {
  throw new Error('Set JWT_SECRET to a random secret of at least 32 bytes.');
}
const jwtSecret = new TextEncoder().encode(secretText);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
const carts = new Map();
const doctors = new Map();
const calls = new Map();
const busyCarts = new Map();

function send(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function endCall(callId, reason, notify = true) {
  const call = calls.get(callId);
  if (!call) return;
  clearTimeout(call.ringTimer);
  calls.delete(callId);
  busyCarts.delete(call.cartId);
  if (notify) {
    send(call.doctor, { type: 'call.ended', callId, reason });
    send(call.cart, { type: 'call.ended', callId, reason });
  }
}

function validCallPeer(call, ws) {
  return call && (call.doctor === ws || call.cart === ws);
}

async function authenticate(req) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) throw new Error('missing_token');
  const { payload } = await jwtVerify(token, jwtSecret, {
    algorithms: ['HS256'], issuer, audience,
    requiredClaims: ['sub', 'role', 'exp', 'iss', 'aud'],
  });
  if (payload.role !== 'doctor' && payload.role !== 'cart') throw new Error('invalid_role');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('invalid_subject');
  if (payload.role === 'doctor' && !Array.isArray(payload.cartIds)) throw new Error('missing_cart_scope');
  return payload;
}

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/signal') throw new Error('not_found');
    const origin = req.headers.origin;
    // Browsers send Origin; the Pi agent usually does not.
    if (origin && !allowedOrigins.has(origin)) throw new Error('origin_denied');
    const identity = await authenticate(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.identity = identity;
      wss.emit('connection', ws, req);
    });
  } catch (error) {
    const status = error.message === 'not_found' ? '404 Not Found' : '401 Unauthorized';
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const identity = ws.identity;
  const registry = identity.role === 'cart' ? carts : doctors;
  const id = identity.sub;
  const previous = registry.get(id);
  if (previous && previous !== ws) previous.close(4001, 'replaced_by_new_connection');
  registry.set(id, ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  send(ws, { type: 'connected', role: identity.role, id });

  if (identity.role === 'doctor') {
    for (const cartId of identity.cartIds) {
      send(ws, { type: 'cart.status', cartId, online: carts.has(cartId) });
    }
  } else {
    for (const doctor of doctors.values()) {
      if (doctor.identity.cartIds.includes(id)) send(doctor, { type: 'cart.status', cartId: id, online: true });
    }
  }

  ws.on('message', (buffer) => {
    let message;
    try { message = JSON.parse(buffer.toString()); }
    catch { send(ws, { type: 'error', code: 'invalid_json' }); return; }
    if (!message || typeof message.type !== 'string') {
      send(ws, { type: 'error', code: 'invalid_message' });
      return;
    }

    if (identity.role === 'doctor' && message.type === 'call.request') {
      const cartId = message.cartId;
      if (typeof cartId !== 'string' || !identity.cartIds.includes(cartId)) {
        send(ws, { type: 'error', code: 'cart_not_authorized' });
        return;
      }
      const cart = carts.get(cartId);
      if (!cart) { send(ws, { type: 'call.failed', code: 'cart_offline' }); return; }
      if (busyCarts.has(cartId)) { send(ws, { type: 'call.failed', code: 'cart_busy' }); return; }
      const callId = randomUUID();
      const call = { callId, cartId, doctorId: id, doctor: ws, cart, state: 'ringing' };
      calls.set(callId, call);
      busyCarts.set(cartId, callId);
      send(ws, { type: 'call.ringing', callId, cartId });
      send(cart, { type: 'call.incoming', callId, doctorId: id });
      call.ringTimer = setTimeout(() => {
        send(ws, { type: 'call.failed', callId, code: 'ring_timeout' });
        send(cart, { type: 'call.ended', callId, reason: 'ring_timeout' });
        endCall(callId, 'ring_timeout', false);
      }, 30_000);
      return;
    }

    const callId = message.callId;
    const call = typeof callId === 'string' ? calls.get(callId) : undefined;
    if (!validCallPeer(call, ws)) { send(ws, { type: 'error', code: 'call_not_found' }); return; }

    if (message.type === 'call.accept' && identity.role === 'cart' && call.state === 'ringing') {
      clearTimeout(call.ringTimer);
      call.state = 'connecting';
      send(call.doctor, { type: 'call.accepted', callId });
      return;
    }
    if (message.type === 'call.reject' && identity.role === 'cart' && call.state === 'ringing') {
      send(call.doctor, { type: 'call.rejected', callId });
      endCall(callId, 'rejected', false);
      return;
    }
    if (message.type === 'webrtc.offer' && identity.role === 'doctor' && call.state === 'connecting') {
      if (typeof message.sdp !== 'string' || message.sdp.length > 100_000) {
        send(ws, { type: 'error', code: 'invalid_sdp' }); return;
      }
      send(call.cart, { type: message.type, callId, sdp: message.sdp });
      return;
    }
    if (message.type === 'webrtc.answer' && identity.role === 'cart' && call.state === 'connecting') {
      if (typeof message.sdp !== 'string' || message.sdp.length > 100_000) {
        send(ws, { type: 'error', code: 'invalid_sdp' }); return;
      }
      send(call.doctor, { type: message.type, callId, sdp: message.sdp });
      return;
    }
    if (message.type === 'webrtc.ice' && call.state === 'connecting') {
      if (message.candidate !== null && typeof message.candidate !== 'object') {
        send(ws, { type: 'error', code: 'invalid_ice_candidate' }); return;
      }
      send(ws === call.doctor ? call.cart : call.doctor,
        { type: message.type, callId, candidate: message.candidate });
      return;
    }
    if (message.type === 'call.end') {
      endCall(callId, 'ended');
      return;
    }
    send(ws, { type: 'error', code: 'message_not_allowed' });
  });

  ws.on('close', () => {
    if (registry.get(id) === ws) registry.delete(id);
    if (identity.role === 'cart') {
      for (const doctor of doctors.values()) {
        if (doctor.identity.cartIds.includes(id)) send(doctor, { type: 'cart.status', cartId: id, online: false });
      }
    }
    for (const [callId, call] of calls) {
      if (call.doctor === ws || call.cart === ws) endCall(callId, 'connection_lost');
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

server.listen(port, '0.0.0.0', () => {
  console.log(`Medicart signaling server listening on port ${port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const callId of calls.keys()) endCall(callId, 'server_shutdown');
  for (const ws of wss.clients) ws.close(1001, 'server_shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
