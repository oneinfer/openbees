import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  type DeveloperProfile,
  clearAuthSession,
  getStoredAccessToken,
  getStoredRefreshToken,
  hasAuthSessionCookie,
  storeAuthSession,
} from '../lib/auth-storage';
import {
  type DeveloperRegisterPayload,
  type RegistrationCheckResponse,
  fetchCurrentDeveloper,
  loginWithGoogle,
  loginWithOtp,
  logoutAuth,
  recordDeveloperConsent,
  registerDeveloper,
  refreshAuth,
  sendOtp,
  verifyEmailOtp,
  exchangeSSOToken,
  type AuthResponse,
  verifyDeveloperRegistration,
  decodeJwtPayload,
} from '../lib/auth-api';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';
type DeveloperRegistrationInput = Omit<DeveloperRegisterPayload, 'verification_token'>;

interface AuthContextValue {
  status: AuthStatus;
  developer: DeveloperProfile | null;
  accessToken: string | null;
  checkRegistration: (email: string) => Promise<RegistrationCheckResponse>;
  completeRegistration: (payload: DeveloperRegistrationInput) => Promise<void>;
  requestOtp: (email: string, purpose?: 'login' | 'signup') => Promise<void>;
  verifySignupOtp: (email: string, otp: string) => Promise<void>;
  completeOtpLogin: (email: string, otp: string) => Promise<void>;
  completeGoogleLogin: (clientId: string, credential: string, selectBy?: string) => Promise<void>;
  completeSSOLogin: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

type RestoreResult =
  | { kind: 'none' }
  | { kind: 'current'; developer: DeveloperProfile }
  | { kind: 'refreshed'; response: AuthResponse };

let startupRestorePromise: Promise<RestoreResult> | null = null;

function developerFromAuthResponse(response: AuthResponse): DeveloperProfile {
  return {
    developer_id: response.developer_id,
    email: response.email,
    first_name: response.first_name,
    last_name: response.last_name,
  };
}

async function restoreAuthSession(): Promise<RestoreResult> {
  if (!hasAuthSessionCookie()) return { kind: 'none' };

  try {
    return { kind: 'current', developer: await fetchCurrentDeveloper() };
  } catch {
    return { kind: 'refreshed', response: await refreshAuth(getStoredRefreshToken()) };
  }
}

function restoreAuthSessionOnce(): Promise<RestoreResult> {
  startupRestorePromise ??= restoreAuthSession().finally(() => {
    startupRestorePromise = null;
  });
  return startupRestorePromise;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [developer, setDeveloper] = useState<DeveloperProfile | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [signupVerificationToken, setSignupVerificationToken] = useState<string | null>(null);

  const applySession = useCallback((response: AuthResponse) => {
    const nextDeveloper = developerFromAuthResponse(response);
    storeAuthSession(response.access_token, response.refresh_token, nextDeveloper);
    setDeveloper(nextDeveloper);
    setAccessToken(response.access_token ?? getStoredAccessToken() ?? 'cookie');
    setSignupVerificationToken(null);
    setStatus('authenticated');
  }, []);

  const clearLocalAuthState = useCallback(() => {
    clearAuthSession();
    setDeveloper(null);
    setAccessToken(null);
    setStatus('unauthenticated');
  }, []);

  const logout = useCallback(() => {
    void logoutAuth().catch(() => undefined);
    clearLocalAuthState();
  }, [clearLocalAuthState]);

  // Proactive token refresh — fires 5 minutes before the access token expires so
  // the user never hits a 401 due to expiry. Re-schedules automatically after each
  // successful refresh (because accessToken state changes, re-running this effect).
  useEffect(() => {
    if (status !== 'authenticated') return;

    const token = (accessToken && accessToken !== 'cookie') ? accessToken : getStoredAccessToken();
    let delayMs = 55 * 60 * 1000; // fallback: 55 min (for cookie-only tokens)

    if (token) {
      const payload = decodeJwtPayload(token);
      const exp = typeof payload.exp === 'number' ? payload.exp : null;
      if (exp) {
        const secsUntilExpiry = exp - Date.now() / 1000;
        delayMs = Math.max(30_000, (secsUntilExpiry - 5 * 60) * 1000);
      }
    }

    const timerId = window.setTimeout(async () => {
      try {
        const response = await refreshAuth();
        applySession(response);
      } catch {
        clearLocalAuthState();
      }
    }, delayMs);

    return () => window.clearTimeout(timerId);
  }, [status, accessToken, applySession, clearLocalAuthState]);

  useEffect(() => {
    let cancelled = false;

    async function restore() {
      try {
        const restored = await restoreAuthSessionOnce();
        if (cancelled) return;
        if (restored.kind === 'current') {
          setDeveloper(restored.developer);
          setAccessToken(getStoredAccessToken() ?? 'cookie');
          setStatus('authenticated');
          return;
        }
        if (restored.kind === 'refreshed') {
          applySession(restored.response);
          return;
        }
        clearLocalAuthState();
      } catch {
        if (!cancelled) clearLocalAuthState();
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [applySession, clearLocalAuthState]);

  const value = useMemo<AuthContextValue>(() => ({
    status,
    developer,
    accessToken,
    checkRegistration: async (email) => {
      return verifyDeveloperRegistration(email);
    },
    completeRegistration: async (payload) => {
      if (!signupVerificationToken) throw new Error('Email verification is required.');
      await recordDeveloperConsent(payload.email);
      applySession(await registerDeveloper({ ...payload, verification_token: signupVerificationToken }));
    },
    requestOtp: async (email, purpose = 'login') => {
      await sendOtp(email, purpose);
    },
    verifySignupOtp: async (email, otp) => {
      const response = await verifyEmailOtp(email, otp, 'signup');
      if (!response.is_verified) {
        throw new Error(response.message || 'Invalid verification code.');
      }
      if (!response.verification_token) throw new Error('Verification token was not returned.');
      setSignupVerificationToken(response.verification_token);
    },
    completeOtpLogin: async (email, otp) => {
      applySession(await loginWithOtp(email, otp));
    },
    completeGoogleLogin: async (clientId, credential, selectBy) => {
      applySession(await loginWithGoogle(clientId, credential, selectBy));
    },
    completeSSOLogin: async (token) => {
      applySession(await exchangeSSOToken(token));
    },
    logout,
  }), [accessToken, applySession, developer, logout, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
