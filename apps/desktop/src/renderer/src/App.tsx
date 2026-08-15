import { useEffect, useRef, useState } from 'react';
import type { HealthView } from '@contrail/shared';
import { ipc } from './lib/ipc.js';
import { useNav } from './stores/nav.js';
import { useChat } from './stores/chat.js';
import { ConnectionsScreen } from './screens/Connections.js';
import { ProjectsScreen } from './screens/Projects.js';
import { ProjectDetailScreen } from './screens/ProjectDetail.js';
import { ChatScreen } from './screens/Chat.js';
import { SessionViewerScreen } from './screens/SessionViewer.js';
import { MetadataScreen } from './screens/Metadata.js';
import { DiffScreen } from './screens/Diff.js';
import { ConnectorsScreen } from './screens/Connectors.js';

export function App() {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { screen, projectId, sessionId, goConnections, goProjects } = useNav();

  useEffect(() => {
    ipc
      .invoke('app:health', {})
      .then(setHealth)
      .catch((err) => setError(String(err)));
  }, []);

  // Leaving the chat screen by ANY route ends the live session — a session
  // must never keep running (and spending) with no screen attached to it.
  const prevScreen = useRef(screen);
  useEffect(() => {
    if (prevScreen.current === 'chat' && screen !== 'chat') {
      void useChat.getState().end();
    }
    prevScreen.current = screen;
  }, [screen]);

  const inProjects =
    screen === 'projects' || screen === 'project' || screen === 'chat' || screen === 'session';
  const fullBleed = screen === 'chat' || screen === 'session';

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Contrail</div>
        <button className={screen === 'connections' ? 'active' : ''} onClick={goConnections}>
          Connections
        </button>
        <button className={inProjects ? 'active' : ''} onClick={goProjects}>
          Projects
        </button>
        <button
          className={screen === 'metadata' ? 'active' : ''}
          onClick={() => useNav.setState({ screen: 'metadata', sessionId: null })}
        >
          Metadata
        </button>
        <button
          className={screen === 'diff' ? 'active' : ''}
          onClick={() => useNav.setState({ screen: 'diff', sessionId: null })}
        >
          Diff
        </button>
        <button
          className={screen === 'connectors' ? 'active' : ''}
          onClick={() => useNav.setState({ screen: 'connectors', sessionId: null })}
        >
          Connectors
        </button>
      </nav>
      <main className={`content${fullBleed ? ' content-chat' : ''}`}>
        {error ? (
          <div className="empty">Engine error: {error}</div>
        ) : screen === 'connections' ? (
          <ConnectionsScreen />
        ) : screen === 'projects' ? (
          <ProjectsScreen />
        ) : screen === 'project' && projectId ? (
          <ProjectDetailScreen projectId={projectId} />
        ) : screen === 'chat' && projectId ? (
          <ChatScreen projectId={projectId} />
        ) : screen === 'session' && projectId && sessionId ? (
          <SessionViewerScreen projectId={projectId} sessionId={sessionId} />
        ) : screen === 'metadata' ? (
          <MetadataScreen />
        ) : screen === 'diff' ? (
          <DiffScreen />
        ) : screen === 'connectors' ? (
          <ConnectorsScreen />
        ) : (
          <ProjectsScreen />
        )}
      </main>
      {health && !fullBleed && (
        <footer className="statusbar">
          <span>Contrail {health.appVersion}</span>
          <span>engine ok · schema v{health.schemaVersion}</span>
          {/* The file the engine ACTUALLY opened — db.name, never a computed path. */}
          <span title={`dataDir: ${health.dataDir}`}>{health.dbFile}</span>
        </footer>
      )}
    </div>
  );
}
