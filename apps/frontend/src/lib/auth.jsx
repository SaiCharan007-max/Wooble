import { createContext, useContext, useMemo, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import { disconnectSocket } from './live.js';

const AuthContext = createContext(null);
const USER_KEY = 'homeward.user';

function loadUser() {
  try {
    return getToken() ? JSON.parse(localStorage.getItem(USER_KEY)) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(loadUser);
  const value = useMemo(() => ({
    user,
    async login(email, password) {
      const res = await api('/auth/login', { method: 'POST', body: { email, password } });
      setToken(res.token);
      try { localStorage.setItem(USER_KEY, JSON.stringify(res.user)); } catch { /* ignore */ }
      setUser(res.user);
    },
    logout() {
      setToken(null);
      disconnectSocket();
      setUser(null);
    },
  }), [user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
