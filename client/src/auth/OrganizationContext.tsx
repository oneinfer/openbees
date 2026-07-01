import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import {
  acceptOrganizationInvitation as acceptOrganizationInvitationRequest,
  createOrganization as createOrganizationRequest,
  fetchPendingOrganizationInvitations,
  fetchOrganizations,
  type OrganizationCreatePayload,
  type OrganizationInvitationResponse,
  type OrganizationResponse,
} from '../lib/auth-api';
import {
  clearStoredOrganizationWorkspace,
  getActiveWorkspace,
  setActiveWorkspace as storeActiveWorkspace,
  type ActiveWorkspace,
} from '../lib/organization-selection';

type OrganizationStatus = 'idle' | 'loading' | 'ready' | 'error';

interface OrganizationContextValue {
  status: OrganizationStatus;
  organizations: OrganizationResponse[];
  activeWorkspace: ActiveWorkspace;
  primaryOrganization: OrganizationResponse | null;
  selectedOrganization: OrganizationResponse | null;
  selectedOrganizationId: string | null;
  pendingInvitations: OrganizationInvitationResponse[];
  error: string | null;
  refreshOrganizations: () => Promise<OrganizationResponse[]>;
  selectOrganization: (organizationId: string) => void;
  selectPersonalWorkspace: () => void;
  createOrganization: (payload: OrganizationCreatePayload) => Promise<OrganizationResponse>;
  acceptInvitation: (invitationId: string) => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function primaryOrganizationFrom(organizations: OrganizationResponse[]): OrganizationResponse | null {
  return organizations[0] ?? null;
}

function workspaceForAvailableOrganization(
  current: ActiveWorkspace,
  organizations: OrganizationResponse[],
): ActiveWorkspace {
  // Respect an explicit personal selection, but auto-select org when it's just the default.
  if (current.type === 'personal' && current.explicit) return current;
  if (current.type === 'organization' && organizations.some((o) => o.organization_id === current.organizationId)) {
    return current;
  }
  const first = organizations[0];
  return first ? { type: 'organization', organizationId: first.organization_id } : { type: 'personal', explicit: false };
}

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, accessToken } = useAuth();
  const [status, setStatus] = useState<OrganizationStatus>('idle');
  const [organizations, setOrganizations] = useState<OrganizationResponse[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<ActiveWorkspace>(() => {
    const workspace = getActiveWorkspace();
    if (workspace.type === 'organization') clearStoredOrganizationWorkspace();
    return workspace;
  });
  const [pendingInvitations, setPendingInvitations] = useState<OrganizationInvitationResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const selectedOrganizationId = activeWorkspace.type === 'organization' ? activeWorkspace.organizationId : null;

  useEffect(() => {
    let cancelled = false;

    if (authStatus === 'loading') {
      return () => {
        cancelled = true;
      };
    }

    if (authStatus !== 'authenticated' || !accessToken) {
      setStatus('idle');
      setOrganizations([]);
      setPendingInvitations([]);
      setError(null);
      const personalWorkspace: ActiveWorkspace = { type: 'personal', explicit: false };
      setActiveWorkspace(personalWorkspace);
      storeActiveWorkspace(personalWorkspace);
      return () => {
        cancelled = true;
      };
    }

    setStatus('loading');
    setError(null);
    Promise.all([
      fetchOrganizations(accessToken),
      fetchPendingOrganizationInvitations(accessToken),
    ])
      .then(([nextOrganizations, nextInvitations]) => {
        if (cancelled) return;
        setOrganizations(nextOrganizations);
        setPendingInvitations(nextInvitations);
        setActiveWorkspace((current) => {
          const next = workspaceForAvailableOrganization(current, nextOrganizations);
          storeActiveWorkspace(next);
          return next;
        });
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err, 'Failed to load organizations.'));
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, authStatus]);

  const refreshOrganizations = useCallback(async () => {
    if (authStatus !== 'authenticated' || !accessToken) {
      setOrganizations([]);
      setPendingInvitations([]);
      setStatus('idle');
      setError(null);
      const personalWorkspace: ActiveWorkspace = { type: 'personal', explicit: false };
      setActiveWorkspace(personalWorkspace);
      storeActiveWorkspace(personalWorkspace);
      return [];
    }

    setStatus('loading');
    setError(null);
    try {
      const [nextOrganizations, nextInvitations] = await Promise.all([
        fetchOrganizations(accessToken),
        fetchPendingOrganizationInvitations(accessToken),
      ]);
      setOrganizations(nextOrganizations);
      setPendingInvitations(nextInvitations);
      setActiveWorkspace((current) => {
        const next = workspaceForAvailableOrganization(current, nextOrganizations);
        storeActiveWorkspace(next);
        return next;
      });
      setStatus('ready');
      return nextOrganizations;
    } catch (err) {
      const message = errorMessage(err, 'Failed to load organizations.');
      setError(message);
      setStatus('error');
      throw new Error(message);
    }
  }, [accessToken, authStatus]);

  const createOrganization = useCallback(async (payload: OrganizationCreatePayload) => {
    if (!accessToken) throw new Error('Authentication required.');

    const created = await createOrganizationRequest(accessToken, payload);
    try {
      const [nextOrganizations, nextInvitations] = await Promise.all([
        fetchOrganizations(accessToken),
        fetchPendingOrganizationInvitations(accessToken),
      ]);
      setOrganizations(nextOrganizations);
      setPendingInvitations(nextInvitations);
      const nextWorkspace = { type: 'organization' as const, organizationId: created.organization_id };
      setActiveWorkspace(nextWorkspace);
      storeActiveWorkspace(nextWorkspace);
    } catch {
      setOrganizations((current) => {
        const withoutDuplicate = current.filter((organization) => organization.organization_id !== created.organization_id);
        return [...withoutDuplicate, created];
      });
      const nextWorkspace = { type: 'organization' as const, organizationId: created.organization_id };
      setActiveWorkspace(nextWorkspace);
      storeActiveWorkspace(nextWorkspace);
    }
    setError(null);
    setStatus('ready');
    return created;
  }, [accessToken]);

  const acceptInvitation = useCallback(async (invitationId: string) => {
    if (!accessToken) throw new Error('Authentication required.');

    await acceptOrganizationInvitationRequest(accessToken, invitationId);
    const [nextOrganizations, nextInvitations] = await Promise.all([
      fetchOrganizations(accessToken),
      fetchPendingOrganizationInvitations(accessToken),
    ]);
    setOrganizations(nextOrganizations);
    setPendingInvitations(nextInvitations);
    setActiveWorkspace((current) => {
      const next = workspaceForAvailableOrganization(current, nextOrganizations);
      storeActiveWorkspace(next);
      return next;
    });
    setError(null);
    setStatus('ready');
  }, [accessToken]);

  const selectOrganization = useCallback((organizationId: string) => {
    const normalized = organizationId.trim();
    const next = normalized && organizations.some((o) => o.organization_id === normalized)
      ? { type: 'organization' as const, organizationId: normalized }
      : { type: 'personal' as const, explicit: true };
    setActiveWorkspace(next);
    storeActiveWorkspace(next);
  }, [organizations]);

  const selectPersonalWorkspace = useCallback(() => {
    const next = { type: 'personal' as const, explicit: true };
    setActiveWorkspace(next);
    storeActiveWorkspace(next);
  }, []);

  const value = useMemo<OrganizationContextValue>(() => {
    const primaryOrganization = primaryOrganizationFrom(organizations);
    const selectedOrganization = organizations.find((organization) => organization.organization_id === selectedOrganizationId) ?? null;
    return {
      status,
      organizations,
      activeWorkspace,
      primaryOrganization,
      selectedOrganization,
      selectedOrganizationId,
      pendingInvitations,
      error,
      refreshOrganizations,
      selectOrganization,
      selectPersonalWorkspace,
      createOrganization,
      acceptInvitation,
    };
  }, [acceptInvitation, activeWorkspace, createOrganization, error, organizations, pendingInvitations, refreshOrganizations, selectOrganization, selectPersonalWorkspace, selectedOrganizationId, status]);

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useOrganizations() {
  const context = useContext(OrganizationContext);
  if (!context) throw new Error('useOrganizations must be used within OrganizationProvider');
  return context;
}
