import { useState, type FormEvent } from 'react';
import { t } from '../core/i18n';

/** Whether this browser already carries the login cookie. A proxy from before logins has no such route and guards nothing. */
export async function fetchAuthed(): Promise<boolean> {
  const res = await fetch('/api/auth');
  if (res.status === 404) return true;
  if (!res.ok) throw new Error(`auth ${res.status}`);
  return (await res.json()).authed === true;
}

async function login(password: string): Promise<boolean> {
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!res.ok && res.status !== 401) throw new Error(`login ${res.status}`);
  return res.ok;
}

export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (await login(password)) onAuthed();
      else setWrong(true);
    } catch {
      setWrong(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-sm px-4 pt-16">
      <form onSubmit={submit} className={`toy pop-in flex flex-col gap-4 p-6 ${wrong ? 'shake' : ''}`}>
        <div>
          <h1 className="text-2xl font-bold">🔐 {t('login.title')}</h1>
          <p className="mt-1 text-sm opacity-70">{t('login.hint')}</p>
        </div>
        <input
          className="field"
          type="password"
          autoFocus
          autoComplete="current-password"
          aria-label={t('login.password')}
          aria-invalid={wrong}
          placeholder={t('login.password')}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setWrong(false);
          }}
        />
        {wrong && (
          <p className="text-sm font-semibold text-pink" role="alert">
            {t('login.wrong')}
          </p>
        )}
        <button type="submit" className="btn bg-mint text-lg" disabled={busy || !password}>
          {t('login.enter')}
        </button>
      </form>
    </main>
  );
}
