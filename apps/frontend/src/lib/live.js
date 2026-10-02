// Real-time updates over Socket.IO, with a tiny subscription hook for components.
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { getToken } from './api.js';

let socket = null;
const statusListeners = new Set();

export function connectSocket() {
  if (socket) return socket;
  socket = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
  const notify = () => statusListeners.forEach((fn) => fn(socket.connected));
  socket.on('connect', notify);
  socket.on('disconnect', notify);
  socket.on('connect_error', notify);
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function useConnected() {
  const [connected, setConnected] = useState(Boolean(socket?.connected));
  useEffect(() => {
    statusListeners.add(setConnected);
    return () => statusListeners.delete(setConnected);
  }, []);
  return connected;
}

/** Subscribe to socket events. The handler always sees the latest props/state. */
export function useLive(events, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  const key = events.join(',');
  useEffect(() => {
    const s = connectSocket();
    const listeners = events.map((e) => [e, (payload) => ref.current(e, payload)]);
    listeners.forEach(([e, fn]) => s.on(e, fn));
    return () => listeners.forEach(([e, fn]) => s.off(e, fn));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Re-run `load` (debounced) whenever one of the events fires. */
export function useLiveReload(events, load, delay = 400) {
  const timer = useRef(null);
  useLive(events, () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, delay);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
}
