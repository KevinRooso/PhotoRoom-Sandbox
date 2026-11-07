import Matter from 'matter-js';
import { releaseBodyTexture } from '../physics';

export type ObjectKind = 'solid' | 'jelly' | 'ragdoll';

export interface PhysObject {
  id: number;
  kind: ObjectKind;
  /** representative body (selection, future face host); for solid = the body */
  root: Matter.Body;
  /** every body of the object */
  bodies: Matter.Body[];
  /** empty for solids */
  constraints: Matter.Constraint[];
  /** texture keys released on removal */
  textureKeys: string[];
  createdAt: number;
}

export const MAX_OBJECTS = 60;

export interface Attachment {
  id: number;
  kind: 'rope' | 'spring';
  /** removed when ANY of these objects is removed */
  objectIds: number[];
  /** rope links (never registered as objects) */
  bodies: Matter.Body[];
  constraints: Matter.Constraint[];
  /** rope's fixed world point */
  anchor?: { x: number; y: number };
}

export interface ObjectRegistry {
  add(world: Matter.World, obj: PhysObject): void;
  remove(world: Matter.World, render: Matter.Render, obj: PhysObject): void;
  /** remove from the map + detach constraints/attachments but KEEP the bodies
   *  in the world (jelly dissolve: tiles become shards). */
  drop(world: Matter.World, obj: PhysObject): void;
  removeAll(world: Matter.World, render: Matter.Render): void;
  attach(world: Matter.World, att: Attachment): void;
  detach(world: Matter.World, att: Attachment): void;
  attachments(): Attachment[];
  objectOf(body: Matter.Body): PhysObject | undefined;
  list(): PhysObject[];
  /** every body of every registered object (includes frozen/static roots) */
  allBodies(): Matter.Body[];
  readonly size: number;
  nextId(): number;
}

/**
 * Tracks physics *objects* (a solid, jelly or ragdoll), not raw bodies —
 * counter, cap, clear and selection work on these. Shards are never
 * registered; they live and die outside this registry.
 */
export function createObjectRegistry(): ObjectRegistry {
  let seq = 0;
  const objects = new Map<number, PhysObject>();
  const atts = new Map<number, Attachment>();

  const detachAtt = (world: Matter.World, att: Attachment) => {
    for (const c of att.constraints) Matter.Composite.remove(world, c);
    for (const b of att.bodies) Matter.Composite.remove(world, b);
    atts.delete(att.id);
  };

  return {
    add(world, obj) {
      for (const body of obj.bodies) {
        body.plugin = body.plugin || {};
        (body.plugin as Record<string, unknown>).objectId = obj.id;
      }
      objects.set(obj.id, obj);
      if (obj.constraints.length > 0) {
        Matter.Composite.add(world, [...obj.bodies, ...obj.constraints]);
      } else {
        Matter.Composite.add(world, obj.bodies);
      }
    },

    remove(world, render, obj) {
      for (const att of atts.values()) {
        if (att.objectIds.includes(obj.id)) detachAtt(world, att);
      }
      for (const c of obj.constraints) Matter.Composite.remove(world, c);
      for (const body of obj.bodies) {
        releaseBodyTexture(render, body);
        Matter.Composite.remove(world, body);
      }
      objects.delete(obj.id);
    },

    drop(world, obj) {
      for (const att of atts.values()) {
        if (att.objectIds.includes(obj.id)) detachAtt(world, att);
      }
      for (const c of obj.constraints) Matter.Composite.remove(world, c);
      objects.delete(obj.id);
    },

    removeAll(world, render) {
      for (const obj of [...objects.values()]) this.remove(world, render, obj);
      for (const att of [...atts.values()]) detachAtt(world, att);
    },

    attach(world, att) {
      atts.set(att.id, att);
      if (att.constraints.length > 0 || att.bodies.length > 0) {
        Matter.Composite.add(world, [...att.bodies, ...att.constraints]);
      }
    },

    detach(world, att) {
      detachAtt(world, att);
    },

    attachments() {
      return [...atts.values()];
    },

    objectOf(body) {
      const root = body.parent;
      const id = (root.plugin as Record<string, unknown> | undefined)?.objectId;
      return typeof id === 'number' ? objects.get(id) : undefined;
    },

    list() {
      return [...objects.values()]; // Map order = oldest first
    },

    allBodies() {
      const out: Matter.Body[] = [];
      for (const obj of objects.values()) out.push(...obj.bodies);
      return out;
    },

    get size() {
      return objects.size;
    },

    nextId() {
      seq += 1;
      return seq;
    },
  };
}

/** Evict oldest objects beyond the cap. */
export function enforceObjectCap(
  registry: ObjectRegistry,
  world: Matter.World,
  render: Matter.Render,
): void {
  const list = registry.list();
  for (let i = 0; i < list.length - MAX_OBJECTS; i++) {
    registry.remove(world, render, list[i]);
  }
}
