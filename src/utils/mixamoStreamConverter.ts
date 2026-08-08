/**
 * Converts a Mixamo retargeted animation stream (SJSON "walking" format) into a
 * Synthia-compatible walking timeline.
 *
 * Empirical convention (verified against x-bot.glb bind + rig source):
 *   - Stream `rot` quats are per-joint LOCAL DELTA rotations in the joint's own
 *     T-pose frame. No bind-pose subtraction and no world-chain accumulation are
 *     needed: qRel = qParent⁻¹ * qChild == the stream quat by construction.
 *   - Convert the delta quat into the MuJoCo frame (threeQuatToMuJoCo) and read
 *     ZXY Euler angles (yaw=z, pitch=x, roll=y) — exactly mirroring the engine's
 *     `BodyManager.syncRigidBodiesFromBones` math and `MotorController.setTargets`
 *     LLM convention (x=pitch, y=yaw, z=roll).
 *   - Quaternion sign must be canonicalized (negate when w<0) before Euler
 *     extraction, otherwise near-identity deltas produce ±180° artifacts.
 *
 * Per-bone emit rules (from `rigConstraints.ts` / `MJCFHumanoidTemplate.ts`):
 *   - 1-DOF joints (forearm, leg, fingers, toes): pitch only, scalar.
 *   - 2-DOF joints (hand, foot): [pitch, 0, roll].
 *   - 3-DOF joints: [pitch, yaw, roll].
 *   - Head/Neck: MJCF generator swaps yaw/roll axes → swap here too.
 *   - Elbows: Synthia is positive-flexion only → emit |pitch|.
 *   - Knees: stream flexion is already negative → pass through, clamp [-2.618, 0].
 *
 * Root motion:
 *   - `Hips pos` channel is cumulative travel in Mixamo units (1 unit = 1 cm).
 *   - Convert to per-frame THREE-space deltas: x = Δpos[0] * 0.01,
 *     z = -Δpos[2] * 0.01 * forwardSign (Mixamo +Z forward vs engine -Z forward).
 *   - Loop-seam delta is zeroed so the wrap doesn't teleport the capsule.
 */

import * as THREE from 'three';
import { normalizeBoneKey } from '../types/joint';
import SYNTHIA_RIG_CONSTRAINTS from '../constants/rigConstraints';

/** A single node entry inside the stream header frame_descriptor. */
export interface MixamoDescriptorNode {
  node: string;
  ch: 'rot' | 'pos';
  offset: number;
}

/** One parsed frame of the stream. */
export interface MixamoStreamFrame {
  time: number;
  index: number;
  data: number[];
}

/** Parsed form of the line-SJSON "walking" file. */
export interface MixamoStream {
  fps: number;
  durationFrames: number;
  skeletonRoot: string;
  frameDescriptor: MixamoDescriptorNode[];
  frames: MixamoStreamFrame[];
}

/** Root-motion delta for ONE playback tick (THREE world space, meters). */
export interface RootMotionDelta {
  dx: number;
  dz: number;
}

/** Final converted artifact — the shape `useWorld`'s handlers consume. */
export interface SynthiaWalkArtifact {
  metadata: {
    name: string;
    fps: number;
    frames: number;
    source: string;
    forwardSpeedMps: number;
    notes: string[];
  };
  /** Per-frame root deltas dispatched via `synthia:rootMotion`. */
  rootMotion: RootMotionDelta[];
  /** Per-frame joint overrides dispatched via `synthia:action` (TimelineSequence). */
  sequence: Array<{ timeOffsetMs: number; overrides: Record<string, number | [number, number, number]> }>;
}

export interface ConvertOptions {
  loop?: boolean;
  /** Mixamo +Z forward → THREE z. Engine forward is -Z, so default flips. */
  forwardSign?: number;
  /** Scale applied to Mixamo units. 1 unit = 0.01 m. */
  unitScale?: number;
  /** Emit a console table per frame/bone for debugging sign/axis conventions. */
  verbose?: boolean;
}

/** Normalise a canonical bone key back to a stream-style name (no colons). */
function streamNameToCanonical(node: string): string {
  return normalizeBoneKey(node);
}

const is1Dof = (bone: string): boolean => Math.abs((SYNTHIA_RIG_CONSTRAINTS[bone]?.dof ?? 0)) === 1;
const is2Dof = (bone: string): boolean => Math.abs((SYNTHIA_RIG_CONSTRAINTS[bone]?.dof ?? 0)) === 2;

