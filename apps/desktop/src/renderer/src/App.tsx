import { useEffect, useState } from 'react';
import type { ConnectionView, HealthView } from '@contrail/shared';
import { ipc } from './lib/ipc.js';
import { ConnectionsScreen } from './screens/Connections.js';

export function App() {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([ipc.invoke('app:health', {}), ipc.invoke('connections:list', {})])
      .then(([h, c]) => {
        setHealth(h);
        setConnections(c);
      })
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Contrail</div>
        <button className="active">Connections</button>
        <button disabled title="Coming in M1">Projects</button>
        <button disabled title="Coming in M1">Chat</button>
      </nav>
      <main className="content">
        {error ? (
          <div className="empty">Engine error: {error}</div>
        ) : (
          <ConnectionsScreen connections={connections} />
        )}
      </main>
      {health && (
        <footer className="statusbar">
          <span>Contrail {health.appVersion}</span>
          <span>engine ok · schema v{health.schemaVersion}</span>
          <span>{health.dataDir}</span>
        </footer>
      )}
    </div>
  );
}
