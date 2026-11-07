import { useCallback, useState } from 'react';
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
      <section className="app__studio">
        <StudioPanel onSpawn={handleSpawn} />
      </section>
      <section className="app__physics">
        <PhysicsWorld spawnRequests={spawnRequests} />
      </section>
    </div>
  );
}
