import { io, Socket } from 'socket.io-client';
import { API_BASE, getToken } from './api';

// auth is a function so every (re)connect sends the CURRENT access token.
export function connectSocket(): Socket {
  return io(API_BASE, { auth: (cb) => cb({ token: getToken() }), transports: ['websocket'], withCredentials: true });
}
