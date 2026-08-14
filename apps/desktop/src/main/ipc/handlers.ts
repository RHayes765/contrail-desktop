import type { ConnectionView, HealthView } from '@contrail/shared';
import type { EngineDeps } from '@contrail/engine';
import type { ConnectionRecord } from '@contrail/engine';

/** Token-free renderer view of a connection (mirrors the capability summary). */
export function connectionView(rec: ConnectionRecord): ConnectionView {
  return {
    id: rec.id,
    alias: rec.alias,
    orgId: rec.orgId,
    orgName: rec.orgName,
    orgType: rec.orgType,
    isSandbox: rec.isSandbox,
    instanceUrl: rec.instanceUrl,
    username: rec.username,
    grants: rec.grants,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    lastUsedAt: rec.lastUsedAt,
  };
}

export function makeHandlers(health: HealthView) {
  return {
    'app:health': (deps: EngineDeps): HealthView => ({
      ...health,
      connectionCount: deps.db.listConnections().length,
    }),
    'connections:list': (deps: EngineDeps): ConnectionView[] =>
      deps.db.listConnections().map(connectionView),
  };
}
