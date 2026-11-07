import { useCallback, useState } from 'react';
import { Atom } from 'lucide-react';
import StudioPanel from './components/StudioPanel';
import PhysicsWorld from './components/PhysicsWorld';
import type { CutoutAsset } from './types/asset';
import './App.css';

export default function App() {
  const [spawnRequests, setSpawnRequests] = useState<CutoutAsset[]>([]);

  const handleSpawn = useCallback((asset: CutoutAsset) => {
    setSpawnRequests((prev) => [...prev, asset]);
  }, []);

  return (
    <div className="app">
      <header className="app-topbar">
        <span className="app-brand-mark" aria-hidden="true">
          <Atom size={20} />
        </span>
        <span className="app-wordmark">PhysicsLab</span>
        <span className="app-tagline">Photo → Physics</span>
      </header>
      <main className="app-body">
        <aside className="app-studio">
          <StudioPanel onSpawn={handleSpawn} />
        </aside>
        <section className="app-stage">
          <PhysicsWorld spawnRequests={spawnRequests} />
        </section>
      </main>
    </div>
  );
}
