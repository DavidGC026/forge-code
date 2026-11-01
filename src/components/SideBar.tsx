import { useStore } from '../store';
import ExtensionsPanel from './ExtensionsPanel';
import SettingsPanel from './SettingsPanel';
import ExplorerPanel, { BottomSections } from './Sidebar/ExplorerPanel';
import SourceControlPanel from './Sidebar/SourceControlPanel';
import RunDebugPanel from './Sidebar/RunDebugPanel';
import AgentsPanel from './Sidebar/AgentsPanel';
import SearchPanel from './Sidebar/SearchPanel';

const panelNames = {
  explorer: 'Explorador', search: 'Búsqueda', git: 'Control de versiones',
  debug: 'Ejecutar', agents: 'Agentes', extensions: 'Extensiones', settings: 'Preferencias',
};

export default function SideBar() {
  const activeSidebarPanel = useStore((s) => s.activeSidebarPanel);

  const renderPanel = () => {
    switch (activeSidebarPanel) {
      case 'search': return <SearchPanel />;
      case 'git': return <SourceControlPanel />;
      case 'debug': return <RunDebugPanel />;
      case 'agents': return <AgentsPanel />;
      case 'extensions': return <ExtensionsPanel />;
      case 'settings': return <SettingsPanel />;
      default: return <ExplorerPanel />;
    }
  };

  return (
    <aside aria-label={panelNames[activeSidebarPanel]} className="w-full h-full bg-forge-sidebar flex flex-col border-r border-forge-border/70 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{renderPanel()}</div>
      {activeSidebarPanel === 'explorer' && <BottomSections />}
    </aside>
  );
}
