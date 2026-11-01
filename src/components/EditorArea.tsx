import { TabBar, EditorToolbar } from './Editor/EditorChrome';
import MonacoWrapper from './Editor/MonacoWrapper';

export default function EditorArea() {
  return (
    <div className="w-full h-full min-w-0 flex flex-col bg-forge-editor">
      <TabBar />
      <EditorToolbar />
      <div className="flex-1 min-h-0 overflow-hidden">
        <MonacoWrapper />
      </div>
    </div>
  );
}
