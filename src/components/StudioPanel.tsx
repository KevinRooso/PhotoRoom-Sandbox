import type { CutoutAsset } from '../types/asset';

export interface StudioPanelProps {
  onSpawn: (asset: CutoutAsset) => void;
}

// Placeholder — replaced by Agent A on feat/photo-editor.
export default function StudioPanel(_props: StudioPanelProps) {
  return <div className="placeholder-panel">Photo Studio — coming soon</div>;
}
