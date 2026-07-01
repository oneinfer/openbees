import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { completeSSOLogin } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const token = searchParams.get('token');
    const requestedNext = searchParams.get('next') || '/organization';
    const next = requestedNext.startsWith('/') && !requestedNext.startsWith('//')
      ? requestedNext
      : '/organization';

    if (!token) {
      setError('No authentication token was received from the login service.');
      return;
    }

    completeSSOLogin(token)
      .then(() => navigate(next, { replace: true }))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Authentication failed. Please try again.');
      });
  }, [completeSSOLogin, navigate, searchParams]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-950 p-6 text-center">
        <p className="text-sm font-medium text-red-400">{error}</p>
        <a
          href="/"
          className="text-sm text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
        >
          Return to home
        </a>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm font-medium text-zinc-400">
      Completing sign-in…
    </div>
  );
}
