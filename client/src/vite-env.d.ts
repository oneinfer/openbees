/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENBEES_ENTERPRISE_APP_URL?: string;
  readonly VITE_ONEINFER_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