const isHeadNeck = (bone: string): boolean => bone.includes('neck') || bone.includes('head');
const isElbow = (bone: string): boolean => bone.includes('forearm');

/** Clamp an angle into [min, max]. */
function clampAngle(value: number, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return value;
  return Math.max(min, Math.min(max, value));
}

/** Wrap any angle to (-π, π]. */
function wrapPi(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Exact mirror of PhysicsEngine.threeQuatToMuJoCo. */
function threeQuatToMuJoCo(q: THREE.Quaternion): [number, number, number, number] {
  const qAlign = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const qAlignInv = qAlign.clone().invert();
  const t = qAlign.clone().multiply(q).multiply(qAlignInv);
  return [t.w, t.x, t.y, t.z];
}

/** THREE quaternion → MuJoCo-frame ZXY Euler {yaw, pitch, roll}. */
function toZxyEuler(qThree: THREE.Quaternion): { yaw: number; pitch: number; roll: number } {
  // Canonicalize quaternion sign (negate w,x,y,z) to kill ±180° Euler artifacts
  // on near-identity deltas.
  const q = qThree.w < 0
    ? new THREE.Quaternion(-qThree.x, -qThree.y, -qThree.z, -qThree.w)
    : qThree.clone();
  const mj = threeQuatToMuJoCo(q);
  const qMj = new THREE.Quaternion(mj[1], mj[2], mj[3], mj[0]);
  const euler = new THREE.Euler().setFromQuaternion(qMj, 'ZXY');
  return { yaw: wrapPi(euler.z), pitch: wrapPi(euler.x), roll: wrapPi(euler.y) };
}

/** Stream data → THREE quaternion from (x, y, z, w) data. */
function quatFromData(data: number[], offset: number): THREE.Quaternion {
  return new THREE.Quaternion(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/** Parse the line-oriented SJSON stream file text into a MixamoStream. */
export function parseMixamoStream(text: string): MixamoStream {
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const header = rows.find((line) => line.includes('"header"'));
  if (!header) throw new Error('parseMixamoStream: no header row found');
  const headerObj = JSON.parse(header);

  const frames: MixamoStreamFrame[] = rows
    .filter((line) => line.includes('"frame"') && line.includes('"data"'))
    .map((line) => JSON.parse(line));

  const descriptor: MixamoDescriptorNode[] = headerObj.frame_descriptor as MixamoDescriptorNode[];
  if (!Array.isArray(descriptor)) throw new Error('parseMixamoStream: frame_descriptor missing');

  return {
    fps: headerObj.clip?.fps ?? 30,
    durationFrames: headerObj.clip?.duration_frames ?? frames.length,
    skeletonRoot: headerObj.clip?.['skeleton-root'] ?? 'mixamorig:Hips',
    frameDescriptor: descriptor,
    frames,
  };
}

/** Build a bone→(rotOffset,posOffset) lookup from the frame descriptor. */
function buildOffsetMap(stream: MixamoStream): Map<string, { rot?: number; pos?: number }> {
  const map = new Map<string, { rot?: number; pos?: number }>();
  for (const entry of stream.frameDescriptor) {
    const canonical = streamNameToCanonical(entry.node);
    const existing = map.get(canonical) ?? {};
    if (entry.ch === 'rot') existing.rot = entry.offset;
    else if (entry.ch === 'pos') existing.pos = entry.offset;
    map.set(canonical, existing);
  }
  return map;
}

/**
 * Convert a parsed Mixamo stream into a Synthia walking timeline + root-motion deltas.
 * `activeGaitPhase: true` should be passed downstream to `validateAndApplyTimeline`.
 */
export function convertMixamoStreamToTimeline(
  stream: MixamoStream,
  options: ConvertOptions = {}
): SynthiaWalkArtifact {
  const {
    loop = true,
    forwardSign = -1,
    unitScale = 0.01,
    verbose = false,
  } = options;

  const offsets = buildOffsetMap(stream);
  const sequence: SynthiaWalkArtifact['sequence'] = [];
  const rootMotion: RootMotionDelta[] = [];
  const notes: string[] = [];

  const BONES = Array.from(offsets.keys()).filter((bone) => offsets.get(bone)?.rot !== undefined);
  const HIPS = 'mixamorighips';
  const hipsOff = offsets.get(HIPS);

  let previousZ = 0;
  let previousX = 0;
  let totalForwardUnits = 0;

  const overridesForFrame = (frame: MixamoStreamFrame): Record<string, number | [number, number, number]> => {
    const overrides: Record<string, number | [number, number, number]> = {};

    for (const bone of BONES) {
      if (bone === HIPS) continue; // root handled via rootMotion
      const entry = offsets.get(bone)!;
      if (entry.rot === undefined) continue;
      const eulers = toZxyEuler(quatFromData(frame.data, entry.rot));
      let pitch = eulers.pitch;
      let yaw = eulers.yaw;
      let roll = eulers.roll;

      // Head/Neck: MJCF generator swaps yaw↔roll axes for these bones.
      if (isHeadNeck(bone)) {
        const tmp = yaw;
        yaw = roll;
        roll = tmp;
      }

      // Elbows: Synthia is positive-flexion only.
      if (isElbow(bone)) {
        pitch = Math.abs(pitch);
      }

      const constraint = SYNTHIA_RIG_CONSTRAINTS[bone];
      const clamp = (axis: 'x' | 'y' | 'z', v: number) =>
        constraint ? clampAngle(v, constraint[axis][0], constraint[axis][1]) : v;

      // Knees: Synthia uses negative-flexion convention [-2.618, 0.0].
      // Extracted stream pitch is positive, so we negate it to represent flexion.
      if (bone === 'mixamorigleftleg' || bone === 'mixamorigrightleg') {
        pitch = -Math.abs(pitch);
      }

      if (is1Dof(bone)) {
        overrides[bone] = clamp('x', pitch);
      } else if (is2Dof(bone)) {
        overrides[bone] = [clamp('x', pitch), 0, clamp('z', roll)];
      } else {
        overrides[bone] = [clamp('x', pitch), clamp('y', yaw), clamp('z', roll)];
      }
    }

    if (verbose) {
      console.table(
        Object.fromEntries(
          Object.entries(overrides).map(([k, v]) => [k, Array.isArray(v) ? v.map((n) => +(n * (180 / Math.PI)).toFixed(1)) : +(v as number * (180 / Math.PI)).toFixed(1)])
        )
      );
    }

    return overrides;
  };

  for (let i = 0; i < stream.frames.length; i++) {
    const frame = stream.frames[i];
    const timeOffsetMs = Math.round(frame.time * 1000);

    // Root motion: cumulative pos channel → per-frame deltas.
    if (hipsOff?.pos !== undefined) {
      const posX = frame.data[hipsOff.pos];
      const posZ = frame.data[hipsOff.pos + 2];
      const isLoopSeam = loop && i === 0;
      const dx = isLoopSeam ? 0 : (posX - previousX) * unitScale;
      const dz = isLoopSeam ? 0 : (posZ - previousZ) * unitScale * forwardSign;
      previousX = posX;
      previousZ = posZ;
      totalForwardUnits += Math.abs(dz);
      rootMotion.push({ dx, dz });
    } else {
      rootMotion.push({ dx: 0, dz: 0 });
    }

    sequence.push({ timeOffsetMs, overrides: overridesForFrame(frame) });
  }

  // Loop: append a copy of frame 0 at the end of the cycle to close the loop seamlessly.
  if (loop && stream.frames.length > 0) {
    const first = stream.frames[0];
    const wraparoundMs = Math.round(first.time * 1000 + (stream.frames[stream.frames.length - 1].time - first.time + 1 / stream.fps) * 1000);
    sequence.push({ timeOffsetMs: wraparoundMs, overrides: overridesForFrame(first) });
    rootMotion.push({ dx: 0, dz: 0 }); // no teleport at loop seam
  }

  const durationS = stream.frames.length / stream.fps;
  const forwardSpeedMps = durationS > 0 ? totalForwardUnits / durationS : 0;

  return {
    metadata: {
      name: 'Mixamo Walking (converted)',
      fps: stream.fps,
      frames: stream.frames.length,
      source: 'mixamo stream → synthia timeline',
      forwardSpeedMps: +forwardSpeedMps.toFixed(3),
      notes,
    },
    rootMotion,
    sequence,
  };
}

/** One-shot helper: parse text then convert. */
export function convertWalkingStreamText(text: string, options?: ConvertOptions): SynthiaWalkArtifact {
  return convertMixamoStreamToTimeline(parseMixamoStream(text), options);
}
