import { DISCLAIMER } from '@homecare/shared';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

const DEMO = [
  ['Caregiver (Anita)', 'anita@homecare.demo', 'Care@123'],
  ['Admin', 'admin@homecare.demo', 'Admin@123'],
];

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/" replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-sky-700 text-2xl font-bold text-white">+</div>
          <h1 className="text-2xl font-bold">HomeWard</h1>
          <p className="text-sm text-slate-500">A small, always-aware hospital ward for the home</p>
        </div>
        <form onSubmit={submit} className="card space-y-3 p-5">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" required autoComplete="username" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" type="password" required autoComplete="current-password" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
          <button className="btn btn-primary w-full py-2" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <div className="border-t border-slate-100 pt-3">
            <div className="label mb-2">Demo accounts</div>
            <div className="flex gap-2">
              {DEMO.map(([label, e, p]) => (
                <button key={e} type="button" className="btn flex-1 text-xs" onClick={() => { setEmail(e); setPassword(p); }}>{label}</button>
              ))}
            </div>
          </div>
        </form>
        <p className="mt-4 text-center text-xs text-slate-500">{DISCLAIMER}</p>
      </div>
    </div>
  );
}
