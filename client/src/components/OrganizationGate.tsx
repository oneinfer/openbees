import { useState } from 'react';
import type { FormEvent } from 'react';
import { Building2, Loader2, LogOut, RefreshCcw, UserPlus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useOrganizations } from '../auth/OrganizationContext';
import type { OrganizationRole } from '../lib/auth-api';

type CreateStatus = 'idle' | 'saving';

export function OrganizationGate({ mode = 'create' }: { mode?: 'create' | 'error' }) {
  const { developer, logout } = useAuth();
  const { error, pendingInvitations, refreshOrganizations, createOrganization, acceptInvitation } = useOrganizations();
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState(developer?.email ?? '');
  const [status, setStatus] = useState<CreateStatus>('idle');
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const hasPendingInvitations = mode === 'create' && pendingInvitations.length > 0;
  const title = mode === 'error'
    ? 'Organization check failed'
    : hasPendingInvitations
      ? 'Join an organization'
      : 'Create your organization';

  const roleLabel = (role: OrganizationRole) => {
    if (role === 'admin') return 'Admin';
    if (role === 'manager') return 'Manager';
    return 'Member';
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedContactEmail = contactEmail.trim();
    if (trimmedName.length < 2) {
      setFormError('Organization name must be at least 2 characters.');
      return;
    }
    if (!trimmedContactEmail) {
      setFormError('Contact email is required.');
      return;
    }

    setStatus('saving');
    setFormError(null);
    try {
      await createOrganization({ name: trimmedName, contact_email: trimmedContactEmail });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create organization.');
    } finally {
      setStatus('idle');
    }
  };

  const handleAcceptInvitation = async (invitationId: string) => {
    setAcceptingInvitationId(invitationId);
    setFormError(null);
    try {
      await acceptInvitation(invitationId);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to accept invitation.');
    } finally {
      setAcceptingInvitationId(null);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 px-5 py-12 font-mono text-zinc-100">
      <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-[448px] flex-col items-center justify-center">
        <div className="mb-8 text-2xl font-bold tracking-normal text-white">OpenBees</div>
        <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-[#8b7cff]">
          <Building2 size={22} />
        </div>
        <h1 className="text-center text-3xl font-bold tracking-normal text-white">
          {title}
        </h1>
        <p className="mt-3 text-center text-sm leading-6 text-zinc-400">
          {mode === 'error'
            ? 'We could not confirm your organization membership. Retry the check or sign out.'
            : hasPendingInvitations
              ? 'You have an invitation waiting. Accept it to enter the workspace.'
            : 'Your account needs an organization before you can enter the workspace.'}
        </p>

        <section className="mt-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black/30">
          {mode === 'create' && (
            <div className="space-y-6">
              {hasPendingInvitations && (
                <div className="space-y-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Pending invitations</h2>
                    <p className="mt-1 text-sm leading-5 text-zinc-400">
                      Accept an invitation to join an existing organization.
                    </p>
                  </div>
                  <div className="space-y-2">
                    {pendingInvitations.map((invitation) => {
                      const isAccepting = acceptingInvitationId === invitation.id;
                      return (
                        <div
                          key={invitation.id}
                          className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3"
                        >
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-[#8b7cff]">
                              <UserPlus size={16} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="truncate text-sm font-semibold text-white">
                                  {invitation.organization_name ?? 'Organization'}
                                </h3>
                                <span className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium text-zinc-300">
                                  {roleLabel(invitation.role)}
                                </span>
                              </div>
                              <p className="mt-1 truncate text-xs text-zinc-500">
                                Invited as {invitation.email}
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleAcceptInvitation(invitation.id)}
                            disabled={status === 'saving' || acceptingInvitationId !== null}
                            className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#8b7cff] px-4 text-sm font-semibold text-white transition hover:bg-[#7564f2] disabled:cursor-not-allowed disabled:opacity-70"
                          >
                            {isAccepting && <Loader2 size={16} className="animate-spin" />}
                            Accept invitation
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {hasPendingInvitations && (
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-zinc-800" />
                  <span className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">or</span>
                  <div className="h-px flex-1 bg-zinc-800" />
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
              <label className="block">
                <span className="mb-1.5 block text-sm text-zinc-300">Organization Name</span>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={status === 'saving'}
                  className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm text-zinc-300">Contact Email</span>
                <input
                  type="email"
                  required
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                  disabled={status === 'saving'}
                  className="h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              {(formError || error) && (
                <div className="rounded-md border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200">
                  {formError ?? error}
                </div>
              )}

              <button
                type="submit"
                disabled={status === 'saving' || acceptingInvitationId !== null}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-[#8b7cff] px-4 text-sm font-semibold text-white transition hover:bg-[#7564f2] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {status === 'saving' && <Loader2 size={18} className="animate-spin" />}
                Create organization
              </button>
            </form>
            </div>
          )}

          {mode === 'error' && error && (
            <div className="rounded-md border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          <div className="mt-5 flex items-center justify-between gap-3 text-sm">
            <button
              type="button"
              onClick={() => void refreshOrganizations().catch(() => undefined)}
              disabled={status === 'saving' || acceptingInvitationId !== null}
              className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-zinc-400 transition hover:bg-zinc-950 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCcw size={14} />
              Retry
            </button>
            <button
              type="button"
              onClick={logout}
              disabled={status === 'saving' || acceptingInvitationId !== null}
              className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-zinc-400 transition hover:bg-zinc-950 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
