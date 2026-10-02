import { DISCLAIMER } from '@homecare/shared';
import { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { connectSocket, useConnected } from '../lib/live.js';

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const connected = useConnected();
  useEffect(() => {
    connectSocket();
  }, []);

  const link = ({ isActive }) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-sky-50 text-sky-800' : 'text-slate-600 hover:text-slate-900'}`;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-sky-700 text-lg font-bold text-white" aria-hidden>+</div>
            <div>
              <div className="text-lg font-bold leading-tight">HomeWard</div>
              <div className="text-xs text-slate-500">Smart home-care monitoring</div>
            </div>
            <nav className="ml-4 flex gap-1">
              <NavLink to="/" end className={link}>Dashboard</NavLink>
              <NavLink to="/audit" className={link}>Audit log</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className={`flex items-center gap-1.5 ${connected ? 'text-emerald-700' : 'text-amber-700'}`}>
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {connected ? 'Live' : 'Reconnecting…'}
            </span>
            <span className="text-slate-600">{user.name} · <span className="text-slate-400">{user.role}</span></span>
            <button className="btn" onClick={() => { logout(); navigate('/login'); }}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">{children}</main>
      <footer className="border-t border-slate-200 bg-white px-4 py-2 text-center text-xs text-slate-500">
        ⚠ {DISCLAIMER}
      </footer>
    </div>
  );
}
