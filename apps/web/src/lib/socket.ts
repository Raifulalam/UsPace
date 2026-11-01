import { io, Socket } from 'socket.io-client';
import { SOCKET_BASE, getToken } from './api';

// auth is a function so every (re)connect sends the CURRENT access token.
export function connectSocket(): Socket {
  return io(SOCKET_BASE, { auth: (cb) => cb({ token: getToken() }), transports: ['websocket'], withCredentials: true });
}
