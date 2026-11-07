import type { CutoutAsset } from '../types/asset';

export interface PhysicsWorldProps {
  spawnRequests: CutoutAsset[];
}

// Placeholder — replaced by Agent B on feat/physics-world.
export default function PhysicsWorld({ spawnRequests }: PhysicsWorldProps) {
  return (
    <div className="placeholder-panel">
      Physics World — coming soon ({spawnRequests.length} spawn requests)
    </div>
  );
}
