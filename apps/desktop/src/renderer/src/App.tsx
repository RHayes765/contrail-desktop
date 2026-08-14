import { useEffect, useRef, useState } from 'react';
import type { HealthView } from '@contrail/shared';
import { ipc } from './lib/ipc.js';
import { useNav } from './stores/nav.js';
import { useChat } from './stores/chat.js';
import { ConnectionsScreen } from './screens/Connections.js';
import { ProjectsScreen } from './screens/Projects.js';
import { ProjectDetailScreen } from './screens/ProjectDetail.js';
import { ChatScreen } from './screens/Chat.js';

export function App() {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { screen, projectId, goConnections, goProjects } = useNav();

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

  const inProjects = screen === 'projects' || screen === 'project' || screen === 'chat';

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
      </nav>
      <main className={`content${screen === 'chat' ? ' content-chat' : ''}`}>
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
        ) : (
          <ProjectsScreen />
        )}
      </main>
      {health && screen !== 'chat' && (
        <footer className="statusbar">
          <span>Contrail {health.appVersion}</span>
          <span>engine ok · schema v{health.schemaVersion}</span>
          <span>{health.dataDir}</span>
        </footer>
      )}
    </div>
  );
}
