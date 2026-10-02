import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { verifyToken } from './tokens.js';
import { logger } from './logger.js';

let io = null;

export function initSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: env.corsOrigins, credentials: true } });
  io.use((socket, next) => {
    try {
      socket.user = verifyToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    logger.debug({ user: socket.user.sub }, 'socket connected');
  });
  return io;
}

/** Broadcast a real-time event to every signed-in dashboard. A no-op when sockets are not running (tests). */
export function emit(event, payload) {
  io?.emit(event, payload);
}

export function closeSocket() {
  return new Promise((resolve) => (io ? io.close(() => resolve()) : resolve()));
}
