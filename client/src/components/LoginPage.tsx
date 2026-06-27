import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, LogIn, Mail, RotateCcw } from 'lucide-react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  fetchAuthConfig,
  getEmailFromGoogleCredential,
  type Designation,
  type OrganizationType,
} from '../lib/auth-api';

type GoogleCredentialResponse = {
  credential?: string;
  select_by?: string;
};

type LoginStep = 'email' | 'login-otp' | 'signup-otp' | 'signup';
type SubmitAction = 'registration-check' | 'otp-send' | 'otp-login' | 'otp-verify' | 'google' | 'signup';

type SignupForm = {
  first_name: string;
  last_name: string;
  dob: string;
  organization_type: '' | OrganizationType;
  organization_name: string;
  designation: '' | Designation;
  consent: boolean;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (options: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
          }) => void;
          renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const emptySignupForm: SignupForm = {
  first_name: '',
  last_name: '',
  dob: '',
  organization_type: '',
  organization_name: '',
  designation: '',
  consent: false,
};

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getAdultDobMaxDate(): Date {
  const today = new Date();
  return new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
}

function parseDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function loadGoogleIdentityScript(): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
  if (existing) {
    if (window.google?.accounts?.id) return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load Google login.')), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google login.'));
    document.head.appendChild(script);
  });
}

