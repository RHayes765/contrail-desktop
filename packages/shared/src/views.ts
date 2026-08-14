/**
 * Renderer-facing view models. Token-free by construction: nothing in this
 * file may ever carry OAuth material, confirmation codes, or session-bearing
 * URLs — the renderer is a human surface, but views also flow through logs
 * and diagnostics.
 */

export type OrgType = 'production' | 'sandbox' | 'developer' | 'scratch' | string;

export interface GrantSetView {
  metadata_read: boolean;
  metadata_write: boolean;
  diagnostics_read: boolean;
  data_read: boolean;
  data_write: boolean;
}

export interface ConnectionView {
  id: string;
  alias: string;
  orgId: string;
  orgName: string | null;
  orgType: OrgType;
  isSandbox: boolean;
  instanceUrl: string;
  username: string | null;
  grants: GrantSetView;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface HealthView {
  ok: boolean;
  appVersion: string;
  dataDir: string;
  schemaVersion: number;
  nativeModules: {
    betterSqlite3: { ok: boolean; detail: string };
    keyring: { ok: boolean; detail: string };
  };
  connectionCount: number;
}
