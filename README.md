# Medicart WebRTC signaling service

This service coordinates a doctor-browser peer and a Raspberry Pi peer. It only relays WebRTC setup messages (offer, answer, ICE); video and audio travel over the WebRTC connection, not through this Node server.

## Render settings

- New → Web Service → connect the GitHub repository containing this folder.
- Root Directory: `medicart-signaling` (upload this folder at the top level beside `index.html`).
- Runtime: Node.
- Build Command: `npm install`.
- Start Command: `npm start`.
- Add environment variables:
  - `JWT_SECRET`: random secret, at least 32 bytes.
  - `JWT_ISSUER`: `medicart-auth` (or your token issuer's exact issuer).
  - `JWT_AUDIENCE`: `medicart-webrtc`.
  - `ALLOWED_ORIGINS`: `https://medicartv2.vercel.app` (comma-separated if you have more trusted browser origins).

Render's service URL is used with `wss://SERVICE.onrender.com/signal?token=SHORT_LIVED_JWT`.

## Authentication contract

The server intentionally rejects unauthenticated connections. The JWT must be signed with HS256 using `JWT_SECRET`, and must contain `iss`, `aud`, `sub`, `role`, and `exp` claims.

- Doctor token: `role: "doctor"`, `sub: "doctor-id"`, and `cartIds: ["medicart-01"]` (the carts that doctor may call).
- Pi token: `role: "cart"`, `sub: "medicart-01"`.

The token issuer must be a trusted backend. Do not embed `JWT_SECRET` or long-lived tokens in `index.html`. Use short-lived doctor tokens from your authenticated login and a device token stored privately on the Pi. The current static dashboard has no login/token issuer, so it must be added before a doctor can connect.

## Signaling message protocol

After authenticating over WebSocket:

1. Doctor sends `{"type":"call.request","cartId":"medicart-01"}`.
2. Pi receives `call.incoming` with a server-generated `callId`. Play the announcement/countdown, then send `{"type":"call.accept","callId":"…"}` or `call.reject`.
3. Doctor sends `webrtc.offer` with `callId` and SDP.
4. Pi creates its WebRTC answer and sends `webrtc.answer` with the same `callId` and SDP.
5. Both sides forward each gathered ICE candidate as `webrtc.ice` with `callId` and `candidate`.
6. Either side can end the call with `call.end`.

Both endpoints must exchange messages in this format and use the same active `callId`. ICE server configuration (STUN/TURN) is configured in the browser and Pi WebRTC clients, not in this signaling process.

Health check: `https://SERVICE.onrender.com/health`.
