export const SELECTED_ORGANIZATION_KEY = 'selectedOrganizationId';
export const ACTIVE_WORKSPACE_KEY = 'activeWorkspace';

export type ActiveWorkspace =
  | { type: 'personal'; explicit: boolean }
  | { type: 'organization'; organizationId: string };

function normalizeOrganizationId(value: string | null | undefined): string | null {
  const normalized = value?.trim() || null;
  return normalized;
}

export function getActiveWorkspace(): ActiveWorkspace {
  const stored = localStorage.getItem(ACTIVE_WORKSPACE_KEY)?.trim() ?? '';
  if (stored === 'personal') return { type: 'personal', explicit: true };
  if (stored.startsWith('organization:')) {
    const organizationId = normalizeOrganizationId(stored.slice('organization:'.length));
    if (organizationId) return { type: 'organization', organizationId };
  }

  const legacyOrganizationId = normalizeOrganizationId(localStorage.getItem(SELECTED_ORGANIZATION_KEY));
  return legacyOrganizationId
    ? { type: 'organization', organizationId: legacyOrganizationId }
    : { type: 'personal', explicit: false };
}

export function setActiveWorkspace(value: ActiveWorkspace): void {
  if (value.type === 'organization') {
    const organizationId = normalizeOrganizationId(value.organizationId);
    if (organizationId) {
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, `organization:${organizationId}`);
      localStorage.setItem(SELECTED_ORGANIZATION_KEY, organizationId);
      return;
    }
  }

  if (value.type === 'personal' && value.explicit) {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, 'personal');
  } else {
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  }
  localStorage.removeItem(SELECTED_ORGANIZATION_KEY);
}

export function getSelectedOrganizationId(): string | null {
  const workspace = getActiveWorkspace();
  return workspace.type === 'organization' ? workspace.organizationId : null;
}

export function setSelectedOrganizationId(value: string | null): void {
  const normalized = normalizeOrganizationId(value);
  if (normalized) setActiveWorkspace({ type: 'organization', organizationId: normalized });
  else setActiveWorkspace({ type: 'personal', explicit: true });
}