export function LoginPage() {
  const location = useLocation();
  const {
    status,
    checkRegistration,
    requestOtp,
    verifySignupOtp,
    completeOtpLogin,
    completeGoogleLogin,
    completeRegistration,
  } = useAuth();
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const renderedGoogleButtonRef = useRef(false);
  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [step, setStep] = useState<LoginStep>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [signupForm, setSignupForm] = useState<SignupForm>(emptySignupForm);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [googleConfigLoaded, setGoogleConfigLoaded] = useState(false);
  const [googleConfigError, setGoogleConfigError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<SubmitAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const adultDobMaxDate = getAdultDobMaxDate();
  const adultDobMax = formatDateInputValue(adultDobMaxDate);
  const isOtpStep = step === 'login-otp' || step === 'signup-otp';

  const redirectTo = typeof location.state === 'object'
    && location.state
    && 'from' in location.state
    && typeof location.state.from === 'string'
    ? location.state.from
    : '/';

  useEffect(() => {
    let cancelled = false;
    fetchAuthConfig()
      .then((config) => {
        if (cancelled) return;
        setGoogleClientId(config.google_client_id?.trim() || null);
        setGoogleConfigError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setGoogleClientId(null);
        setGoogleConfigError(
          'Authentication config is unavailable. Ensure the server is running and GOOGLE_CLIENT_ID is set.',
        );
      })
      .finally(() => {
        if (!cancelled) setGoogleConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!googleClientId || !googleButtonRef.current || renderedGoogleButtonRef.current) return;
    let cancelled = false;

    loadGoogleIdentityScript()
      .then(() => {
        if (cancelled || !googleButtonRef.current || !window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response) => {
            if (!response.credential) {
              setError('Google did not return a credential.');
              return;
            }

            const googleEmail = getEmailFromGoogleCredential(response.credential);
            setSubmitting('google');
            setError(null);
            try {
              await completeGoogleLogin(googleClientId, response.credential, response.select_by);
            } catch (err) {
              if (googleEmail) {
                try {
                  const registration = await checkRegistration(googleEmail);
                  if (!registration.is_registered) {
                    setEmail(googleEmail);
                    setSignupForm(emptySignupForm);
                    setOtp('');
                    await requestOtp(googleEmail, 'signup');
                    setResendCooldown(45);
                    setStep('signup-otp');
                    return;
                  }
                } catch {
                  // Keep the original Google error when the fallback check also fails.
                }
              }
              setError(err instanceof Error ? err.message : 'Google login failed.');
            } finally {
              setSubmitting(null);
            }
          },
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          width: Math.min(400, googleButtonRef.current.clientWidth || 400),
          text: 'continue_with',
        });
        renderedGoogleButtonRef.current = true;
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load Google login.'));

    return () => {
      cancelled = true;
    };
  }, [checkRegistration, completeGoogleLogin, googleClientId]);

  useEffect(() => {
    if (!resendCooldown) return undefined;
    const timer = window.setInterval(() => {
      setResendCooldown((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  if (status === 'authenticated') return <Navigate to={redirectTo} replace />;

  const resetToEmail = () => {
    setStep('email');
    setOtp('');
    setSignupForm(emptySignupForm);
    setResendCooldown(0);
    setError(null);
  };

  const updateSignupForm = <K extends keyof SignupForm>(field: K, value: SignupForm[K]) => {
    setSignupForm((current) => ({
      ...current,
      [field]: value,
      ...(field === 'organization_type' && value !== 'business' ? { organization_name: '' } : {}),
    }));
  };

  const handleEmailCheck = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim();
    setSubmitting('registration-check');
    setError(null);

    try {
      const registration = await checkRegistration(normalizedEmail);
      if (!registration.is_registered) {
        setEmail(normalizedEmail);
        setSignupForm(emptySignupForm);
        setOtp('');
        await requestOtp(normalizedEmail, 'signup');
        setResendCooldown(45);
        setStep('signup-otp');
        return;
      }

      await requestOtp(normalizedEmail, 'login');
      setOtp('');
      setResendCooldown(45);
      setStep('login-otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check registration.');
    } finally {
      setSubmitting(null);
    }
  };

  const setOtpValue = (value: string) => {
    setOtp(value.replace(/\D/g, '').slice(0, 6));
  };

  const updateOtpDigit = (index: number, value: string) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length > 1) {
      const next = otp.split('');
      digits.slice(0, 6 - index).split('').forEach((digit, offset) => {
        next[index + offset] = digit;
      });
      setOtpValue(next.join(''));
      otpInputRefs.current[Math.min(5, index + digits.length - 1)]?.focus();
      return;
    }

    const next = otp.padEnd(6, ' ').split('');
    next[index] = digits || ' ';
    setOtpValue(next.join(''));
    if (digits && index < 5) otpInputRefs.current[index + 1]?.focus();
  };

  const handleOtpKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !otp[index] && index > 0) {
      otpInputRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (index: number, event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    updateOtpDigit(index, event.clipboardData.getData('text'));
  };

  const handleResendOtp = async () => {
    if (resendCooldown || submitting !== null) return;
    setSubmitting('otp-send');
    setError(null);
    try {
      await requestOtp(email.trim(), step === 'signup-otp' ? 'signup' : 'login');
      setOtp('');
      setResendCooldown(45);
      otpInputRefs.current[0]?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend verification code.');
    } finally {
      setSubmitting(null);
    }
  };

  const handleOtpVerification = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedOtp = otp.trim();
    if (normalizedOtp.length !== 6) {
      setError('Enter the 6-digit verification code.');
      return;
    }
    setSubmitting(step === 'signup-otp' ? 'otp-verify' : 'otp-login');
    setError(null);
    try {
      if (step === 'signup-otp') {
        await verifySignupOtp(email.trim(), normalizedOtp);
        setOtp('');
        setStep('signup');
        return;
      }
      await completeOtpLogin(email.trim(), normalizedOtp);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setSubmitting(null);
    }
  };

  const handleSignup = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signupForm.consent) {
      setError('You must agree to the Terms and Conditions and Privacy Policy.');
      return;
    }
    if (!signupForm.organization_type || !signupForm.designation) {
      setError('Please select your organization type and designation.');
      return;
    }
    const dob = parseDateInputValue(signupForm.dob);
    if (!dob || dob > adultDobMaxDate) {
      setError('You must be at least 18 years old to register.');
      return;
    }
    if (signupForm.organization_type === 'business' && !signupForm.organization_name.trim()) {
      setError('Please enter your organization name.');
      return;
    }

    setSubmitting('signup');
    setError(null);
    try {
      await completeRegistration({
        email: email.trim(),
        first_name: signupForm.first_name.trim(),
        last_name: signupForm.last_name.trim(),
        dob: signupForm.dob,
        organization_type: signupForm.organization_type,
        organization_name: signupForm.organization_type === 'business'
          ? signupForm.organization_name.trim()
          : undefined,
        designation: signupForm.designation,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setSubmitting(null);
    }
  };

  if (isOtpStep) {
    const otpIsBusy = submitting === 'otp-login' || submitting === 'otp-verify';

    return (
      <main className="min-h-screen bg-black px-5 py-12 font-mono text-zinc-100">
        <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-[448px] flex-col items-center justify-center">
          <button
            type="button"
            onClick={resetToEmail}
            disabled={submitting !== null}
            className="mb-8 inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm text-zinc-400 transition hover:bg-zinc-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ArrowLeft size={16} />
            Back
          </button>

          <div className="mb-8 text-2xl font-bold tracking-normal text-[#8b7cff]">OpenBees</div>
          <h1 className="text-center text-3xl font-bold tracking-normal text-white">Verify your email</h1>
          <p className="mt-4 text-center text-sm leading-6 text-zinc-400">
            We've sent a 6-digit code to <span className="text-zinc-200">{email}</span>
          </p>

          <section className="mt-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-2xl shadow-black/50">
            <form onSubmit={handleOtpVerification} className="space-y-6">
              <div className="grid grid-cols-6 gap-2 sm:gap-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <input
                    key={index}
                    ref={(element) => {
                      otpInputRefs.current[index] = element;
                    }}
                    aria-label={`Verification code digit ${index + 1}`}
                    type="text"
                    inputMode="numeric"
                    autoComplete={index === 0 ? 'one-time-code' : 'off'}
                    maxLength={1}
                    value={otp[index] ?? ''}
                    onChange={(event) => updateOtpDigit(index, event.target.value)}
                    onKeyDown={(event) => handleOtpKeyDown(index, event)}
                    onPaste={(event) => handleOtpPaste(index, event)}
                    disabled={submitting !== null}
                    className="aspect-square w-full rounded-md border border-zinc-700 bg-black text-center text-xl font-semibold text-white outline-none transition focus:border-[#8b7cff] focus:ring-2 focus:ring-[#8b7cff]/30 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                ))}
              </div>

              {error && (
                <div className="rounded-md border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting !== null || otp.trim().length !== 6}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-[#8b7cff] px-4 text-sm font-semibold text-white transition hover:bg-[#7564f2] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {otpIsBusy && <Loader2 size={18} className="animate-spin" />}
                Verify Email
              </button>
            </form>

            <div className="mt-5 flex items-center justify-center gap-2 text-sm text-zinc-400">
              <span>Didn't receive a code?</span>
              <button
                type="button"
                onClick={handleResendOtp}
                disabled={submitting !== null || resendCooldown > 0}
                className="inline-flex items-center gap-1 font-medium text-[#a79cff] transition hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting === 'otp-send' && <RotateCcw size={14} className="animate-spin" />}
                {resendCooldown > 0 ? `Resend OTP (${resendCooldown}s)` : 'Resend OTP'}
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (step === 'signup') {
    return (
      <main className="min-h-screen bg-zinc-950 px-5 py-12 font-mono text-zinc-100">
        <div className="mx-auto flex w-full max-w-[448px] flex-col items-center">
          <div className="mb-8 text-2xl font-bold tracking-normal text-white">OpenBees</div>
          <h1 className="text-center text-3xl font-bold tracking-normal text-white">Complete your profile</h1>
          <p className="mt-3 text-center text-base text-zinc-400">Tell us a bit about yourself to get started</p>

          <section className="mt-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black/30">
            <form onSubmit={handleSignup} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-sm text-zinc-300">First Name</span>
                  <input
                    type="text"
                    required
                    value={signupForm.first_name}
                    onChange={(event) => updateSignupForm('first_name', event.target.value)}
                    disabled={submitting !== null}
                    className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm text-zinc-300">Last Name</span>
                  <input
                    type="text"
                    required
                    value={signupForm.last_name}
                    onChange={(event) => updateSignupForm('last_name', event.target.value)}
                    disabled={submitting !== null}
                    className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-sm text-zinc-300">Email</span>
                <input
                  type="email"
                  value={email}
                  readOnly
                  className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none opacity-80"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm text-zinc-300">Date of Birth</span>
                <input
                  type="date"
                  required
                  max={adultDobMax}
                  value={signupForm.dob}
                  onChange={(event) => updateSignupForm('dob', event.target.value)}
                  disabled={submitting !== null}
                  className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm text-zinc-300">Organization Type</span>
                <select
                  required
                  value={signupForm.organization_type}
                  onChange={(event) => updateSignupForm('organization_type', event.target.value as SignupForm['organization_type'])}
                  disabled={submitting !== null}
                  className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <option value="">Select organization type</option>
                  <option value="individual">Individual</option>
                  <option value="business">Business</option>
                </select>
              </label>

              {signupForm.organization_type === 'business' && (
                <label className="block">
                  <span className="mb-1.5 block text-sm text-zinc-300">Organization Name</span>
                  <input
                    type="text"
                    required
                    value={signupForm.organization_name}
                    onChange={(event) => updateSignupForm('organization_name', event.target.value)}
                    disabled={submitting !== null}
                    className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              )}

              <label className="block">
                <span className="mb-1.5 block text-sm text-zinc-300">Designation</span>
                <select
                  required
                  value={signupForm.designation}
                  onChange={(event) => updateSignupForm('designation', event.target.value as SignupForm['designation'])}
                  disabled={submitting !== null}
                  className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <option value="">Select your designation</option>
                  <option value="developer">Developer</option>
                  <option value="founder_ceo_cto">Founder / CEO / CTO</option>
                  <option value="manager">Manager</option>
                  <option value="student">Student</option>
                  <option value="other">Other</option>
                </select>
              </label>

              <label className="flex items-start gap-2 text-sm leading-6 text-zinc-300">
                <input
                  type="checkbox"
                  required
                  checked={signupForm.consent}
                  onChange={(event) => updateSignupForm('consent', event.target.checked)}
                  disabled={submitting !== null}
                  className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-[#5b45ee] focus:ring-[#5b45ee]"
                />
                <span>
                  I agree to the{' '}
                  <a href="https://openbees.ai/terms" target="_blank" rel="noreferrer" className="text-[#4f46e5] underline">
                    Terms and Conditions
                  </a>{' '}
                  and{' '}
                  <a href="https://openbees.ai/privacy" target="_blank" rel="noreferrer" className="text-[#4f46e5] underline">
                    Privacy Policy
                  </a>{' '}
                  <span className="text-red-500">*</span>
                </span>
              </label>

              {error && (
                <div className="rounded-md border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting !== null}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-[#5b45ee] px-4 text-sm font-semibold text-white transition hover:bg-[#4d3be0] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {submitting === 'signup' && <Loader2 size={18} className="animate-spin" />}
                Complete registration
              </button>
            </form>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex min-h-screen w-full items-center justify-center px-6 py-10">
        <div className="grid w-full max-w-5xl gap-10 lg:grid-cols-[1fr_480px] lg:items-center">
          <section className="mx-auto max-w-2xl lg:mx-0">
            <div className="mb-8 text-2xl font-bold tracking-normal text-white">OpenBees</div>
            <h1 className="text-4xl font-semibold tracking-normal text-white sm:text-5xl">
              Sign in to OpenBees
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-zinc-400">
              Access your autonomous task board, chats, schedules, files, and activity inbox after verification.
            </p>
          </section>

          <section className="mx-auto w-full max-w-[480px] rounded-lg border border-zinc-800 bg-zinc-900 p-8 shadow-2xl shadow-black/30">
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-white">Developer Login</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Use your email or Google account.
              </p>
            </div>

            <form onSubmit={handleEmailCheck} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-zinc-300">Email</span>
                <span className="relative block">
                  <Mail size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={submitting !== null}
                    className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                    placeholder="you@example.com"
                  />
                </span>
              </label>

              {error && (
                <div className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting !== null}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {submitting === 'registration-check' ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <LogIn size={18} />
                )}
                Continue
              </button>
            </form>

            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-zinc-800" />
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">or</span>
              <div className="h-px flex-1 bg-zinc-800" />
            </div>
            {googleClientId ? (
              <div className={`flex justify-center ${submitting === 'google' ? 'pointer-events-none opacity-70' : ''}`}>
                <div className="w-full max-w-[400px]" ref={googleButtonRef} />
              </div>
            ) : (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm text-zinc-400">
                {googleConfigLoaded
                  ? googleConfigError || 'Google login is unavailable because GOOGLE_CLIENT_ID is not configured.'
                  : 'Loading Google login...'}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
