export type BeesMode = 'local' | 'enterprise';

export function beesMode(): BeesMode {
  const raw = (process.env.BEES_MODE || 'local').trim().toLowerCase();
  return raw === 'enterprise' ? 'enterprise' : 'local';
}

export function isLocalMode(): boolean {
  return beesMode() === 'local';
}

export function isEnterpriseMode(): boolean {
  return beesMode() === 'enterprise';
}

export function enterpriseApiBaseUrl(): string {
  const configured = (
    process.env.BEES_ENTERPRISE_API_BASE_URL
    || process.env.ONEINFER_API_BASE_URL
    || process.env.VITE_OPENBEES_ENTERPRISE_APP_URL
    || 'http://localhost:8001/api/v1'
  ).trim();
  return configured.replace(/\/$/, '');
}
